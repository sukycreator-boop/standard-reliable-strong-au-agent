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

// ==================== GROQ FREE MODELS ====================
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

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
    const result = await pool.query('SELECT * FROM users WHERE session_id = $1', [userId]);
    if (result.rows.length === 0) {
      const newUser = await pool.query('INSERT INTO users (session_id) VALUES ($1) RETURNING *', [userId]);
      return newUser.rows[0];
    }
    await pool.query('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE session_id = $1', [userId]);
    return result.rows[0];
  } catch (err) {
    console.error('Error managing user:', err);
    throw err;
  }
}

async function createConversation(userId, title = 'New Chat') {
  try {
    const result = await pool.query('INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *', [userId, title]);
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

// Call Groq API with model fallback
async function callGroqWithFallback(messages) {
  for (const model of GROQ_MODELS) {
    try {
      console.log(`🤖 Trying Groq model: ${model}`);
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages, temperature: 0.7, max_tokens: 2000, stream: true },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 60000,
        }
      );
      console.log(`✅ Using model: ${model}`);
      return { response, model };
    } catch (err) {
      const status = err.response?.status;
      console.error(`❌ Model ${model} failed (${status}): ${err.message}`);
      if (status === 429 || status === 503 || status === 400) continue;
      throw err;
    }
  }
  throw new Error('All Groq models failed. Please try again later.');
}

// ==================== API ENDPOINTS ====================

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

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
    if (!userId) return res.status(400).json({ error: 'userId is required' });
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
    const result = await pool.query('SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50', [userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.get('/api/conversations/:conversationId/history', async (req, res) => {
  try {
    const messages = await getConversationHistory(req.params.conversationId, 100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Chat with streaming via Groq
app.post('/api/chat', async (req, res) => {
  const { conversationId, userId, message } = req.body;
  if (!conversationId || !userId || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await saveMessage(conversationId, 'user', message, 'groq', 0);
    const history = await getConversationHistory(conversationId);
    const messages = [...history, { role: 'user', content: message }];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullResponse = '';
    let totalTokens = 0;
    const startTime = Date.now();

    const { response, model } = await callGroqWithFallback(messages);

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
            if (data.usage) totalTokens = data.usage.total_tokens || 0;
          } catch (e) {}
        }
      });
    });

    response.data.on('end', async () => {
      const responseTime = Date.now() - startTime;
      try {
        await saveMessage(conversationId, 'assistant', fullResponse, model, totalTokens);
        await pool.query(
          'INSERT INTO usage_stats (user_id, model_used, tokens_input, tokens_output, response_time_ms) VALUES ($1, $2, $3, $4, $5)',
          [userId, model, 0, totalTokens, responseTime]
        );
        await pool.query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [conversationId]);
      } catch (err) {
        console.error('Error saving message:', err);
      }
      res.write(`data: ${JSON.stringify({ done: true, totalTokens, responseTime })}\n\n`);
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('Stream error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error('Chat error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Chat failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

app.get('/api/models', (req, res) => {
  res.json([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', description: 'Fast & powerful' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', description: 'Ultra fast' },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', description: 'Great reasoning' },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B', description: "Google's free model" },
  ]);
});

app.get('/api/stats/:userId', async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT COUNT(*) as total_messages, COALESCE(SUM(tokens_input),0) as total_input_tokens,
       COALESCE(SUM(tokens_output),0) as total_output_tokens,
       COALESCE(ROUND(AVG(response_time_ms)),0) as avg_response_time_ms,
       COUNT(DISTINCT DATE(created_at)) as active_days
       FROM usage_stats WHERE user_id = $1`,
      [req.params.userId]
    );
    res.json(stats.rows[0]);
  } catch (err) {
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
        (SELECT COALESCE(SUM(tokens_output),0) FROM usage_stats WHERE created_at > NOW() - INTERVAL '24 hours') as tokens_used_24h
    `);
    res.json(stats.rows[0]);
  } catch (err) {
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
  console.log(`🆓 Powered by Groq - Free & Fast!`);
});

module.exports = app;
