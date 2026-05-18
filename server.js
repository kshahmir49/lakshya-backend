const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('./pipeline');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().split('T')[0];
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function runPipelineAsync() {
  console.log(`[${new Date().toISOString()}] Running pipeline...`);
  runPipeline()
    .then(() => console.log(`[${new Date().toISOString()}] Pipeline complete.`))
    .catch(err => console.error('Pipeline failed:', err.message));
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Lakshya API', version: '1.0.0' });
});

// Today's articles
app.get('/api/articles', (req, res) => {
  const today = todayString();
  const filePath = path.join(DATA_DIR, `articles_${today}.json`);
  const data = readJSON(filePath);

  if (!data) {
    return res.status(404).json({
      error: 'No articles for today yet. Pipeline may still be running.',
      date: today,
    });
  }

  // Return top 20 by relevance, already sorted by pipeline
  res.json({
    date: today,
    count: data.length,
    articles: data.slice(0, 60),
  });
});

// Today's digest (top 10 for home screen)
app.get('/api/digest', (req, res) => {
  const today = todayString();
  const filePath = path.join(DATA_DIR, `digest_${today}.json`);
  const data = readJSON(filePath);

  if (!data) {
    return res.status(404).json({
      error: 'No digest for today yet.',
      date: today,
    });
  }

  res.json(data);
});

// Today's quiz questions
app.get('/api/quizzes', (req, res) => {
  const today = todayString();
  const filePath = path.join(DATA_DIR, `quizzes_${today}.json`);
  const data = readJSON(filePath);

  if (!data) {
    return res.status(404).json({
      error: 'No quizzes for today yet.',
      date: today,
    });
  }

  // Optionally filter by subject
  const { subject } = req.query;
  const filtered = subject
    ? data.filter(q => q.subject === subject)
    : data;

  res.json({
    date: today,
    count: filtered.length,
    quizzes: filtered,
  });
});

// List all available dates
app.get('/api/dates', (req, res) => {
  const files = fs.readdirSync(DATA_DIR);
  const dates = [...new Set(
    files
      .filter(f => f.startsWith('digest_'))
      .map(f => f.replace('digest_', '').replace('.json', ''))
  )].sort().reverse();

  res.json({ dates });
});

// Articles for a specific date (for monthly archive)
app.get('/api/articles/:date', (req, res) => {
  const { date } = req.params;
  const filePath = path.join(DATA_DIR, `articles_${date}.json`);
  const data = readJSON(filePath);

  if (!data) {
    return res.status(404).json({ error: `No articles for ${date}` });
  }

  res.json({ date, count: data.length, articles: data });
});

// Manually trigger pipeline (protect this in production)
app.post('/api/run-pipeline', (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Pipeline started' });
  runPipeline(); // run async after response
});


// All accumulated quizzes (from all dates)
app.get('/api/quizzes/all', (req, res) => {
  const { subject } = req.query;
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('quizzes_'));
  let allQuizzes = [];

  for (const file of files) {
    const data = readJSON(path.join(DATA_DIR, file));
    if (data) allQuizzes = allQuizzes.concat(data);
  }

  // Remove duplicates by question text
  const seen = new Set();
  allQuizzes = allQuizzes.filter(q => {
    if (!q.question || seen.has(q.question)) return false;
    seen.add(q.question);
    return true;
  });

  // Filter by subject if provided
  if (subject) {
    allQuizzes = allQuizzes.filter(q =>
      q.subject?.toLowerCase().includes(subject.toLowerCase())
    );
  }

  // Sort by relevance score
  allQuizzes.sort((a, b) => (b.upsc_relevance_score || 0) - (a.upsc_relevance_score || 0));

  res.json({
    count: allQuizzes.length,
    quizzes: allQuizzes,
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const articleFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('articles_'));
  const quizFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('quizzes_'));

  let totalQuizzes = 0;
  for (const file of quizFiles) {
    const data = readJSON(path.join(DATA_DIR, file));
    if (data) totalQuizzes += data.length;
  }

  res.json({
    totalDays: articleFiles.length,
    totalQuizFiles: quizFiles.length,
    estimatedQuestions: totalQuizzes,
  });
});

