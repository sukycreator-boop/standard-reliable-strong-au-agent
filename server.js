const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const Pool = require('pg').Pool;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

dotenv.config();

const app = express();

// ==================== DATABASE SETUP ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: false,
});

app.use('/api/', limiter);
app.use('/api/chat', chatLimiter);

// ==================== FREE MODELS (no credits needed) ====================
const FREE_MODELS = [
  'meta-llama/llama-4-scout:free',
  'meta-llama/llama-4-maverick:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free',
  'qwen/qwen3-coder:free',
  'mistralai/mistral-7b-instruct:free',
];

// Always use a free model — strip :free suffix if present then re-add
// or fall back to first free model if unknown model sent
function resolveFreeModel(requestedModel) {
  if (!requestedModel || requestedModel === 'openrouter/auto') {
    return FREE_MODELS[0];
  }
  // If already a :free model, use as-is
  if (requestedModel.endsWith(':free')) {
    return requestedModel;
  }
  // Try to find matching free version
  const base = requestedModel.split(':')[0];
  const match = FREE_MODELS.find(m => m.startsWith(base));
  return match || FREE_MODELS[0];
}

// ==================== INITIALIZE DATABASE ====================
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_messages INTEGER DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        model_used VARCHAR(255),
        tokens_used INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS usage_stats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        model_used VARCHAR(255),
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        response_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_usage_stats_user_id ON usage_stats(user_id);
    `);

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

initializeDatabase();

// ==================== HELPER FUNCTIONS ====================
async function getOrCreateUser(sessionId) {
  const userId = `user_${sessionId}`;
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE session_id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      const newUser = await pool.query(
        'INSERT INTO users (session_id) VALUES ($1) RETURNING *',
        [userId]
      );
      return newUser.rows[0];
    }
    await pool.query(
      'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE session_id = $1',
      [userId]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Error managing user:', err);
    throw err;
  }
}

async function createConversation(userId, title = 'New Chat') {
  try {
    const result = await pool.query(
      'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *',
      [userId, title]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Error creating conversation:', err);
    throw err;
  }
}

async function saveMessage(conversationId, role, content, model, tokens) {
  try {
    const result = await pool.query(
      'INSERT INTO messages (conversation_id, role, content, model_used, tokens_used) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [conversationId, role, content, model, tokens || 0]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Error saving message:', err);
    throw err;
  }
}

async function getConversationHistory(conversationId, limit = 20) {
  try {
    const result = await pool.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2',
      [conversationId, limit]
    );
    return result.rows;
  } catch (err) {
    console.error('Error fetching conversation history:', err);
    throw err;
  }
}

// Retry with model fallback — tries each free model until one works
async function callOpenRouterWithRetry(payload, maxRetries = 3) {
  const modelsToTry = [payload.model, ...FREE_MODELS.filter(m => m !== payload.model)];

  for (const model of modelsToTry) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        console.log(`🤖 Trying model: ${model}`);
        return await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          { ...payload, model },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
              'X-Title': 'AI Agent Chat',
            },
            responseType: 'stream',
            timeout: 60000,
          }
        );
      } catch (err) {
        const status = err.response?.status;
        console.error(`❌ Model ${model} failed (${status}): ${err.message}`);
        // 402 = no credits, 429 = rate limit, 503 = unavailable — try next model
        if (status === 402 || status === 503 || status === 429) {
          break; // try next model
        }
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
      }
    }
  }
  throw new Error('All models failed. Please try again later.');
}

// ==================== API ENDPOINTS ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.post('/api/session/init', async (req, res) => {
  try {
    const sessionId = uuidv4();
    const user = await getOrCreateUser(sessionId);
    res.json({ sessionId, userId: user.id });
  } catch (err) {
    console.error('Session init error:', err);
    res.status(500).json({ error: 'Failed to initialize session' });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const { userId, title } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const conversation = await createConversation(userId, title);
    res.json(conversation);
  } catch (err) {
    console.error('Conversation creation error:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

app.get('/api/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.get('/api/conversations/:conversationId/history', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const messages = await getConversationHistory(conversationId, 100);
    res.json(messages);
  } catch (err) {
    console.error('Fetch history error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Chat with streaming
app.post('/api/chat', async (req, res) => {
  const { conversationId, userId, message, model } = req.body;

  if (!conversationId || !userId || !message) {
    return res.status(400).json({ error: 'Missing required fields: conversationId, userId, message' });
  }

  // Always resolve to a free model
  const resolvedModel = resolveFreeModel(model);
  console.log(`💬 Chat request — model: ${resolvedModel}`);

  try {
    await saveMessage(conversationId, 'user', message, resolvedModel, 0);
    const history = await getConversationHistory(conversationId);
    const messages = [...history, { role: 'user', content: message }];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullResponse = '';
    let totalTokens = 0;
    const startTime = Date.now();

    try {
      const response = await callOpenRouterWithRetry({
        model: resolvedModel,
        messages,
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 2000,
      });

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        lines.forEach((line) => {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content || '';
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content, streaming: true })}\n\n`);
              }
              if (data.usage) {
                totalTokens = data.usage.total_tokens || 0;
              }
            } catch (e) {}
          }
        });
      });

      response.data.on('end', async () => {
        const responseTime = Date.now() - startTime;
        try {
          await saveMessage(conversationId, 'assistant', fullResponse, resolvedModel, totalTokens);
          await pool.query(
            'INSERT INTO usage_stats (user_id, model_used, tokens_input, tokens_output, response_time_ms) VALUES ($1, $2, $3, $4, $5)',
            [userId, resolvedModel, 0, totalTokens, responseTime]
          );
          await pool.query(
            'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [conversationId]
          );
        } catch (err) {
          console.error('Error saving message:', err);
        }
        res.write(`data: ${JSON.stringify({ done: true, totalTokens, responseTime })}\n\n`);
        res.end();
      });

      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.write(`data: ${JSON.stringify({ error: 'Stream error occurred' })}\n\n`);
        res.end();
      });

    } catch (err) {
      console.error('OpenRouter API error:', err.message);
      const errorMessage = err.message || 'API error';
      res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      res.end();
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// Get available models (all free)
app.get('/api/models', (req, res) => {
  const models = [
    { id: 'meta-llama/llama-4-scout:free', name: 'Llama 4 Scout', description: 'Fast & free — great for chat' },
    { id: 'meta-llama/llama-4-maverick:free', name: 'Llama 4 Maverick', description: 'Powerful free model with vision' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', description: 'Strong reasoning, completely free' },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1', description: 'Excellent reasoning & coding' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', description: 'Best free coding model' },
    { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B', description: 'Lightweight & fast' },
  ];
  res.json(models);
});

app.get('/api/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as total_messages,
        COALESCE(SUM(tokens_input), 0) as total_input_tokens,
        COALESCE(SUM(tokens_output), 0) as total_output_tokens,
        COALESCE(ROUND(AVG(response_time_ms)), 0) as avg_response_time_ms,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM usage_stats WHERE user_id = $1`,
      [userId]
    );
    res.json(stats.rows[0] || {
      total_messages: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      avg_response_time_ms: 0,
      active_days: 0
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM conversations) as total_conversations,
        (SELECT COUNT(*) FROM messages) as total_messages,
        (SELECT COUNT(DISTINCT user_id) FROM usage_stats WHERE created_at > NOW() - INTERVAL '24 hours') as active_users_24h,
        (SELECT COALESCE(SUM(tokens_output), 0) FROM usage_stats WHERE created_at > NOW() - INTERVAL '24 hours') as tokens_used_24h
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AI Agent Server running on port ${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api`);
  console.log(`💬 Chat endpoint: POST /api/chat`);
  console.log(`📈 Stats endpoint: GET /api/stats/:userId`);
  console.log(`⚙️  Admin stats: GET /api/admin/stats`);
  console.log(`🆓 Free models: ${FREE_MODELS.join(', ')}`);
});

module.exports = app;
