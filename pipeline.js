// pipeline.js — Lakshya news pipeline in JavaScript
// Replaces pipeline.py — no Python needed

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const RSS_FEEDS = [
  { name: 'The Hindu',          url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { name: 'The Hindu - Opinion',url: 'https://www.thehindu.com/opinion/feeder/default.rss' },
  { name: 'PIB',                url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3' },
  { name: 'Indian Express',     url: 'https://indianexpress.com/section/india/feed/' },
  { name: 'Indian Express - Explained', url: 'https://indianexpress.com/section/explained/feed/' },
  { name: 'Times of India',     url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms' },
  { name: 'Hindustan Times',    url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { name: 'Livemint',           url: 'https://www.livemint.com/rss/news' },
  { name: 'Business Standard',  url: 'https://www.business-standard.com/rss/home_page_top_stories.rss' },
  { name: 'Down To Earth',      url: 'https://www.downtoearth.org.in/rss/all' },
];

const SUBJECTS = [
  'Polity & Governance', 'Economy & Finance', 'International Relations',
  'Geography & Environment', 'History & Culture', 'Science & Technology',
  'Social Issues', 'Defence & Security',
];

const EXAM_TAGS = ['UPSC Prelims', 'UPSC Mains', 'SSC CGL', 'State PSC', 'General'];

function todayString() {
  return new Date().toISOString().split('T')[0];
}

// ─────────────────────────────────────────────
// STEP 1: FETCH RSS FEEDS
// ─────────────────────────────────────────────

async function fetchArticles() {
  console.log('\n[1/3] Fetching RSS feeds...');
  const articles = [];

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LakshyaBot/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      const xml = await res.text();

      // Parse titles and descriptions from RSS XML
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/;
      const descRegex = /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/;
      const linkRegex = /<link>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\]<]+?)\s*(?:\]\]>)?\s*<\/link>|<guid[^>]*>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\]<]+?)\s*(?:\]\]>)?\s*<\/guid>/;

      let match;
      let count = 0;
      while ((match = itemRegex.exec(xml)) !== null && count < 15) {
        const item = match[1];
        const titleMatch = item.match(titleRegex);
        const descMatch = item.match(descRegex);
        const linkMatch = item.match(linkRegex);

        const title = (titleMatch?.[1] || titleMatch?.[2] || '').trim();
        let summary = (descMatch?.[1] || descMatch?.[2] || '').trim();
        summary = summary.replace(/<[^>]+>/g, '').trim().slice(0, 400);
        const rawLink = (linkMatch?.[1] || linkMatch?.[2] || '').trim();
        const link = rawLink.replace(/<![\[CDATA[\[]*/g, '').replace(/\]\]>/g, '').trim();

        if (!title || title.length < 10) continue;

        articles.push({
          id: `${feed.name.toLowerCase().replace(/\s/g, '_')}_${articles.length}`,
          source: feed.name,
          title,
          summary,
          link,
          published: 'Today',
          fetched_at: new Date().toISOString(),
        });
        count++;
      }
      console.log(`  ✓ ${feed.name}: ${count} articles`);
    } catch (err) {
      console.log(`  ✗ ${feed.name}: ${err.message}`);
    }
  }

  console.log(`  → Total fetched: ${articles.length} articles`);
  return articles;
}

// ─────────────────────────────────────────────
// STEP 2: AI TAGGING
// ─────────────────────────────────────────────

async function tagArticle(article) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = `You are an expert on Indian civil services exam preparation (UPSC, SSC, State PSC).

Analyze this news article and return a JSON object with exactly these fields:

Article Title: ${article.title}
Article Summary: ${article.summary}

Return ONLY valid JSON, no other text:
{
  "subject": "<one of: ${SUBJECTS.join(', ')}>",
  "exam_tags": ["<list from: ${EXAM_TAGS.join(', ')}>"],
  "upsc_relevance_score": <integer 0-100>,
  "upsc_relevance_label": "<Low / Medium / High / Very High>",
  "key_facts": ["<fact 1>", "<fact 2>", "<fact 3>"],
  "why_relevant": "<1 sentence>",
  "quiz": {
    "question": "<MCQ question>",
    "options": ["<A>", "<B>", "<C>", "<D>"],
    "correct_index": <0-3>,
    "explanation": "<2-3 sentences>"
  }
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim() || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function tagAndGenerate(articles) {
  console.log('\n[2/3] Tagging articles with AI...');
  const tagged = [];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(`  Processing ${i + 1}/${articles.length}: ${article.title.slice(0, 60)}...`);
    try {
      const aiData = await tagArticle(article);
      tagged.push({ ...article, ...aiData });
    } catch (err) {
      console.log(`    ✗ AI error: ${err.message}`);
      tagged.push({
        ...article,
        subject: 'General',
        upsc_relevance_score: 0,
        upsc_relevance_label: 'Unknown',
        exam_tags: [],
        key_facts: [],
        why_relevant: '',
        quiz: null,
      });
    }
  }

  console.log(`  → Tagged: ${tagged.length} articles`);
  return tagged;
}

// ─────────────────────────────────────────────
// STEP 3: SAVE OUTPUT
// ─────────────────────────────────────────────

function saveOutput(taggedArticles) {
  console.log('\n[3/3] Saving output...');
  const today = todayString();

  taggedArticles.sort((a, b) => (b.upsc_relevance_score || 0) - (a.upsc_relevance_score || 0));

  fs.writeFileSync(
    path.join(DATA_DIR, `articles_${today}.json`),
    JSON.stringify(taggedArticles, null, 2)
  );

  const quizzes = taggedArticles
    .filter(a => a.quiz?.question)
    .map(a => ({
      id: a.id,
      source_title: a.title,
      source_link: a.link,
      subject: a.subject,
      exam_tags: a.exam_tags,
      upsc_relevance_score: a.upsc_relevance_score,
      ...a.quiz,
    }));

  fs.writeFileSync(
    path.join(DATA_DIR, `quizzes_${today}.json`),
    JSON.stringify(quizzes, null, 2)
  );

  const digest = taggedArticles
    .filter(a => (a.upsc_relevance_score || 0) >= 50)
    .slice(0, 10)
    .map(a => ({
      title: a.title, source: a.source, subject: a.subject,
      upsc_relevance_score: a.upsc_relevance_score,
      upsc_relevance_label: a.upsc_relevance_label,
      why_relevant: a.why_relevant, key_facts: a.key_facts, link: a.link,
    }));

  fs.writeFileSync(
    path.join(DATA_DIR, `digest_${today}.json`),
    JSON.stringify({ date: today, articles: digest }, null, 2)
  );

  console.log(`  ✓ Saved ${taggedArticles.length} articles, ${quizzes.length} quizzes`);
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function runPipeline() {
  console.log(`\n${'='.repeat(50)}`);
  console.log('  LAKSHYA NEWS PIPELINE');
  console.log(`  ${new Date().toISOString()}`);
  console.log('='.repeat(50));

  const articles = await fetchArticles();
  if (!articles.length) { console.log('No articles fetched.'); return; }

  const tagged = await tagAndGenerate(articles);
  saveOutput(tagged);
  console.log('\nPipeline complete!\n');
}

module.exports = { runPipeline };
