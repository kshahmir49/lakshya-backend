const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('./pipeline');

const app = express();
app.use(cors());
app.use(express.json());

// Local data dir as cache
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─────────────────────────────────────────────
// FIRESTORE REST API
// ─────────────────────────────────────────────

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

async function firestoreSet(collection, docId, data) {
  try {
    const fields = {};
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string') fields[key] = { stringValue: val };
      else if (typeof val === 'number') fields[key] = { integerValue: val };
      else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
      else if (val === null) fields[key] = { nullValue: null };
      else fields[key] = { stringValue: JSON.stringify(val) };
    }
    const url = `${FIRESTORE_BASE}/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    console.error('Firestore set error:', err.message);
  }
}

async function firestoreGet(collection, docId) {
  try {
    const url = `${FIRESTORE_BASE}/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url);
    const doc = await res.json();
    if (!doc.fields) return null;
    const obj = {};
    for (const [key, val] of Object.entries(doc.fields)) {
      const raw = val.stringValue ?? val.integerValue ?? val.booleanValue ?? null;
      // Try to parse JSON strings (arrays/objects stored as strings)
      if (typeof raw === 'string') {
        try { obj[key] = JSON.parse(raw); } catch { obj[key] = raw; }
      } else {
        obj[key] = raw;
      }
    }
    return obj;
  } catch (err) {
    console.error('Firestore get error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().split('T')[0];
}

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

// Get articles — from local cache first, then Firestore
async function getArticles(date) {
  const localPath = path.join(DATA_DIR, `articles_${date}.json`);
  if (fs.existsSync(localPath)) return readJSON(localPath);
  // Fetch from Firestore
  const doc = await firestoreGet('daily_data', `articles_${date}`);
  if (doc?.articles) {
    // Cache locally
    fs.writeFileSync(localPath, JSON.stringify(doc.articles));
    return doc.articles;
  }
  return null;
}

async function getQuizzes(date) {
  const localPath = path.join(DATA_DIR, `quizzes_${date}.json`);
  if (fs.existsSync(localPath)) return readJSON(localPath);
  const doc = await firestoreGet('daily_data', `quizzes_${date}`);
  if (doc?.quizzes) {
    fs.writeFileSync(localPath, JSON.stringify(doc.quizzes));
    return doc.quizzes;
  }
  return null;
}

async function getDigest(date) {
  const localPath = path.join(DATA_DIR, `digest_${date}.json`);
  if (fs.existsSync(localPath)) return readJSON(localPath);
  const doc = await firestoreGet('daily_data', `digest_${date}`);
  if (doc?.articles) {
    fs.writeFileSync(localPath, JSON.stringify({ date, articles: doc.articles }));
    return { date, articles: doc.articles };
  }
  return null;
}

// Save to both local and Firestore
async function saveToFirestore(date, articles, quizzes, digest) {
  console.log('Saving to Firestore...');
  await Promise.all([
    firestoreSet('daily_data', `articles_${date}`, { articles: JSON.stringify(articles), date, count: articles.length }),
    firestoreSet('daily_data', `quizzes_${date}`, { quizzes: JSON.stringify(quizzes), date, count: quizzes.length }),
    firestoreSet('daily_data', `digest_${date}`, { articles: JSON.stringify(digest), date }),
    // Update index of available dates
    firestoreSet('meta', 'dates', { dates: JSON.stringify([date]) }),
  ]);
  console.log(`Saved ${articles.length} articles and ${quizzes.length} quizzes to Firestore`);
}

// ─────────────────────────────────────────────
// PIPELINE WRAPPER — saves to Firestore after run
// ─────────────────────────────────────────────

function runPipelineAsync() {
  console.log(`[${new Date().toISOString()}] Running pipeline...`);
  runPipeline()
    .then(async () => {
      console.log(`[${new Date().toISOString()}] Pipeline complete. Saving to Firestore...`);
      const today = todayString();
      const articles = readJSON(path.join(DATA_DIR, `articles_${today}.json`));
      const quizzes = readJSON(path.join(DATA_DIR, `quizzes_${today}.json`));
      const digestData = readJSON(path.join(DATA_DIR, `digest_${today}.json`));
      if (articles && quizzes && digestData) {
        await saveToFirestore(today, articles, quizzes, digestData.articles || digestData);
      }
    })
    .catch(err => console.error('Pipeline failed:', err.message));
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Lakshya API', version: '2.0.0' }));

app.get('/api/articles', async (req, res) => {
  const today = todayString();
  const data = await getArticles(today);
  if (!data) return res.status(404).json({ error: 'No articles for today yet.', date: today });
  res.json({ date: today, count: data.length, articles: data.slice(0, 60) });
});

app.get('/api/digest', async (req, res) => {
  const today = todayString();
  const data = await getDigest(today);
  if (!data) return res.status(404).json({ error: 'No digest for today yet.', date: today });
  res.json(data);
});

app.get('/api/quizzes', async (req, res) => {
  const today = todayString();
  const data = await getQuizzes(today);
  if (!data) return res.status(404).json({ error: 'No quizzes for today yet.', date: today });
  const { subject } = req.query;
  const filtered = subject ? data.filter(q => q.subject === subject) : data;
  res.json({ date: today, count: filtered.length, quizzes: filtered });
});

// All quizzes from all dates (cumulative bank)
app.get('/api/quizzes/all', async (req, res) => {
  const { subject } = req.query;
  let allQuizzes = [];

  // Read all local quiz files
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('quizzes_'));
  for (const file of files) {
    const data = readJSON(path.join(DATA_DIR, file));
    if (data) allQuizzes = allQuizzes.concat(data);
  }

  // Deduplicate
  const seen = new Set();
  allQuizzes = allQuizzes.filter(q => {
    if (!q.question || seen.has(q.question)) return false;
    seen.add(q.question);
    return true;
  });

  if (subject) allQuizzes = allQuizzes.filter(q => q.subject?.includes(subject));
  allQuizzes.sort((a, b) => (b.upsc_relevance_score || 0) - (a.upsc_relevance_score || 0));

  res.json({ count: allQuizzes.length, quizzes: allQuizzes });
});

app.get('/api/dates', async (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('digest_'));
  const dates = [...new Set(files.map(f => f.replace('digest_', '').replace('.json', '')))].sort().reverse();
  res.json({ dates });
});

