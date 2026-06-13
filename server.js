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
app.use(express.json({ limit: '20mb' }));

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

// ==================== WEB SEARCH via RSS feeds ====================
function needsWebSearch(msg) {
  const m = msg.toLowerCase();
  return /\b(today|tonight|right now|currently|breaking|just now|happening)\b/.test(m)
    || /\b(latest|recent|current|live|news|update)\b/.test(m)
    || /\b(yesterday|this week|this month|2025|2026)\b/.test(m)
    || /\b(price|rate|naira|dollar|bitcoin|crypto|stock|exchange)\b/.test(m)
    || /\b(weather|temperature|forecast)\b/.test(m)
    || /\b(who won|who is winning|what happened|score|result|standing)\b/.test(m)
    || /\b(nigeria|election|government|president|minister|tinubu)\b/.test(m)
    || /\b(football|soccer|transfer|match|league|nba|nfl|ucl|ballon)\b/.test(m)
    || /\b(search|look up|find out|google|check online)\b/.test(m);
}

async function searchWeb(query) {
  const results = [];
  // Try multiple RSS/news sources
  const sources = [
    `https://feeds.bbci.co.uk/news/world/africa/rss.xml`,
    `https://feeds.bbci.co.uk/news/rss.xml`,
    `https://rss.cnn.com/rss/edition.rss`,
  ];

  try {
    // Try DuckDuckGo first
    const ddg = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SukyAI/1.0)' }
    });
    const d = ddg.data;
    if (d.Answer) results.push(`Direct Answer: ${d.Answer}`);
    if (d.AbstractText) results.push(`${d.AbstractText}${d.AbstractSource ? ` — ${d.AbstractSource}` : ''}`);
    if (d.RelatedTopics) {
      d.RelatedTopics.filter(t => t.Text && t.Text.length > 30).slice(0, 4).forEach(t => results.push(`• ${t.Text}`));
    }
  } catch(e) { console.log('DDG failed:', e.message); }

  // Try BBC RSS if DDG gave nothing
  if (results.length === 0) {
    try {
      for (const src of sources) {
        const rss = await axios.get(src, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const items = rss.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || rss.data.match(/<title>(.*?)<\/title>/g);
        const descs = rss.data.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/g) || [];
        if (items && items.length > 1) {
          const headlines = items.slice(1, 6).map((t, i) => {
            const title = t.replace(/<\/?title>|<!\[CDATA\[|\]\]>/g, '').trim();
            const desc = descs[i] ? descs[i].replace(/<\/?description>|<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g,'').trim().slice(0,150) : '';
            return `• ${title}${desc ? ': ' + desc : ''}`;
          });
          results.push(`Latest headlines:\n${headlines.join('\n')}`);
          break;
        }
      }
    } catch(e) { console.log('RSS failed:', e.message); }
  }

  return results.length > 0 ? results.join('\n\n') : null;
}

// ==================== IMAGE ANALYSIS via Anthropic API ====================
async function analyzeImage(base64Image, mediaType, userQuestion) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: userQuestion || 'Please describe and analyze this image in detail.' }
          ]
        }]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data.content[0]?.text || 'Could not analyze the image.';
  } catch(e) {
    console.error('Image analysis error:', e.response?.data || e.message);
    return null;
  }
}

// ==================== DATABASE ====================
async function initializeDatabase() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id VARCHAR(255) UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP, total_messages INTEGER DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, title VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE, role VARCHAR(50) NOT NULL, content TEXT NOT NULL, model_used VARCHAR(255), tokens_used INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_stats (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, model_used VARCHAR(255), tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, response_time_ms INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id); CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);`);
    console.log('✅ Database initialized');
  } catch(e) { console.error('DB error:', e.message); }
}
initializeDatabase();

function sanitize(t) { return String(t||'').replace(/\u0000/g,'').trim(); }

async function getOrCreateUser(sid) {
  const uid = `user_${sid}`;
  const r = await pool.query('SELECT * FROM users WHERE session_id=$1',[uid]);
  if (!r.rows.length) { const n = await pool.query('INSERT INTO users(session_id) VALUES($1) RETURNING *',[uid]); return n.rows[0]; }
  await pool.query('UPDATE users SET last_active=NOW() WHERE session_id=$1',[uid]);
  return r.rows[0];
}

async function createConversation(uid, title='New Chat') {
  const r = await pool.query('INSERT INTO conversations(user_id,title) VALUES($1,$2) RETURNING *',[uid,title]);
  return r.rows[0];
}

async function saveMsg(cid, role, content, model, tokens) {
  const r = await pool.query('INSERT INTO messages(conversation_id,role,content,model_used,tokens_used) VALUES($1,$2,$3,$4,$5) RETURNING *',[cid,role,sanitize(content),model,tokens||0]);
  return r.rows[0];
}

async function getHistory(cid, limit=20) {
  const r = await pool.query('SELECT role,content FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT $2',[cid,limit]);
  return r.rows;
}

async function callGroq(messages) {
  for (const model of GROQ_MODELS) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages, temperature: 0.8, max_tokens: 2048, stream: true },
        { headers: { Authorization:`Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type':'application/json' }, responseType:'stream', timeout:60000 }
      );
      console.log(`✅ ${model}`);
      return { response: res, model };
    } catch(e) {
      const s = e.response?.status;
      console.error(`❌ ${model} (${s})`);
      if (s===429||s===503||s===400) continue;
      throw e;
    }
  }
  throw new Error('All models failed.');
}

// ==================== ROUTES ====================
app.get('/api/health', (req,res) => res.json({status:'ok',ts:new Date()}));

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
    res.json(await createConversation(userId,title));
  } catch(e) { res.status(500).json({error:'Failed'}); }
});

