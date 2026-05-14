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
