/* ============================================================
   startup-intel — competitive intelligence for the startup radar
   ------------------------------------------------------------
   Nightly cron pulls the YC directory, recomputes the landscape,
   diffs it against the last run and stores a snapshot. The site
   and the morning brief both read from that snapshot, so a slow
   or rate-limited YC never blocks a page load.
   ============================================================ */

import { resolveKey, fetchBatch } from './yc.js';
import { buildLandscape }         from './analyze.js';
import { fetchNews }              from './news.js';
import { buildBrief, briefToText } from './brief.js';

/* Batches to pull, most recent first. Six covers a full year of
   comparison without blowing the cron's CPU budget. */
const BATCH_ORDER = [
  'Fall 2026', 'Summer 2026', 'Spring 2026',
  'Winter 2026', 'Fall 2025', 'Summer 2025',
];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
});

const text = (s, status = 200) => new Response(s, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
});

/* ---------- snapshot storage ---------- */

async function latestSnapshot(env) {
  const row = await env.DB.prepare(
    'SELECT payload, taken_at FROM snapshots ORDER BY taken_at DESC LIMIT 1'
  ).first();
  if (!row) return null;
  try { return { ...JSON.parse(row.payload), takenAt: row.taken_at }; }
  catch { return null; }
}

async function previousSnapshot(env) {
  const rows = await env.DB.prepare(
    'SELECT payload FROM snapshots ORDER BY taken_at DESC LIMIT 2'
  ).all();
  const r = rows?.results?.[1];
  if (!r) return null;
  try { return JSON.parse(r.payload); } catch { return null; }
}

/**
 * Record every company we've seen and report the ones that are new.
 * first_seen is set once and never updated, so "new" means new to us,
 * which is the only honest claim we can make from a directory that
 * carries no created-at field.
 */
async function recordCompanies(env, companies) {
  const now  = Date.now();
  const seen = await env.DB.prepare('SELECT slug FROM companies').all();
  const known = new Set((seen?.results || []).map(r => r.slug));
  const fresh = companies.filter(c => c.slug && !known.has(c.slug));

  // First ever run: everything is "new", which is noise. Record silently.
  const firstRun = known.size === 0;

  for (let i = 0; i < fresh.length; i += 40) {
    const chunk = fresh.slice(i, i + 40);
    await env.DB.batch(chunk.map(c => env.DB.prepare(
      `INSERT OR IGNORE INTO companies
         (slug,name,batch,one_liner,industries,tags,url,first_seen)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(c.slug, c.name, c.batch, c.oneLiner,
           JSON.stringify(c.industries), JSON.stringify(c.tags), c.url, now)));
  }
  return firstRun ? [] : fresh;
}

/* ---------- the nightly build ---------- */

export async function rebuild(env) {
  const key = await resolveKey();

  const batches = {};
  for (const b of BATCH_ORDER) {
    try { batches[b] = await fetchBatch(key, b); }
    catch (e) { batches[b] = []; console.warn('batch failed', b, e.message); }
  }

  const pulled = Object.values(batches).flat();
  if (!pulled.length) throw new Error('YC pull returned nothing — key may have rotated');

  const landscape = buildLandscape(batches, BATCH_ORDER);
  const fresh     = await recordCompanies(env, pulled);
  const prev      = await latestSnapshot(env);
  const news      = await fetchNews().catch(() => []);

  landscape.news       = news.slice(0, 40);
  landscape.freshCount = fresh.length;
  landscape.brief      = buildBrief(landscape, prev, news, fresh);

  await env.DB.prepare('INSERT INTO snapshots (taken_at,payload) VALUES (?,?)')
    .bind(Date.now(), JSON.stringify(landscape)).run();

  // Keep a rolling 90 snapshots; the deltas only ever look back one.
  await env.DB.prepare(
    'DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY taken_at DESC LIMIT 90)'
  ).run();

  return landscape;
}

/* ---------- CORS proxy, so the page has one origin ---------- */

async function proxy(url) {
  if (!/^https?:\/\//i.test(url)) return text('bad url', 400);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/1.0)', 'Accept': '*/*' },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'text/plain', ...CORS },
    });
  } catch (e) { return text(`proxy error: ${e.message}`, 502); }
}

/* ---------- routes ---------- */

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(rebuild(env).catch(e => console.error('cron rebuild failed', e)));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const target = url.searchParams.get('url');
    if (target) return proxy(target);

    switch (url.pathname) {
      case '/api/landscape': {
        const snap = await latestSnapshot(env);
        if (!snap) return json({ error: 'no snapshot yet — call /api/refresh' }, 503);
        return json(snap, 200, { 'Cache-Control': 'public, max-age=900' });
      }

      case '/api/brief': {
        const snap = await latestSnapshot(env);
        if (!snap?.brief) return json({ error: 'no brief yet' }, 503);
        return json(snap.brief, 200, { 'Cache-Control': 'public, max-age=900' });
      }

      case '/api/brief.txt': {
        const snap = await latestSnapshot(env);
        if (!snap?.brief) return text('no brief yet', 503);
        return text(briefToText(snap.brief));
      }

      case '/api/refresh': {
        try { const l = await rebuild(env); return json({ ok: true, current: l.current, fresh: l.freshCount }); }
        catch (e) { return json({ ok: false, error: e.message }, 500); }
      }

      case '/health':
        return json({ ok: true, service: 'startup-intel' });

      default:
        return text('startup-intel. Routes: /api/landscape /api/brief /api/brief.txt /api/refresh /?url=');
    }
  },
};
