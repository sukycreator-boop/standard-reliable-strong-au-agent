const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const Pool = require('pg').Pool;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

dotenv.config();
const app = express();

// ==================== DATABASE ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 1*60*1000, max: 20 });
app.use('/api/', limiter);
app.use('/api/chat', chatLimiter);

// ==================== GROQ MODELS ====================
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

// ==================== WEB SEARCH (DuckDuckGo - Free, no key) ====================
function needsWebSearch(message) {
  const msg = message.toLowerCase();
  const patterns = [
    /\b(today|tonight|right now|currently|at the moment|this moment)\b/,
    /\b(latest|recent|new|current|live|breaking|update|news)\b/,
    /\b(yesterday|this week|this month|this year|2024|2025|2026)\b/,
    /\b(price|cost|rate|score|result|winner|standing)\b/,
    /\b(weather|forecast|temperature)\b/,
    /\b(who is|who are|who won|who leads|who's)\b/,
    /\b(what happened|what's happening|what is happening)\b/,
    /\b(nigeria|naira|dollar|bitcoin|crypto|stock|market)\b/,
    /\b(match|game|league|transfer|football|soccer|nba|nfl)\b/,
    /\b(election|president|government|minister|policy)\b/,
    /\b(search|look up|find out|check|google)\b/,
  ];
  return patterns.some(p => p.test(msg));
}

async function searchWeb(query) {
  try {
    console.log(`🔍 Searching web for: ${query}`);
    
    // DuckDuckGo Instant Answer API (free, no key)
    const ddgRes = await axios.get('https://api.duckduckgo.com/', {
      params: {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1,
        t: 'SukyAI'
      },
      timeout: 8000
    });

    const data = ddgRes.data;
    let results = [];

    // Abstract (main answer)
    if (data.AbstractText) {
      results.push(`📌 ${data.AbstractText}`);
    }

    // Answer (direct short answer)
    if (data.Answer) {
      results.push(`✅ ${data.Answer}`);
    }

    // Related topics
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      const topics = data.RelatedTopics
        .filter(t => t.Text)
        .slice(0, 4)
        .map(t => `• ${t.Text}`);
      if (topics.length > 0) results.push(...topics);
    }

    // If DuckDuckGo gave nothing useful, try news search
    if (results.length === 0) {
      const newsRes = await axios.get('https://api.duckduckgo.com/', {
        params: {
          q: `${query} news`,
          format: 'json',
          no_html: 1,
          t: 'SukyAI'
        },
        timeout: 8000
      });
      const nd = newsRes.data;
      if (nd.AbstractText) results.push(`📌 ${nd.AbstractText}`);
      if (nd.Answer) results.push(`✅ ${nd.Answer}`);
      if (nd.RelatedTopics) {
        nd.RelatedTopics.filter(t=>t.Text).slice(0,3).forEach(t => results.push(`• ${t.Text}`));
      }
    }

    if (results.length > 0) {
      return `🌐 Web search results for "${query}":\n\n${results.join('\n\n')}`;
    }

    return null;
  } catch (err) {
    console.error('Web search error:', err.message);
    return null;
  }
}

// ==================== DATABASE SETUP ====================
async function initializeDatabase() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id VARCHAR(255) UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP, total_messages INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, title VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE, role VARCHAR(50) NOT NULL, content TEXT NOT NULL, model_used VARCHAR(255), tokens_used INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_stats (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, model_used VARCHAR(255), tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, response_time_ms INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id); CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);`);
    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}
initializeDatabase();

// ==================== HELPERS ====================
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
  } catch (err) { console.error('Error managing user:', err); throw err; }
}

async function createConversation(userId, title = 'New Chat') {
  const result = await pool.query('INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *', [userId, title]);
  return result.rows[0];
}

async function saveMessage(conversationId, role, content, model, tokens) {
  const result = await pool.query(
    'INSERT INTO messages (conversation_id, role, content, model_used, tokens_used) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [conversationId, role, content, model, tokens || 0]
  );
  return result.rows[0];
}

async function getConversationHistory(conversationId, limit = 20) {
  const result = await pool.query(
    'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2',
    [conversationId, limit]
  );
  return result.rows;
}

// Groq API with model fallback
async function callGroqWithFallback(messages) {
  for (const model of GROQ_MODELS) {
    try {
      console.log(`🤖 Trying model: ${model}`);
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages, temperature: 0.7, max_tokens: 2000, stream: true },
        {
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 60000,
        }
      );
      console.log(`✅ Using model: ${model}`);
      return { response, model };
    } catch (err) {
      const status = err.response?.status;
      console.error(`❌ Model ${model} failed (${status})`);
      if (status === 429 || status === 503 || status === 400) continue;
      throw err;
    }
  }
  throw new Error('All models failed. Please try again.');
}

// ==================== ENDPOINTS ====================

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

app.post('/api/session/init', async (req, res) => {
  try {
    const sessionId = uuidv4();
    const user = await getOrCreateUser(sessionId);
    res.json({ sessionId, userId: user.id });
  } catch (err) { res.status(500).json({ error: 'Failed to initialize session' }); }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const { userId, title } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const conversation = await createConversation(userId, title);
    res.json(conversation);
  } catch (err) { res.status(500).json({ error: 'Failed to create conversation' }); }
});

app.get('/api/conversations/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch conversations' }); }
});

app.get('/api/conversations/:conversationId/history', async (req, res) => {
  try {
    const messages = await getConversationHistory(req.params.conversationId, 100);
    res.json(messages);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

// ==================== CHAT WITH WEB SEARCH ====================
app.post('/api/chat', async (req, res) => {
  const { conversationId, userId, message } = req.body;
  if (!conversationId || !userId || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await saveMessage(conversationId, 'user', message, 'groq', 0);
    const history = await getConversationHistory(conversationId);

    // System prompt
    const systemPrompt = {
      role: 'system',
      content: `You are SukyAI, a helpful AI assistant. Rules:
