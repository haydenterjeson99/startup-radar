/* ============================================================
   brief.js — the morning briefing, v2
   ------------------------------------------------------------
   v1 summarised the YC batch every day. The batch only changes
   twice a year, so the brief read the same every morning and
   stopped being read. v2 is built from what is NEW:

     1. New GTM roles at watchlist companies (Bay Area / US-remote)
     2. Watchlist companies in the news
     3. Funding in EO/geospatial, drones/defense, climate risk
     4. Top sector stories from trusted publishers
     5. Upcoming Bay Area events in those sectors
     6. YC landscape — only on days a number actually moved
     7. New YC companies in those sectors

   Rules:
   - Never repeat. Every item shown is written to the `sent`
     table and is never eligible again.
   - Deterministic. Selection and ranking are fixed rules over
     stored rows; nothing is model-written, so it cannot invent.
   - A quiet day produces a short brief, not padding.
   ============================================================ */

import { SECTORS } from './sources.js';
import { mentionMatchers } from './watchlist.js';

const DAY = 24 * 3600 * 1000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const SHORT = { geo: 'EO/Geo', defense: 'Defense', risk: 'Risk' };
const fmtDay = ts => new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
const fmtTime = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });

/* Same story from three outlets is one story. */
const words = t => new Set((t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.6;
}
function dedupe(list) {
  const out = [];
  for (const a of list) if (!out.some(o => similar(o.title, a.title))) out.push(a);
  return out;
}

async function getMeta(env, key) {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}
export async function setMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

/* ---------- YC: only when it moved ---------- */

function ycRef(l) {
  return {
    current: l.current, size: l.batchSizes?.[l.current] || 0,
    gaps: Object.fromEntries((l.gaps || []).map(g => [g.problem, g.share])),
    industries: Object.fromEntries((l.industries || []).map(i => [i.label, i.now])),
  };
}
function ycChanges(prev, cur) {
  if (!prev) return [];
  const out = [];
  if (prev.current !== cur.current) out.push({ label: `New batch: ${cur.current}`, detail: `The landscape now reads ${cur.current} (n=${cur.size}) instead of ${prev.current}.`, stat: `n=${cur.size}` });
  else if (Math.abs(cur.size - prev.size) >= 10) out.push({ label: `${cur.current} grew to ${cur.size} companies`, detail: `Up from ${prev.size} the last time the landscape appeared here.`, stat: `+${cur.size - prev.size}` });
  for (const [k, v] of Object.entries(cur.gaps)) if (prev.gaps[k] != null && Math.abs(v - prev.gaps[k]) >= 1.5)
    out.push({ label: k, detail: 'Share of the batch naming this gap.', stat: `${prev.gaps[k]}% → ${v}%` });
  for (const [k, v] of Object.entries(cur.industries)) if (prev.industries[k] != null && Math.abs(v - prev.industries[k]) >= 1.5)
    out.push({ label: k, detail: 'Share of the batch in this YC industry.', stat: `${prev.industries[k]}% → ${v}%` });
  return out.slice(0, 6);
}

/* ---------- build ---------- */

/**
 * @param env        worker env with DB
 * @param landscape  latest YC landscape (may be null)
 * @param watchlist  active watchlist rows
 * @param opts.dryRun  build without marking anything as sent
 */
export async function buildBrief(env, landscape, watchlist, { dryRun = false } = {}) {
  const now = Date.now();
  const last = await getMeta(env, 'last_brief_at');
  // The sent table is what prevents repeats; the window just stops
  // week-old items that lost out to the caps from resurfacing.
  const since = Math.max(now - 4 * DAY, last ? last - 6 * 3600 * 1000 : now - 2 * DAY);
  const wl = watchlist.filter(w => !w.removed);
  const byId = Object.fromEntries(wl.map(w => [w.id, w]));
  const sections = [];
  const shown = [];

  /* ---- 1. New roles ---- */
  const jobs = (await env.DB.prepare(
    `SELECT j.* FROM jobs j LEFT JOIN sent s ON s.key = 'job:' || j.id
     WHERE s.key IS NULL AND j.baseline = 0 AND j.first_seen > ? AND j.last_seen > ?
     ORDER BY j.core DESC, j.bay DESC, j.first_seen DESC LIMIT 60`
  ).bind(since, now - 2 * DAY).all()).results.filter(j => byId[j.company_id]);
  jobs.sort((a, b) => (b.core - a.core) || ((byId[b.company_id].starred || 0) - (byId[a.company_id].starred || 0)) || (b.bay - a.bay));
  const openTotal = (await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE last_seen > ?').bind(now - 2 * DAY).first())?.n || 0;
  const roleItems = jobs.slice(0, 12).map(j => {
    shown.push(`job:${j.id}`);
    return { kind: j.core ? 'revops' : 'gtm', label: `${byId[j.company_id].name} — ${j.title}`,
      detail: [j.location, j.dept].filter(Boolean).join(' · '),
      stat: j.core ? 'RevOps' : (j.bay ? 'Bay Area' : 'Remote US'), url: j.url };
  });
  sections.push({
    id: 'roles', title: 'New GTM roles',
    lead: roleItems.length
      ? `${plural(jobs.length, 'new role')} posted at watchlist companies${jobs.filter(j => j.core).length ? `, ${jobs.filter(j => j.core).length} of them RevOps/ops` : ''}. ${openTotal} GTM roles open in total.`
      : `No new GTM roles since the last brief. ${openTotal} remain open across the watchlist.`,
    items: roleItems,
  });

  /* ---- articles, tagged once ---- */
  const matchers = mentionMatchers(wl);
  const arts = (await env.DB.prepare(
    `SELECT a.* FROM articles a LEFT JOIN sent s ON s.key = 'art:' || a.id
     WHERE s.key IS NULL AND a.first_seen > ? AND (a.published_at IS NULL OR a.published_at > ?)
     ORDER BY a.published_at DESC LIMIT 600`
  ).bind(since, now - 5 * DAY).all()).results.map(a => {
    const sectors = JSON.parse(a.sectors || '[]');
    const blob = `${a.title} ${a.excerpt || ''}`;
    const mentions = matchers.filter(m => m.re.test(blob) && (!m.needsContext || sectors.length)).map(m => m.id);
    const score = (a.tier === 1 ? 3 : 0) + sectors.length * 2 + (a.bay ? 2 : 0) + (mentions.length ? 4 : 0)
                + (a.funding ? 1 : 0) + (now - (a.published_at || now) < DAY ? 1 : 0);
    return { ...a, sectors, mentions, score };
  });
  const used = new Set();
  const take = (list, n) => {
    const out = [];
    for (const a of dedupe(list.filter(a => !used.has(a.id)))) {
      if (out.length >= n) break;
      if ([...used].some(id => similar(arts.find(x => x.id === id)?.title, a.title))) continue;
      used.add(a.id); shown.push(`art:${a.id}`); out.push(a);
    }
    return out;
  };
  const artItem = (a, kind, extra = '') => ({
    kind, label: a.title, url: a.link,
    detail: [a.source, a.tier === 2 ? 'via search' : '', extra].filter(Boolean).join(' · '),
    stat: [a.bay ? 'Bay Area' : '', a.sectors.map(s => SHORT[s] || s).join(' + ')].filter(Boolean).join(' · '),
  });

  /* ---- 2. Watchlist in the news ---- */
  // At most two stories per company, so one big week for one
  // company doesn't crowd out the rest of the list.
  const perCo = {};
  const watch = take(arts.filter(a => a.mentions.length)
    .sort((a, b) => (Math.max(...b.mentions.map(id => byId[id]?.starred || 0)) - Math.max(...a.mentions.map(id => byId[id]?.starred || 0))) || b.score - a.score)
    .filter(a => { const k = a.mentions[0]; perCo[k] = (perCo[k] || 0) + 1; return perCo[k] <= 2; }), 8);
  if (watch.length) sections.push({
    id: 'watch', title: 'Watchlist in the news',
    lead: `${[...new Set(watch.flatMap(a => a.mentions))].map(id => byId[id]?.name).filter(Boolean).slice(0, 5).join(', ')} ${watch.length === 1 ? 'is' : 'are'} in the news.`,
    items: watch.map(a => artItem(a, 'watch', a.mentions.map(id => byId[id]?.name).join(', '))),
  });

  /* ---- 3. Funding in your sectors ---- */
  const funding = take(arts.filter(a => a.funding && a.sectors.length).sort((a, b) => (b.bay - a.bay) || b.score - a.score), 8);
  if (funding.length) sections.push({
    id: 'funding', title: 'Money moving in your sectors',
    lead: `${plural(funding.length, 'funding or M&A story', 'funding or M&A stories')}${funding.filter(a => a.bay).length ? `, ${funding.filter(a => a.bay).length} in the Bay Area` : ''}.`,
    items: funding.map(a => artItem(a, 'funding')),
  });

  /* ---- 4. Sector news ---- */
  const news = take(arts.filter(a => a.sectors.length && a.tier === 1).sort((a, b) => b.score - a.score), 6);
  if (news.length) sections.push({
    id: 'news', title: 'Sector news',
    lead: `The ${plural(news.length, 'story', 'stories')} from trade publications that hit the most of your sectors.`,
    items: news.map(a => artItem(a, 'news')),
  });

  /* ---- 5. Events ---- */
  const events = (await env.DB.prepare(
    `SELECT e.* FROM events e LEFT JOIN sent s ON s.key = 'evt:' || e.id
     WHERE s.key IS NULL AND e.first_seen > ? AND e.start_at > ? AND e.start_at < ?
     ORDER BY e.start_at LIMIT 6`
  ).bind(since, now, now + 45 * DAY).all()).results;
  if (events.length) {
    events.forEach(e => shown.push(`evt:${e.id}`));
    sections.push({
      id: 'events', title: 'Coming up in the Bay Area',
      lead: `${plural(events.length, 'newly listed event')} in your sectors.`,
      items: events.map(e => ({ kind: 'event', label: e.title, url: e.url,
        detail: [e.city, e.source].filter(Boolean).join(' · '), stat: `${fmtDay(e.start_at)} ${fmtTime(e.start_at)}` })),
    });
  }

  /* ---- 6. YC landscape, only if it moved ---- */
  let ycShown = false;
  if (landscape?.current) {
    const ref = ycRef(landscape), prevRef = await getMeta(env, 'brief_yc_ref');
    const changes = ycChanges(prevRef, ref);
    if (changes.length) {
      ycShown = true;
      sections.push({ id: 'yc', title: 'YC landscape moved',
        lead: `Since it last appeared here, ${plural(changes.length, 'number')} in the ${landscape.current} read shifted by 1.5pp or more.`,
        items: changes.map(c => ({ kind: 'up', ...c })) });
    }
    if (!dryRun && (changes.length || !prevRef)) await setMeta(env, 'brief_yc_ref', ref);
  }

  /* ---- 7. New YC companies in your sectors ---- */
  const yc = (await env.DB.prepare(
    `SELECT c.* FROM companies c LEFT JOIN sent s ON s.key = 'yc:' || c.slug
     WHERE s.key IS NULL AND c.first_seen > ? LIMIT 200`
  ).bind(since).all()).results.filter(c => Object.values(SECTORS).some(s => s.re.test(`${c.one_liner} ${c.industries} ${c.tags}`)));
  if (yc.length) {
    yc.slice(0, 6).forEach(c => shown.push(`yc:${c.slug}`));
    sections.push({ id: 'yc-new', title: 'New YC companies in your sectors',
      lead: `${plural(yc.length, 'company', 'companies')} just appeared in the YC directory.`,
      items: yc.slice(0, 6).map(c => ({ kind: 'new', label: c.name, detail: c.one_liner, stat: c.batch, url: c.url })) });
  }

  /* ---- headline: the single most specific new thing ---- */
  const counts = { roles: jobs.length, watch: watch.length, funding: funding.length, news: news.length, events: events.length, ycNew: yc.length };
  const total = roleItems.length + watch.length + funding.length + news.length + events.length + (ycShown ? 1 : 0) + Math.min(yc.length, 6);
  let headline;
  const coreJob = jobs.find(j => j.core);
  if (coreJob) headline = `${byId[coreJob.company_id].name} posted a ${coreJob.title} role${coreJob.bay ? ' in the Bay Area' : ' (remote)'}`;
  else if (watch.length) headline = `${byId[watch[0].mentions[0]]?.name} in the news: ${watch[0].title}`;
  else if (funding.length) headline = funding[0].title;
  else if (jobs.length) headline = `${byId[jobs[0].company_id].name} is hiring: ${jobs[0].title}`;
  else if (news.length) headline = news[0].title;
  if (headline) {
    const rest = [counts.roles && plural(counts.roles, 'new role'), counts.funding && plural(counts.funding, 'funding story', 'funding stories'),
                  counts.watch && plural(counts.watch, 'watchlist mention'), counts.events && plural(counts.events, 'event')].filter(Boolean);
    headline += rest.length ? ` — plus ${rest.join(', ')}.` : '.';
  } else headline = 'Quiet day: nothing new in your sectors since the last brief.';

  if (!dryRun) {
    for (let i = 0; i < shown.length; i += 50)
      await env.DB.batch(shown.slice(i, i + 50).map(k => env.DB.prepare('INSERT OR IGNORE INTO sent (key,sent_at) VALUES (?,?)').bind(k, now)));
    await setMeta(env, 'last_brief_at', now);
  }

  return {
    version: 2,
    generatedAt: now,
    date: new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
    since,
    headline,
    quiet: total === 0,
    counts,
    sections: sections.filter(s => s.items.length || s.id === 'roles'),
  };
}

/** Plain-text rendering, for email. */
export function briefToText(b) {
  const L = [`STARTUP RADAR — ${b.date}`, '', b.headline, ''];
  for (const s of b.sections) {
    L.push(`── ${s.title.toUpperCase()} ──`);
    if (s.lead) L.push(s.lead, '');
    for (const it of s.items) {
      L.push(`  • ${it.label}${it.stat ? `  [${it.stat}]` : ''}`);
      if (it.detail) L.push(`    ${it.detail}`);
      if (it.url)    L.push(`    ${it.url}`);
    }
    L.push('');
  }
  L.push(`Full radar: https://haydenterjeson99.github.io/startup-radar/`);
  return L.join('\n');
}
