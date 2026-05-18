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

  const systemPrompt = `You are Lakshya AI, an expert civil services tutor for UPSC, SSC and State PSC aspirants.

  CRITICAL RULE — Always include specific facts. Every response MUST contain:
  - Exact years and dates (e.g. "passed in August 2023", "notified on September 1, 2025")
  - Full names of people (ministers, judges, committee heads, bureaucrats)
  - Full names of institutions (ministry name, court name, regulatory body)
  - Actual numbers and statistics where relevant
  - Names of specific provisions, sections, or clauses if applicable

  Style: Conversational but information-dense. Think of a UPSC topper explaining to a friend — friendly tone but packed with real facts. Not a story for entertainment, but a crisp briefing that feels like a conversation.

  Structure for current affairs/legislation topics:
  Start with what it is and why it came about. Then cover the key provisions with actual details. Name the ministry that introduced it, the year it was passed, who piloted it, any Supreme Court or committee involvement. End with which GS paper it maps to and the likely exam angle.

  Example of the level of detail required:
  "The Digital Personal Data Protection Act was passed by Parliament in August 2023, introduced by IT Minister Ashwini Vaishnaw under the Ministry of Electronics and IT (MeitY). It replaced the IT Act 2000's Section 43A provisions on data protection. It establishes the Data Protection Board of India as the adjudicatory body with penalties up to Rs 250 crore. Key concepts: Data Fiduciary (companies collecting data), Data Principal (the citizen), and consent-based processing. For UPSC GS-II, expect questions on the Board's powers, exemptions given to the government, and comparison with GDPR."

  Formatting: Plain paragraphs only. No ##, **, ***, or markdown symbols. Line breaks between paragraphs.
  Under 300 words. If no recent news context is provided, use training knowledge but mention "as of my last update" so user knows it may not be the latest.`;

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