1. Match reply length to the question. Short question = short answer. Long question = detailed answer. Never pad or add filler.
2. When asked to create a file (code, script, document, essay), wrap ONLY the file content in <FILE name="filename.ext">content</FILE> tags, then add a one-line description.
3. Be direct and concise. No unnecessary disclaimers.
4. If web search results are provided, use them to answer accurately with current information. Mention the source is from a web search.
5. Today's date is ${new Date().toDateString()}.`
    };

    // Check if web search needed
    let webContext = '';
    if (needsWebSearch(message)) {
      console.log('🌐 Web search triggered');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // Send searching indicator
      res.write(`data: ${JSON.stringify({ content: '🔍 Searching the web...\n\n', streaming: true })}\n\n`);
      
      const searchResults = await searchWeb(message);
      if (searchResults) {
        webContext = `\n\nCurrent web search results:\n${searchResults}\n\nUse these results to answer the user's question accurately.`;
        console.log('✅ Web results found');
      } else {
        res.write(`data: ${JSON.stringify({ content: '⚠️ Web search returned no results. Answering from training data.\n\n', streaming: true })}\n\n`);
        console.log('⚠️ No web results found');
      }
    } else {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }

    const userMessageWithContext = webContext ? message + webContext : message;
    const messages = [
      systemPrompt,
      ...history.slice(-10), // last 10 messages for context
      { role: 'user', content: userMessageWithContext }
    ];

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
      } catch (err) { console.error('Error saving:', err); }
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
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Chat failed' });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
  }
});

app.get('/api/models', (req, res) => {
  res.json([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', description: 'Best' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', description: 'Fastest' },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', description: 'Reasoning' },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B', description: 'Google' },
  ]);
});

app.get('/api/stats/:userId', async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT COUNT(*) as total_messages, COALESCE(SUM(tokens_output),0) as total_output_tokens, COALESCE(ROUND(AVG(response_time_ms)),0) as avg_response_time_ms FROM usage_stats WHERE user_id = $1`,
      [req.params.userId]
    );
    res.json(stats.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await pool.query(`SELECT (SELECT COUNT(*) FROM users) as total_users, (SELECT COUNT(*) FROM conversations) as total_conversations, (SELECT COUNT(*) FROM messages) as total_messages`);
    res.json(stats.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SukyAI Server running on port ${PORT}`);
  console.log(`🌐 Web search: DuckDuckGo (free, no key)`);
  console.log(`🆓 Powered by Groq - Free & Fast!`);
});

module.exports = app;
