/* ============================================================
   news.js — the fast-moving half of the picture
   ------------------------------------------------------------
   YC data tells you structure and it moves in batches. News tells
   you what happened this week. The brief needs both.
   ============================================================ */

export const NEWS_FEEDS = [
  { url:'https://techcrunch.com/category/startups/feed/',                    source:'TechCrunch' },
  { url:'https://news.google.com/rss/search?q=%22seed+round%22+OR+%22series+a%22+startup&hl=en-US&gl=US&ceid=US:en', source:'Google News' },
  { url:'https://news.google.com/rss/search?q=%22raises%22+startup+funding+robotics+OR+%22climate+tech%22+OR+defense&hl=en-US&gl=US&ceid=US:en', source:'Google News' },
  { url:'https://www.canarymedia.com/rss.rss',                               source:'Canary Media' },
];

const FUNDING = /\b(raise[sd]?|seed|series [a-d]|funding|round|backed|valuation|acquir|launch(es|ed)?|emerges? from stealth)\b/i;

/* Strip tags without a DOM — Workers have no DOMParser. */
const strip = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ').trim();

const pick = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? strip(m[1]) : '';
};

function parseRss(xml, source) {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items.map(it => {
    const title = pick(it, 'title');
    const link  = pick(it, 'link') || pick(it, 'guid');
    const date  = Date.parse(pick(it, 'pubDate')) || 0;
    return { title, link, source, publishedAt: date, excerpt: pick(it, 'description').slice(0, 220) };
  }).filter(a => a.title && a.title.length > 8);
}

/** Recent funding/launch stories, newest first, de-duplicated by title. */
export async function fetchNews(maxAgeMs = 7 * 24 * 3600 * 1000) {
  const results = await Promise.allSettled(NEWS_FEEDS.map(async f => {
    const res = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/1.0)' } });
    if (!res.ok) return [];
    return parseRss(await res.text(), f.source);
  }));

  const seen = new Set(), out = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) {
      const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (seen.has(key)) continue;
      if (a.publishedAt && Date.now() - a.publishedAt > maxAgeMs) continue;
      seen.add(key);
      out.push({ ...a, funding: FUNDING.test(`${a.title} ${a.excerpt}`) });
    }
  }
  return out.sort((a, b) => b.publishedAt - a.publishedAt);
}
