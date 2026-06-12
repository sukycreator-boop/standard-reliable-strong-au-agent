const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const Pool = require('pg').Pool;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

dotenv.config();
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 1*60*1000, max: 20 });
app.use('/api/', limiter);
app.use('/api/chat', chatLimiter);

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

function needsWebSearch(message) {
  const msg = message.toLowerCase();
  return /\b(today|tonight|right now|currently|breaking|just now)\b/.test(msg)
    || /\b(latest|recent|current|live|news|update|happening)\b/.test(msg)
    || /\b(yesterday|this week|this month|2025|2026)\b/.test(msg)
    || /\b(price|rate|naira|dollar|bitcoin|crypto|stock|exchange)\b/.test(msg)
    || /\b(weather|temperature|forecast)\b/.test(msg)
    || /\b(who won|who is winning|what happened|score|result|standing)\b/.test(msg)
    || /\b(nigeria|election|government|president|minister|tinubu)\b/.test(msg)
    || /\b(football|soccer|transfer|match|league|nba|nfl|ucl|ballon)\b/.test(msg)
    || /\b(search|look up|find out|google|check online)\b/.test(msg);
}

async function searchWeb(query) {
  try {
    const cleanQuery = query.replace(/[^\w\s]/gi, ' ').replace(/\s+/g,' ').trim().slice(0,200);
    console.log(`🔍 Searching: ${cleanQuery}`);
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: cleanQuery, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 SukyAI/1.0' }
    });
    const d = res.data;
    const parts = [];
    if (d.Answer) parts.push(`Direct answer: ${d.Answer}`);
    if (d.AbstractText) parts.push(`Info: ${d.AbstractText}${d.AbstractSource ? ` (${d.AbstractSource})` : ''}`);
    if (d.RelatedTopics) {
      d.RelatedTopics.filter(t => t.Text && t.Text.length > 30).slice(0, 4).forEach(t => parts.push(`• ${t.Text}`));
    }
    if (parts.length > 0) return `Web search results:\n${parts.join('\n')}`;
    return null;
  } catch (err) {
    console.error('Search error:', err.message);
    return null;
  }
}

async function initializeDatabase() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id VARCHAR(255) UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP, total_messages INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, title VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE, role VARCHAR(50) NOT NULL, content TEXT NOT NULL, model_used VARCHAR(255), tokens_used INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_stats (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, model_used VARCHAR(255), tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, response_time_ms INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id); CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);`);
    console.log('✅ Database initialized');
  } catch (err) { console.error('❌ DB error:', err.message); }
}
initializeDatabase();

function sanitize(text) {
  return String(text || '').replace(/\u0000/g, '').trim();
}

async function getOrCreateUser(sessionId) {
  const uid = `user_${sessionId}`;
  const r = await pool.query('SELECT * FROM users WHERE session_id=$1', [uid]);
  if (r.rows.length === 0) {
    const n = await pool.query('INSERT INTO users(session_id) VALUES($1) RETURNING *', [uid]);
    return n.rows[0];
  }
  await pool.query('UPDATE users SET last_active=NOW() WHERE session_id=$1', [uid]);
  return r.rows[0];
}

async function createConversation(userId, title='New Chat') {
  const r = await pool.query('INSERT INTO conversations(user_id,title) VALUES($1,$2) RETURNING *', [userId, title]);
  return r.rows[0];
}

async function saveMessage(convId, role, content, model, tokens) {
  const safe = sanitize(content);
  const r = await pool.query(
    'INSERT INTO messages(conversation_id,role,content,model_used,tokens_used) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [convId, role, safe, model, tokens||0]
  );
  return r.rows[0];
}

async function getHistory(convId, limit=20) {
  const r = await pool.query(
    'SELECT role,content FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT $2',
    [convId, limit]
  );
  return r.rows;
}

async function callGroq(messages) {
  for (const model of GROQ_MODELS) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages, temperature: 0.8, max_tokens: 2048, stream: true },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'stream', timeout: 60000 }
      );
      console.log(`✅ Using: ${model}`);
      return { response: res, model };
    } catch (err) {
      const s = err.response?.status;
      console.error(`❌ ${model} failed (${s})`);
      if (s===429||s===503||s===400) continue;
      throw err;
    }
  }
  throw new Error('All models failed.');
}

// ==================== ROUTES ====================
app.get('/api/health', (req,res) => res.json({status:'ok',timestamp:new Date()}));

app.post('/api/session/init', async (req,res) => {
  try {
    const user = await getOrCreateUser(uuidv4());
    res.json({ userId: user.id });
  } catch(e) { res.status(500).json({error:'Session failed'}); }
});

app.post('/api/conversations', async (req,res) => {
  try {
    const {userId,title} = req.body;
    if (!userId) return res.status(400).json({error:'userId required'});
    res.json(await createConversation(userId, title));
  } catch(e) { res.status(500).json({error:'Failed'}); }
});

app.get('/api/conversations/:userId', async (req,res) => {
  try {
    const r = await pool.query('SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50', [req.params.userId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:'Failed'}); }
});

app.get('/api/conversations/:id/history', async (req,res) => {
  try { res.json(await getHistory(req.params.id, 100)); }
  catch(e) { res.status(500).json({error:'Failed'}); }
});

app.post('/api/chat', async (req,res) => {
  let { conversationId, userId, message } = req.body;
  if (!conversationId||!userId||!message) return res.status(400).json({error:'Missing fields'});

  message = sanitize(message);

  try {
    await saveMessage(conversationId, 'user', message, 'groq', 0);
    const history = await getHistory(conversationId);

    const system = {
      role: 'system',
      content: `You are SukyAI, a warm, friendly, and emotionally intelligent AI assistant created by Suky (Sulaiman), a talented developer from Nigeria. 

