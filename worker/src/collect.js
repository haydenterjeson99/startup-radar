/* ============================================================
   collect.js — the nightly pulls that feed the brief and site
   ------------------------------------------------------------
   Each stage stays under the Workers free-plan limit of 50
   outbound requests, so the cron runs them a few minutes apart
   (see index.js) instead of all at once.

   Nothing here decides what is "new". Every row gets a
   first_seen timestamp the first time it is stored, and that
   is never overwritten; brief.js reads first_seen together with
   the sent table to guarantee the email never repeats.
   ============================================================ */

import { SOURCES_A, SOURCES_B, SECTORS, FUNDING, BAY_AREA, isNoise,
         ROLE_CORE, ROLE_GTM, ROLE_EXCLUDE, classifyLocation } from './sources.js';
import { fetchJobs } from './watchlist.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/2.0; +https://haydenterjeson99.github.io/startup-radar/)' };
const DAY = 24 * 3600 * 1000;

/* ---------- ids: identical to the original front end, so
   articles dismissed before this change stay dismissed ---------- */
function fnv1a(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }
export const articleId = title => 'a' + fnv1a((title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80));

/* ---------- RSS without a DOM ---------- */
const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&[a-z]+;/gi, ' ');
const strip = s => decode((s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const pick = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')); return m ? strip(m[1]) : ''; };

function unwrapLink(link) {
  // Bing wraps the article URL in a click-tracking redirect.
  try { const u = new URL(link); if (u.hostname.endsWith('bing.com')) return u.searchParams.get('url') || link; } catch {}
  return link;
}

function sourceUrl(src) {
  if (src.kind === 'google') return `https://news.google.com/rss/search?q=${encodeURIComponent(src.query + ' when:7d')}&hl=en-US&gl=US&ceid=US:en`;
  if (src.kind === 'bing')   return `https://www.bing.com/news/search?q=${encodeURIComponent(src.query)}&format=rss`;
  return src.url;
}

export function parseFeed(xml, src) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(it => {
    let title = pick(it, 'title');
    let source = src.source || pick(it, 'source') || '';
    if (src.tier === 2) {
      // Search results put the publisher at the end of the title.
      const m = title.match(/\s[-–|]\s([^-–|]{2,60})$/);
      if (m) { source = source || m[1].trim(); title = title.slice(0, m.index).trim(); }
      source = pick(it, 'source') || source || (src.kind === 'bing' ? 'Bing News' : 'Google News');
    }
    let link = pick(it, 'link') || (it.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || pick(it, 'guid');
    link = unwrapLink(link);
    const published = Date.parse(pick(it, 'pubDate') || pick(it, 'published') || pick(it, 'updated') || pick(it, 'dc:date')) || 0;
    const excerpt = pick(it, 'description') || pick(it, 'summary') || pick(it, 'content');
    return { title, link, source, publishedAt: published, excerpt: excerpt.slice(0, 280) };
  }).filter(a => a.title && a.title.length > 8 && /^https?:/.test(a.link));
}

/** Tag a story with the sectors, Bay Area signal and funding signal it carries. */
export function tagArticle(a) {
  const blob = `${a.title} ${a.excerpt}`;
  const sectors = Object.entries(SECTORS).filter(([, s]) => s.re.test(blob)).map(([k]) => k);
  return { sectors, bay: BAY_AREA.test(blob), funding: FUNDING.test(blob) };
}

/* ---------- stage: feeds ---------- */

async function pullSources(env, sources) {
  const now = Date.now();
  const report = [];
  const rows = [];
  const results = await Promise.allSettled(sources.map(async src => {
    const res = await fetch(sourceUrl(src), { headers: UA, cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), src);
  }));

  results.forEach((r, i) => {
    const src = sources[i];
    const label = src.source || `${src.kind}: ${src.query}`;
    if (r.status !== 'fulfilled') { report.push({ label, tab: src.tab, ok: false, error: r.reason?.message || 'failed', n: 0 }); return; }
    const fresh = r.value.filter(a => (!a.publishedAt || now - a.publishedAt < 21 * DAY) && !isNoise(a));
    report.push({ label, tab: src.tab, ok: true, n: fresh.length });
    for (const a of fresh) {
      const t = tagArticle(a);
      rows.push([articleId(a.title), src.tab, src.tier, a.title, a.link, a.source, a.publishedAt || now, a.excerpt,
                 JSON.stringify(t.sectors), t.bay ? 1 : 0, t.funding ? 1 : 0, now]);
    }
  });

  // First occurrence wins: tier-1 sources are listed first in each batch.
  const seen = new Set();
  const unique = rows.filter(r => !seen.has(r[0]) && seen.add(r[0]));
  for (let i = 0; i < unique.length; i += 50) {
    await env.DB.batch(unique.slice(i, i + 50).map(r => env.DB.prepare(
      `INSERT INTO articles (id,tab,tier,title,link,source,published_at,excerpt,sectors,bay,funding,first_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET tier = MIN(articles.tier, excluded.tier),
         link = CASE WHEN excluded.tier < articles.tier THEN excluded.link ELSE articles.link END,
         source = CASE WHEN excluded.tier < articles.tier THEN excluded.source ELSE articles.source END`
    ).bind(...r)));
  }
  return { stored: unique.length, report };
}

export async function collectFeedsA(env) {
  const out = await pullSources(env, SOURCES_A);
  await env.DB.prepare(`DELETE FROM articles WHERE first_seen < ?`).bind(Date.now() - 60 * DAY).run();
  return out;
}

/** Feeds part B, plus a Google News sweep for every watchlist name. */
export async function collectFeedsB(env, watchlist) {
  const names = watchlist.filter(w => !w.removed).map(w => {
    const alias = (w.aliases || []).find(a => a.length > 4 && /\s/.test(a)) || w.name;
    return { q: `"${alias}"`, tab: w.sector };
  });
  const searches = [];
  // ~10 names per query keeps the query short enough for Google
  // and the whole stage under the request budget.
  for (let i = 0; i < names.length && searches.length < 8; i += 10) {
    const chunk = names.slice(i, i + 10);
    searches.push({ tab: chunk[0].tab, tier: 2, kind: 'google', query: chunk.map(n => n.q).join(' OR ') });
  }
  return pullSources(env, [...SOURCES_B, ...searches]);
}

/* ---------- stage: jobs ---------- */

export function isGtmRole(title) {
  if (ROLE_EXCLUDE.test(title)) return false;
  if (ROLE_CORE.test(title)) return true;
  return ROLE_GTM.test(title) && !/\b(engineer|developer|scientist|technician)\b/i.test(title.replace(/(sales|solutions|field) engineer(ing)?/ig, ''));
}

export async function collectJobs(env, watchlist) {
  const now = Date.now();
  const boards = watchlist.filter(w => !w.removed && w.ats && w.slug).slice(0, 45);
  const known = new Set(((await env.DB.prepare('SELECT DISTINCT company_id FROM jobs').all()).results || []).map(r => r.company_id));
  const report = [];

  const results = await Promise.allSettled(boards.map(w => fetchJobs(w.ats, w.slug)));
  for (let i = 0; i < boards.length; i++) {
    const w = boards[i], r = results[i];
    if (r.status !== 'fulfilled') { report.push({ id: w.id, ok: false, error: r.reason?.message }); continue; }
    const all = r.value;
    const keep = all.map(p => {
      const loc = classifyLocation(p.location, p.remote);
      const gtm  = isGtmRole(p.title);
      const core = gtm && ROLE_CORE.test(p.title);
      return { ...p, core, gtm, bay: loc.bay, remote: loc.remote };
    }).filter(p => p.gtm && (p.bay || p.remote));

    // A company we've never read before: its existing roles are a
    // baseline, not news. They show on the site but not as "new".
    const baseline = known.has(w.id) ? 0 : 1;

    const stmts = keep.map(p => env.DB.prepare(
      `INSERT INTO jobs (id,company_id,title,location,dept,url,core,bay,remote,posted_at,first_seen,last_seen,baseline)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, title=excluded.title, location=excluded.location`
    ).bind(p.id, w.id, p.title, p.location, p.dept, p.url, p.core ? 1 : 0, p.bay ? 1 : 0, p.remote ? 1 : 0,
           p.postedAt || null, now, now, baseline));
    stmts.push(env.DB.prepare('UPDATE watchlist SET open_roles=?, roles_checked=? WHERE id=?').bind(all.length, now, w.id));
    for (let j = 0; j < stmts.length; j += 50) await env.DB.batch(stmts.slice(j, j + 50));
    report.push({ id: w.id, ok: true, total: all.length, gtm: keep.length });
  }
  // A role missing from its board for 2+ days is treated as closed
  // by the readers; rows are kept a month so a re-post isn't "new".
  await env.DB.prepare('DELETE FROM jobs WHERE last_seen < ?').bind(now - 30 * DAY).run();
  return { report };
}

/* ---------- stage: events ---------- */

/* Luma is where most SF tech events are listed. Its discover
   endpoint for San Francisco returns every public event; we keep
   the ones whose name matches the three sectors. */
const LUMA_SF = 'discplace-BDj7GNbGlsF7Cka';
const ICS_CALENDARS = [
  { url: 'https://api.lu.ma/ics/get?entity=calendar&id=cal-r8sBZiNOsfXtnnj', name: 'Defense Tech (Luma)' },
  { url: 'https://www.meetup.com/geomeetup/events/ical/',                  name: 'GeoMeetup' },
];
/* Event names are short and generic, so this list is narrower
   than the article vocabulary — "forest" or "army" alone in an
   event title is usually a book club or a hackathon theme. */
const EVENT_RE = /\b(geospatial|geo ?ai|geo ?meetup|earth (observation|data|intelligence)|remote sensing|satellite|satcom|spatial data|GIS\b|mapping|maps\b|lidar|drones?|UAVs?|UAS\b|eVTOL|autonomy|autonomous (systems|aircraft|vehicles)|defen[cs]e|dual[- ]use|national security|nat ?sec|aerospace|space ?tech|new space|wildfire|climate (risk|resilience|tech|adaptation)|climatetech|insurtech|catastrophe|resilien(ce|t)|hard ?tech|deep ?tech|grid|utilit(y|ies))\b/i;

function parseIcs(ics) {
  const out = [];
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const f = k => (block.match(new RegExp(`^${k}(?:;[^:]*)?:(.*)$`, 'm')) || [])[1] || '';
    const dt = f('DTSTART');
    const m = dt.match(/(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/);
    if (!m) continue;
    const start = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    out.push({ uid: f('UID'), title: f('SUMMARY').replace(/\\,/g, ','), start,
               location: f('LOCATION').replace(/\\,/g, ','), url: f('URL') || '' });
  }
  return out;
}

export async function collectEvents(env) {
  const now = Date.now();
  const found = [];
  const report = [];

  let cursor = null;
  for (let page = 0; page < 14; page++) {
    const u = `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${LUMA_SF}&pagination_limit=50${cursor ? `&pagination_cursor=${cursor}` : ''}`;
    try {
      const r = await fetch(u, { headers: UA });
      if (!r.ok) { report.push({ source: 'luma-sf', ok: false, error: `HTTP ${r.status}` }); break; }
      const j = await r.json();
      for (const e of j.entries || []) {
        const ev = e.event || {};
        const blob = `${ev.name} ${e.calendar?.name === 'Personal' ? '' : e.calendar?.name || ''}`;
        if (!EVENT_RE.test(blob)) continue;
        found.push({ id: `luma:${ev.api_id}`, title: ev.name, start: Date.parse(ev.start_at),
          city: ev.geo_address_info?.city || ev.geo_address_info?.city_state || '',
          url: `https://luma.com/${ev.url}`, source: !e.calendar?.name || e.calendar.name === 'Personal' ? 'Luma' : e.calendar.name });
      }
      if (!j.has_more || !j.next_cursor) break;
      cursor = encodeURIComponent(j.next_cursor);
    } catch (e) { report.push({ source: 'luma-sf', ok: false, error: e.message }); break; }
  }
  report.push({ source: 'luma-sf', ok: true, n: found.length });

  for (const cal of ICS_CALENDARS) {
    try {
      const r = await fetch(cal.url, { headers: UA });
      const evs = parseIcs(await r.text()).filter(e => e.start > now && (BAY_AREA.test(e.location) || /\bCA\b/.test(e.location)));
      for (const e of evs) found.push({ id: `ics:${e.uid}`, title: e.title, start: e.start,
        city: (e.location.match(BAY_AREA) || [''])[0], url: e.url || cal.url, source: cal.name });
      report.push({ source: cal.name, ok: true, n: evs.length });
    } catch (e) { report.push({ source: cal.name, ok: false, error: e.message }); }
  }

  const upcoming = found.filter(e => e.start && e.start > now - DAY && e.start < now + 60 * DAY);
  for (let i = 0; i < upcoming.length; i += 50) {
    await env.DB.batch(upcoming.slice(i, i + 50).map(e => env.DB.prepare(
      `INSERT INTO events (id,title,start_at,city,url,source,first_seen) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, start_at=excluded.start_at`
    ).bind(e.id, e.title, e.start, e.city, e.url, e.source, now)));
  }
  await env.DB.prepare('DELETE FROM events WHERE start_at < ?').bind(now - 2 * DAY).run();
  return { stored: upcoming.length, report };
}
