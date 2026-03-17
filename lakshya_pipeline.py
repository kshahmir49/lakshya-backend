"""
Lakshya — Daily News Pipeline
Fetches RSS feeds, tags articles with Claude AI, generates quiz questions.
Run manually: python pipeline.py
Auto-schedule: python pipeline.py --schedule  (runs daily at 6 AM)
"""

import feedparser
import anthropic
import json
import os
import schedule
import time
from datetime import datetime, date
from pathlib import Path

# ─────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────
OUTPUT_DIR = Path("./data")
OUTPUT_DIR.mkdir(exist_ok=True)

RSS_FEEDS = [
    {"name": "The Hindu",        "url": "https://www.thehindu.com/news/national/feeder/default.rss"},
    {"name": "PIB",              "url": "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3"},
    {"name": "Indian Express",   "url": "https://indianexpress.com/section/india/feed/"},
    {"name": "Times of India",   "url": "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms"},
    {"name": "Hindustan Times",  "url": "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml"},
]

# Exam tags to assign
EXAM_TAGS = ["UPSC Prelims", "UPSC Mains", "SSC CGL", "State PSC", "General"]

# Subject categories
SUBJECTS = [
    "Polity & Governance",
    "Economy & Finance",
    "International Relations",
    "Geography & Environment",
    "History & Culture",
    "Science & Technology",
    "Social Issues",
    "Defence & Security",
]

# ─────────────────────────────────────────────
# STEP 1: FETCH RSS FEEDS
# ─────────────────────────────────────────────

def fetch_articles(max_per_feed: int = 10) -> list[dict]:
    """Fetch articles from all RSS feeds."""
    articles = []
    print(f"\n[1/3] Fetching RSS feeds...")

    for feed_info in RSS_FEEDS:
        try:
            feed = feedparser.parse(feed_info["url"])
            count = 0
            for entry in feed.entries[:max_per_feed]:
                title = entry.get("title", "").strip()
                summary = entry.get("summary", entry.get("description", "")).strip()
                link = entry.get("link", "")
                published = entry.get("published", str(date.today()))

                if not title:
                    continue

                # Clean HTML tags from summary
                import re
                summary = re.sub(r"<[^>]+>", "", summary).strip()
                summary = summary[:500]  # cap length

                articles.append({
                    "id": f"{feed_info['name'].lower().replace(' ', '_')}_{len(articles)}",
                    "source": feed_info["name"],
                    "title": title,
                    "summary": summary,
                    "link": link,
                    "published": published,
                    "fetched_at": datetime.now().isoformat(),
                })
                count += 1

            print(f"  ✓ {feed_info['name']}: {count} articles")

        except Exception as e:
            print(f"  ✗ {feed_info['name']}: Failed — {e}")

    print(f"  → Total fetched: {len(articles)} articles")
    return articles


# ─────────────────────────────────────────────
# STEP 2: AI TAGGING + QUIZ GENERATION
# ─────────────────────────────────────────────

def tag_and_generate(articles: list[dict]) -> list[dict]:
    """Use Claude to tag articles and generate quiz questions."""
    print(f"\n[2/3] Tagging articles with AI...")

    client = anthropic.Anthropic()
    tagged = []

    for i, article in enumerate(articles):
        print(f"  Processing {i+1}/{len(articles)}: {article['title'][:60]}...")

        prompt = f"""You are an expert on Indian civil services exam preparation (UPSC, SSC, State PSC).

Analyze this news article and return a JSON object with exactly these fields:

Article Title: {article['title']}
Article Summary: {article['summary']}

Return ONLY valid JSON, no other text:
{{
  "subject": "<one of: {', '.join(SUBJECTS)}>",
  "exam_tags": ["<list of relevant exams from: {', '.join(EXAM_TAGS)}>"],
  "upsc_relevance_score": <integer 0-100, how relevant this is for UPSC preparation>,
  "upsc_relevance_label": "<Low / Medium / High / Very High>",
  "key_facts": ["<fact 1>", "<fact 2>", "<fact 3>"],
  "why_relevant": "<1 sentence explaining why this matters for exam prep>",
  "quiz": {{
    "question": "<MCQ question based on this article>",
    "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
    "correct_index": <0-3>,
    "explanation": "<2-3 sentence explanation of the correct answer>"
  }}
}}"""

        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=800,
                messages=[{"role": "user", "content": prompt}]
            )

            raw = response.content[0].text.strip()
            # Strip markdown code fences if present
            raw = raw.replace("```json", "").replace("```", "").strip()
            ai_data = json.loads(raw)

            tagged_article = {**article, **ai_data}
            tagged.append(tagged_article)

        except json.JSONDecodeError as e:
            print(f"    ✗ JSON parse error: {e}")
            # Save article without AI data rather than losing it
            article["subject"] = "General"
            article["upsc_relevance_score"] = 0
            article["upsc_relevance_label"] = "Unknown"
            article["exam_tags"] = []
            article["key_facts"] = []
            article["why_relevant"] = ""
            article["quiz"] = None
            tagged.append(article)

        except Exception as e:
            print(f"    ✗ AI error: {e}")
            tagged.append(article)

    print(f"  → Tagged: {len(tagged)} articles")
    return tagged