// ─────────────────────────────────────────────
// AI CHAT ENDPOINT
// Add this to server.js before the scheduler section
// ─────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages, userId } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required' });
  }

  // Rate limiting — 20 messages per user per day
  const today = todayString();
  const rateKey = `chat_${userId}_${today}`;
  const countRaw = await new Promise(resolve => {
    try { resolve(global._chatCounts?.[rateKey] || 0); } catch { resolve(0); }
  });
  if (!global._chatCounts) global._chatCounts = {};
  const count = global._chatCounts[rateKey] || 0;
  if (count >= 20) {
    return res.status(429).json({
      error: 'Daily limit reached',
      message: 'You have used all 20 AI chat messages for today. Limit resets at midnight.'
    });
  }
  global._chatCounts[rateKey] = count + 1;

  const systemPrompt = `You are Lakshya AI, a friendly and knowledgeable tutor who helps Indian students prepare for civil services exams (UPSC, SSC, PSC).

    Your personality:
    - Warm, engaging and conversational — like a brilliant senior who cleared UPSC and loves explaining things
    - Tell stories and give context, not just bullet points
    - Use simple language, avoid jargon unless necessary
    - Make complex topics feel interesting and relatable

    How to answer:
    - For current affairs/news: Tell what happened, who was involved, why it matters, and then what the exam angle is. Write it like a short story with context.
    - For concept questions: Explain simply first, then give an example, then the exam relevance
    - For strategy questions: Give practical, actionable advice like a mentor would

    Formatting rules — VERY IMPORTANT:
    - Do NOT use markdown symbols like ##, **, ***, ---, or # in your responses
    - Write in plain conversational paragraphs
    - Use simple line breaks to separate ideas
    - If you need to list things, write them naturally: "First... Second... Third..." or numbered like "1. ... 2. ..."
    - Keep responses under 250 words — be crisp and engaging, not exhaustive

    Exam focus: Always connect your answer to UPSC/SSC/PSC relevance but do it naturally at the end, not as a separate robotic section.
    If recent news context is provided above, prioritize it over your training data for current affairs questions. Always mention the source and date when using this context.
    If no recent news context is provided, answer from your training knowledge but clearly mention "Based on my last update..." so the user knows it may not be the most recent information.`;

  try {
    // Keep only last 6 messages for cost control (3 exchanges)
    // Find relevant articles from today's data
      const today = todayString();
      const articlesPath = path.join(DATA_DIR, `articles_${today}.json`);
      let contextArticles = [];

      if (fs.existsSync(articlesPath)) {
        const allArticles = readJSON(articlesPath) || [];
        const userQuery = messages[messages.length - 1]?.content?.toLowerCase() || '';

        // Simple keyword matching to find relevant articles
        contextArticles = allArticles
          .filter(a => {
            if (!a.title || a.upsc_relevance_score < 40) return false;
            const titleLower = a.title.toLowerCase();
            const words = userQuery.split(' ').filter(w => w.length > 3);
            return words.some(w => titleLower.includes(w));
          })
          .slice(0, 4); // max 4 articles for cost control
      }

      // Build context string from relevant articles
      let newsContext = '';
      if (contextArticles.length > 0) {
        newsContext = '\n\nRECENT NEWS CONTEXT (use this for accurate, up-to-date answers):\n' +
          contextArticles.map(a =>
            `- ${a.title} (${a.source}, ${a.published})\n  Key facts: ${(a.key_facts || []).join(' | ')}\n  UPSC angle: ${a.why_relevant || ''}`
          ).join('\n\n');
      }

      // Keep only last 6 messages for cost control (3 exchanges)
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

    res.json({ reply, remaining });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed', message: err.message });
  }
});


// ─────────────────────────────────────────────
// SCHEDULER — runs pipeline daily at 6 AM IST
// IST = UTC+5:30, so 6 AM IST = 00:30 UTC
// ─────────────────────────────────────────────

cron.schedule('30 0 * * *', () => {
  console.log('Scheduled pipeline run starting...');
  runPipeline();
}, { timezone: 'UTC' });

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lakshya API running on port ${PORT}`);
  console.log(`Pipeline scheduled daily at 6:00 AM IST`);

  // Run pipeline on startup if no data for today
  const today = todayString();
  const todayFile = path.join(DATA_DIR, `digest_${today}.json`);
  if (!fs.existsSync(todayFile) && process.env.RUN_PIPELINE_ON_START !== 'false') {
    console.log('No data for today — running pipeline now...');
    runPipelineAsync();
  }
});