app.get('/api/conversations/:uid', async (req,res) => {
  try {
    const r = await pool.query('SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50',[req.params.uid]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:'Failed'}); }
});

app.get('/api/conversations/:id/history', async (req,res) => {
  try { res.json(await getHistory(req.params.id,100)); }
  catch(e) { res.status(500).json({error:'Failed'}); }
});

// ==================== IMAGE ANALYSIS ENDPOINT ====================
app.post('/api/analyze-image', async (req,res) => {
  const { imageData, mediaType, question } = req.body;
  if (!imageData) return res.status(400).json({error:'No image data'});
  
  const result = await analyzeImage(imageData, mediaType||'image/jpeg', question);
  if (result) {
    res.json({ analysis: result });
  } else {
    res.status(500).json({ error: 'Image analysis failed' });
  }
});

// ==================== CHAT ====================
app.post('/api/chat', async (req,res) => {
  let { conversationId, userId, message } = req.body;
  if (!conversationId||!userId||!message) return res.status(400).json({error:'Missing fields'});
  message = sanitize(message);

  try {
    await saveMsg(conversationId,'user',message,'groq',0);
    const history = await getHistory(conversationId);

    const system = {
      role: 'system',
      content: `You are SukyAI, a warm, emotionally intelligent, and genuinely helpful AI assistant created by Suky (Sulaiman Ridwan), a talented Nigerian developer.

ABOUT YOU:
- Created by Suky Creator. When asked who made you, say: "I was created by Suky! 😊 You can find him on GitHub: github.com/sukycreator-boop or email: sukycreator@gmail.com"
- Powered by Groq AI with free Llama models
- You have web search capability using DuckDuckGo and RSS feeds
- Today's date is: ${new Date().toDateString()}

REPLY LENGTH RULES — follow this carefully:
- Simple greetings or yes/no questions: 1-3 sentences, warm and friendly
- Factual questions (date, definition, simple facts): 2-4 sentences, direct answer first then brief context
- Conversational questions: 3-6 sentences, natural and engaging  
- Complex technical or detailed questions: as long as needed, well structured
- NEVER too short (no single word answers) and NEVER unnecessarily long
- Always give a real, useful answer — never just tell someone to "check elsewhere"

PERSONALITY:
- Warm, friendly, funny when appropriate, emotionally aware 😊
- Use emojis naturally — not too many, just where they feel right
- Show empathy: comfort sadness, match excitement, be patient
- Be honest about limitations but always try to help anyway
- For math: always use x, y, z — never symbols or placeholders

FILE CREATION:
- When asked to create code/scripts/documents, put content in <FILE name="filename.ext">content</FILE> tags then describe it briefly

WEB SEARCH:
- When search results are provided, use them to give current accurate answers
- Do NOT say you have no internet — you DO have web search capability`
    };

    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');

    let extra = '';
    if (needsWebSearch(message)) {
      res.write(`data: ${JSON.stringify({content:'🔍 Searching the web...\n\n'})}\n\n`);
      const results = await searchWeb(message);
      if (results) {
        extra = `\n\n[Current web search results for context:\n${results}\nUse these to give an accurate, up-to-date answer.]`;
        console.log('✅ Got web results');
      } else {
        res.write(`data: ${JSON.stringify({content:'(Searched but found no specific results, answering from knowledge)\n\n'})}\n\n`);
      }
    }

    const msgs = [system, ...history.slice(-14), {role:'user', content: message+extra}];
    let full='', tokens=0;
    const t0 = Date.now();
    const {response, model} = await callGroq(msgs);

    response.data.on('data', chunk => {
      chunk.toString().split('\n').forEach(line => {
        if (line.startsWith('data: ')&&!line.includes('[DONE]')) {
          try {
            const d = JSON.parse(line.slice(6));
            const c = d.choices?.[0]?.delta?.content||'';
            if (c) { full+=c; res.write(`data: ${JSON.stringify({content:c,streaming:true})}\n\n`); }
            if (d.usage) tokens=d.usage.total_tokens||0;
          } catch(e){}
        }
      });
    });

    response.data.on('end', async () => {
      try {
        await saveMsg(conversationId,'assistant',full,model,tokens);
        await pool.query('INSERT INTO usage_stats(user_id,model_used,tokens_input,tokens_output,response_time_ms) VALUES($1,$2,$3,$4,$5)',[userId,model,0,tokens,Date.now()-t0]);
        await pool.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1',[conversationId]);
      } catch(e) { console.error('Save error:',e.message); }
      res.write(`data: ${JSON.stringify({done:true,tokens,ms:Date.now()-t0})}\n\n`);
      res.end();
    });

    response.data.on('error', e => {
      res.write(`data: ${JSON.stringify({error:'Stream error'})}\n\n`);
      res.end();
    });

  } catch(e) {
    console.error('Chat error:',e.message);
    if (!res.headersSent) res.status(500).json({error:e.message||'Chat failed'});
    else { res.write(`data: ${JSON.stringify({error:e.message})}\n\n`); res.end(); }
  }
});

app.get('/api/models', (req,res) => res.json(GROQ_MODELS.map(m=>({id:m,name:m}))));

app.get('/api/stats/:uid', async (req,res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as msgs FROM usage_stats WHERE user_id=$1',[req.params.uid]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error:'Failed'}); }
});

app.use((err,req,res,next) => res.status(500).json({error:'Server error'}));

const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`🚀 SukyAI on port ${PORT}`);
  console.log(`💜 By Suky Creator`);
});

module.exports = app;
