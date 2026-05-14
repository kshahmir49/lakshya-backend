// pipeline.js — Lakshya news pipeline in JavaScript
// Replaces pipeline.py — no Python needed

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const RSS_FEEDS = [
  { name: 'The Hindu',              url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { name: 'The Hindu - Opinion',    url: 'https://www.thehindu.com/opinion/feeder/default.rss' },
  { name: 'PIB',                    url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3' },
  { name: 'Indian Express',     url: 'https://indianexpress.com/feed/' },
  { name: 'Indian Express - Explained', url: 'https://indianexpress.com/section/explained/feed/' },
  { name: 'Times of India',         url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms' },
  { name: 'Hindustan Times',        url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { name: 'NDTV',                   url: 'https://feeds.feedburner.com/ndtvnews-india-news' },
  { name: 'Economic Times',         url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms' },
  { name: 'Livemint',               url: 'https://www.livemint.com/rss/news' },
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
      while ((match = itemRegex.exec(xml)) !== null && count < 20) {
        const item = match[1];
        const titleMatch = item.match(titleRegex);
        const descMatch = item.match(descRegex);
        const linkMatch = item.match(linkRegex);

        const title = (titleMatch?.[1] || titleMatch?.[2] || '')
                    .replace(/<!\[CDATA\[/g, '')
                    .replace(/\]\]>/g, '')
                    .trim();
        let summary = (descMatch?.[1] || descMatch?.[2] || '')
                    .replace(/<!\[CDATA\[/g, '')
                    .replace(/\]\]>/g, '')
                    .replace(/<[^>]+>/g, '')
                    .trim()
                    .slice(0, 400);
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
  "key_facts": [
    "<specific factual point from this article — numbers, names, decisions, dates>",
    "<another specific fact — what happened, who decided, how much, when>",
    "<third specific fact — policy detail, impact, background context>"
  ],
  "why_relevant": "<one specific sentence: which UPSC paper/topic this maps to, e.g. GS-III Economy: RBI monetary policy tools>",
  "quiz": {
    "question": "<MCQ question based on a specific fact from this article>",
    "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
    "correct_index": <0-3>,
    "explanation": "<2-3 sentences explaining the correct answer with context>"
  }
}
Rules for upsc_relevance_score:
- Score 90-100: Supreme Court judgments, Constitutional issues, RBI/Budget/Finance Commission, major central government schemes, India-foreign policy decisions
- Score 70-89: State government policies, economic data releases, international news with direct India angle
- Score 50-69: General governance, environment policy, science & tech with India context
- Score 0-49: Crime, sports, entertainment, celebrity, foreign news with no India angle
- Distribute scores realistically — most articles should score 50-75, only truly important ones above 85
- NEVER give everything the same score — scores must vary based on actual exam importance

Rules for key_facts:
- Each fact must be SPECIFIC to THIS article — real numbers, real names, real decisions
- Do NOT write generic statements like "Understanding X is important for UPSC"
- Write facts like a crisp newspaper bullet: "RBI kept repo rate unchanged at 6.5% for 8th consecutive time"

Rules for quiz question:
- NEVER use phrases like "According to the article", "As per the article", "The article mentions"
- Write as a standalone exam question a student could answer from general knowledge
- Good format: "Which body was established under the Digital Personal Data Protection Act 2023?"
- Bad format: "According to the article, which body was established?"
- Question must test facts or concepts, not reading comprehension
- All 4 options should be plausible — no obviously wrong answers`;

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
  // Find JSON object even if there's text before/after it
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON found in response: ${raw.slice(0, 100)}`);
  const cleaned = jsonMatch[0];
  const aiData = JSON.parse(cleaned);

  // Randomize correct answer position so it's not always B
  if (aiData.quiz && aiData.quiz.options && aiData.quiz.correct_index !== undefined) {
    const options = aiData.quiz.options;
    const correctAnswer = options[aiData.quiz.correct_index];
    
    // Shuffle options
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    
    // Find where the correct answer ended up
    aiData.quiz.correct_index = options.indexOf(correctAnswer);
    aiData.quiz.options = options;
  }

  return aiData;
}

async function tagAndGenerate(articles) {
    console.log('\n[2/3] Tagging articles with AI...');
    const tagged = [];

    for (let i = 0; i < articles.length; i++) {
    const article = articles[i];

    // Skip articles with no useful content
    const skipKeywords = ['letters to the editor', 'corrections and clarifications', 
      'obituary', 'advertisement', 'classifieds', 'weather'];
    const titleLower = article.title.toLowerCase();
    if (skipKeywords.some(k => titleLower.includes(k))) {
      console.log(`  Skipping: ${article.title.slice(0, 50)}`);
      continue;
    }

    console.log(`  Processing ${i + 1}/${articles.length}...`);
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