// ─────────────────────────────────────────────
// AI CHAT WITH WORKING RAG
// ─────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages, userId } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });

  // Rate limiting
  if (!global._chatCounts) global._chatCounts = {};
  const rateKey = `chat_${userId}_${todayString()}`;
  const count = global._chatCounts[rateKey] || 0;
  if (count >= 20) {
    return res.status(429).json({ error: 'Daily limit reached', message: 'You have used all 20 messages for today. Resets at midnight.' });
  }
  global._chatCounts[rateKey] = count + 1;

  // RAG — find relevant articles from today AND recent days
  const userQuery = (messages[messages.length - 1]?.content || '').toLowerCase();
  let contextArticles = [];

  const stopWords = new Set(['what', 'when', 'where', 'which', 'about', 'latest', 'recent', 'tell', 'explain', 'give', 'that', 'this', 'with', 'from', 'have', 'does', 'more', 'news', 'the', 'and', 'for', 'are', 'was', 'its']);
  const keywords = userQuery.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

  console.log(`Chat RAG keywords: [${keywords.join(', ')}]`);

  // Search last 3 days of articles
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const articles = await getArticles(dateStr);
    if (!articles) continue;

    const matches = articles.filter(a => {
      if (!a.title) return false;
      const content = [
        a.title,
        a.summary || '',
        ...(a.key_facts || []),
        a.why_relevant || '',
      ].join(' ').toLowerCase();
      return keywords.some(kw => content.includes(kw));
    });

    contextArticles = contextArticles.concat(matches);
    if (contextArticles.length >= 5) break;
  }

  contextArticles = contextArticles.slice(0, 5);
  console.log(`Chat RAG: found ${contextArticles.length} relevant articles`);

  let newsContext = '';
  if (contextArticles.length > 0) {
    newsContext = `\n\nRECENT NEWS FROM LAKSHYA (today's articles — use these for current affairs questions):\n` +
      contextArticles.map((a, i) =>
        `[Article ${i+1}] "${a.title}" — ${a.source}, ${a.published}\nKey facts: ${(a.key_facts || []).join(' | ')}\nContext: ${a.why_relevant || ''}`
      ).join('\n\n');
  }

  const systemPrompt = `You are Lakshya AI, an expert civil services tutor for UPSC, SSC and State PSC aspirants.

CRITICAL RULE — Always include specific facts. Every response MUST contain:
- Exact years and dates
- Full names of people (ministers, judges, committee heads)
- Full names of institutions (ministry, court, regulatory body)
- Actual numbers, statistics, penalty amounts
- Names of specific provisions, sections, or acts

Style: Conversational but information-dense. Like a UPSC topper briefing a friend — friendly but packed with real facts.

For current affairs topics: Tell what happened, who was involved, key provisions/decisions, then the exam angle (which GS paper, likely question type).

Formatting: Plain paragraphs only. No ##, **, ***, or markdown. Line breaks between paragraphs. Under 300 words.

IMPORTANT: If recent news context is provided below, use it as your PRIMARY source. Quote specific facts from those articles. If the context covers the query, answer entirely from it and mention the source. If no context matches, use training knowledge but say "Based on my training data (may not be the latest)..."${newsContext}`;

  try {
    const recentMessages = messages.slice(-6);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: recentMessages,
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const reply = data.content?.[0]?.text || 'Sorry, I could not generate a response.';
    const remaining = 20 - (global._chatCounts[rateKey] || 0);
    res.json({ reply, remaining, articlesUsed: contextArticles.length });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed', message: err.message });
  }
});

// Manual pipeline trigger
app.post('/api/run-pipeline', (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.PIPELINE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ message: 'Pipeline started' });
  runPipelineAsync();
});

// ─────────────────────────────────────────────
// SCHEDULER — 6 AM IST daily
// ─────────────────────────────────────────────

cron.schedule('30 0 * * *', () => {
  console.log('Scheduled pipeline run starting...');
  runPipelineAsync();
}, { timezone: 'UTC' });

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Lakshya API v2 running on port ${PORT}`);
  console.log(`Pipeline scheduled daily at 6:00 AM IST`);

  if (process.env.RUN_PIPELINE_ON_START !== 'false') {
    const today = todayString();
    const todayFile = path.join(DATA_DIR, `digest_${today}.json`);
    if (!fs.existsSync(todayFile)) {
      // Try Firestore first
      const doc = await getDigest(today);
      if (!doc) {
        console.log('No data for today — running pipeline now...');
        runPipelineAsync();
      } else {
        console.log('Loaded today\'s data from Firestore cache');
      }
    }
  }
});