# ─────────────────────────────────────────────
# STEP 3: SAVE OUTPUT
# ─────────────────────────────────────────────

def save_output(tagged_articles: list[dict]):
    """Save tagged articles and extracted quizzes to JSON files."""
    print(f"\n[3/3] Saving output...")

    today = date.today().isoformat()

    # Sort by relevance score descending
    tagged_articles.sort(
        key=lambda x: x.get("upsc_relevance_score", 0),
        reverse=True
    )

    # Save full articles
    articles_path = OUTPUT_DIR / f"articles_{today}.json"
    with open(articles_path, "w", encoding="utf-8") as f:
        json.dump(tagged_articles, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Articles saved → {articles_path}")

    # Extract and save quizzes separately
    quizzes = []
    for article in tagged_articles:
        quiz = article.get("quiz")
        if quiz and quiz.get("question"):
            quizzes.append({
                "id": article["id"],
                "source_title": article["title"],
                "source_link": article["link"],
                "subject": article.get("subject", "General"),
                "exam_tags": article.get("exam_tags", []),
                "upsc_relevance_score": article.get("upsc_relevance_score", 0),
                **quiz
            })

    quizzes_path = OUTPUT_DIR / f"quizzes_{today}.json"
    with open(quizzes_path, "w", encoding="utf-8") as f:
        json.dump(quizzes, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Quizzes saved → {quizzes_path} ({len(quizzes)} questions)")

    # Save a daily digest (top 10 high-relevance articles)
    digest = [
        {
            "title": a["title"],
            "source": a["source"],
            "subject": a.get("subject", ""),
            "upsc_relevance_score": a.get("upsc_relevance_score", 0),
            "upsc_relevance_label": a.get("upsc_relevance_label", ""),
            "why_relevant": a.get("why_relevant", ""),
            "key_facts": a.get("key_facts", []),
            "link": a["link"],
        }
        for a in tagged_articles[:10]
        if a.get("upsc_relevance_score", 0) >= 50
    ]

    digest_path = OUTPUT_DIR / f"digest_{today}.json"
    with open(digest_path, "w", encoding="utf-8") as f:
        json.dump({"date": today, "articles": digest}, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Digest saved → {digest_path} ({len(digest)} top articles)")

    # Print a quick summary
    by_subject = {}
    for a in tagged_articles:
        subj = a.get("subject", "Unknown")
        by_subject[subj] = by_subject.get(subj, 0) + 1

    high_relevance = [a for a in tagged_articles if a.get("upsc_relevance_score", 0) >= 70]

    print(f"\n{'─'*50}")
    print(f"  DAILY PIPELINE SUMMARY — {today}")
    print(f"{'─'*50}")
    print(f"  Total articles : {len(tagged_articles)}")
    print(f"  High relevance : {len(high_relevance)} articles (score ≥ 70)")
    print(f"  Quiz questions : {len(quizzes)}")
    print(f"\n  By subject:")
    for subj, count in sorted(by_subject.items(), key=lambda x: -x[1]):
        print(f"    {subj:<35} {count}")
    print(f"{'─'*50}\n")


# ─────────────────────────────────────────────
# MAIN RUNNER
# ─────────────────────────────────────────────

def run_pipeline():
    """Run the full pipeline once."""
    print(f"\n{'='*50}")
    print(f"  LAKSHYA NEWS PIPELINE")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*50}")

    articles = fetch_articles(max_per_feed=8)
    if not articles:
        print("No articles fetched. Exiting.")
        return

    tagged = tag_and_generate(articles)
    save_output(tagged)
    print("Pipeline complete!\n")


if __name__ == "__main__":
    import sys

    if "--schedule" in sys.argv:
        print("Scheduling pipeline to run daily at 6:00 AM...")
        schedule.every().day.at("06:00").do(run_pipeline)
        run_pipeline()  # also run immediately on start
        while True:
            schedule.run_pending()
            time.sleep(60)
    else:
        run_pipeline()