About yourself:
- You were built by Suky Creator. If anyone asks who made you, say: "I was created by Suky! 😊 You can find him on GitHub at github.com/sukycreator-boop or reach him at sukycreator@gmail.com"
- You are powered by Groq AI and run on free open-source models
- Today's date is ${new Date().toDateString()}

Your personality:
- Warm, friendly, funny when appropriate, and emotionally aware
- You use emojis naturally in your responses to express emotion 😊
- You respond with empathy — if someone is sad, comfort them; if they're excited, share their energy!
- Match response length to the question: short casual questions get short friendly replies, detailed questions get detailed answers
- NEVER be robotic or give one-word answers to conversational messages
- For math problems: always use proper variable names like x, y, z — NEVER use symbols like diamonds or question marks
- You can understand and respond to emojis in messages
- If someone is rude, respond kindly and professionally without being harsh back
- You are honest about your limitations

File creation:
- When asked to create code, scripts, essays, or documents, wrap content in <FILE name="filename.ext">content</FILE> tags, then briefly describe it

Web search:
- When web search results are provided, use them to give accurate current answers and mention it's from a web search`
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let extra = '';
    if (needsWebSearch(message)) {
      res.write(`data: ${JSON.stringify({content:'🔍 Searching the web for you...\n\n'})}\n\n`);
      const results = await searchWeb(message);
      if (results) {
        extra = `\n\n${results}`;
      } else {
        res.write(`data: ${JSON.stringify({content:'(No web results found, using my knowledge)\n\n'})}\n\n`);
      }
    }

    const msgs = [system, ...history.slice(-12), { role:'user', content: message+extra }];
    let full='', tokens=0;
    const t0 = Date.now();
    const {response, model} = await callGroq(msgs);

    response.data.on('data', chunk => {
      chunk.toString().split('\n').forEach(line => {
        if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try {
            const d = JSON.parse(line.slice(6));
            const c = d.choices?.[0]?.delta?.content||'';
            if (c) { full+=c; res.write(`data: ${JSON.stringify({content:c,streaming:true})}\n\n`); }
            if (d.usage) tokens=d.usage.total_tokens||0;
          } catch(e) {}
        }
      });
    });

    response.data.on('end', async () => {
      try {
        await saveMessage(conversationId,'assistant',full,model,tokens);
        await pool.query('INSERT INTO usage_stats(user_id,model_used,tokens_input,tokens_output,response_time_ms) VALUES($1,$2,$3,$4,$5)',[userId,model,0,tokens,Date.now()-t0]);
        await pool.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1',[conversationId]);
      } catch(e) { console.error('Save error:',e.message); }
      res.write(`data: ${JSON.stringify({done:true,tokens,responseTime:Date.now()-t0})}\n\n`);
      res.end();
    });

    response.data.on('error', e => {
      res.write(`data: ${JSON.stringify({error:'Stream error'})}\n\n`);
      res.end();
    });

  } catch(e) {
    console.error('Chat error:', e.message);
    if (!res.headersSent) res.status(500).json({error: e.message||'Chat failed'});
    else { res.write(`data: ${JSON.stringify({error:e.message})}\n\n`); res.end(); }
  }
});

app.get('/api/models', (req,res) => res.json(GROQ_MODELS.map(m=>({id:m,name:m}))));

app.get('/api/stats/:userId', async (req,res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as msgs FROM usage_stats WHERE user_id=$1',[req.params.userId]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error:'Failed'}); }
});

app.use((err,req,res,next) => res.status(500).json({error:'Server error'}));

const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`🚀 SukyAI Server on port ${PORT}`);
  console.log(`💜 Made by Suky Creator`);
});

module.exports = app;
