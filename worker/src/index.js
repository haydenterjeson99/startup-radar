/* ============================================================
   startup-intel — competitive intelligence for the startup radar
   ------------------------------------------------------------
   One cron expression (every 5 min in hour 9 UTC) fires every five minutes
   during the 09:00 UTC hour. Each firing runs one stage, so no
   single invocation exceeds the free-plan request budget:

     09:00  feeds A        publisher RSS + search, part 1
     09:05  feeds B        publisher RSS + search, part 2 + watchlist names
     09:10  jobs           every watchlist job board
     09:15  events         Luma (SF) + sector calendars
     09:20  yc + brief     YC directory → landscape; brief on weekdays

   The site and the morning email only ever read what these
   stages stored, so a slow source never blocks a page load.
   ============================================================ */

import { resolveKey, fetchBatch } from './yc.js';
import { buildLandscape }         from './analyze.js';
import { buildBrief, briefToText, setMeta } from './brief.js';
import { collectFeedsA, collectFeedsB, collectJobs, collectEvents, isGtmRole } from './collect.js';
import { SEED, sniffAts, fetchJobs, mentionMatchers } from './watchlist.js';
import { FEED_TABS, SECTORS, ROLE_CORE, classifyLocation } from './sources.js';
import { monitorRoute, runMonitorStage, followToNotion } from './monitor.js';
import { runPrepareQueue, PREP_CRON } from './prepare.js';
import { runIntel, watchView, companyView, dealsByArticle, backfillCompany, ensureIntelSchema, slugify } from './intel.js';

const BATCH_ORDER = [
  'Fall 2026', 'Summer 2026', 'Spring 2026',
  'Winter 2026', 'Fall 2025', 'Summer 2025',
];
const DAY = 24 * 3600 * 1000;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Radar-Key',
};
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
});
const text = (s, status = 200) => new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });

/* ---------- small storage helpers ---------- */

async function getMeta(env, key) {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}

async function latestSnapshot(env) {
  const row = await env.DB.prepare('SELECT payload, taken_at FROM snapshots ORDER BY taken_at DESC LIMIT 1').first();
  if (!row) return null;
  try { return { ...JSON.parse(row.payload), takenAt: row.taken_at }; } catch { return null; }
}

const rowToWatch = r => ({ ...r, aliases: JSON.parse(r.aliases || '[]'), needsContext: !!r.needs_context, starred: !!r.starred, removed: !!r.removed });

/** Insert seed companies that have never been in the table, and keep
    the matching rules (aliases, job board) of seed rows in step with
    the code. Stars, removals and user-added rows are never touched. */
async function ensureWatchlist(env) {
  const now = Date.now();
  await env.DB.batch(SEED.map(w => env.DB.prepare(
    `INSERT INTO watchlist (id,name,sector,city,website,careers,ats,slug,aliases,needs_context,note,starred,origin,added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'seed',?)
     ON CONFLICT(id) DO UPDATE SET aliases=excluded.aliases, needs_context=excluded.needs_context,
       ats=COALESCE(watchlist.ats, excluded.ats), slug=COALESCE(watchlist.slug, excluded.slug)
     WHERE watchlist.origin = 'seed'`
  ).bind(w.id, w.name, w.sector, w.city, w.website, w.careers || null, w.ats, w.slug,
         JSON.stringify(w.aliases), w.needsContext ? 1 : 0, w.note || '', now)));
}

async function loadWatchlist(env, { includeRemoved = false } = {}) {
  await ensureWatchlist(env);
  const rows = (await env.DB.prepare(`SELECT * FROM watchlist ${includeRemoved ? '' : 'WHERE removed = 0'} ORDER BY starred DESC, name`).all()).results;
  return rows.map(rowToWatch);
}

/* ---------- YC (unchanged logic from v1) ---------- */

async function recordCompanies(env, companies) {
  const now  = Date.now();
  const seen = await env.DB.prepare('SELECT slug FROM companies').all();
  const known = new Set((seen?.results || []).map(r => r.slug));
  const fresh = companies.filter(c => c.slug && !known.has(c.slug));
  const firstRun = known.size === 0;
  for (let i = 0; i < fresh.length; i += 40) {
    await env.DB.batch(fresh.slice(i, i + 40).map(c => env.DB.prepare(
      `INSERT OR IGNORE INTO companies (slug,name,batch,one_liner,industries,tags,url,first_seen) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(c.slug, c.name, c.batch, c.oneLiner, JSON.stringify(c.industries), JSON.stringify(c.tags), c.url, now)));
  }
  return firstRun ? [] : fresh;
}

async function rebuildLandscape(env) {
  const key = await resolveKey();
  const batches = {};
  for (const b of BATCH_ORDER) {
    try { batches[b] = await fetchBatch(key, b); }
    catch (e) { batches[b] = []; console.warn('batch failed', b, e.message); }
  }
  const pulled = Object.values(batches).flat();
  if (!pulled.length) throw new Error('YC pull returned nothing — key may have rotated');

  const landscape = buildLandscape(batches, BATCH_ORDER);
  const fresh = await recordCompanies(env, pulled);
  landscape.freshCount = fresh.length;

  await env.DB.prepare('INSERT INTO snapshots (taken_at,payload) VALUES (?,?)').bind(Date.now(), JSON.stringify(landscape)).run();
  await env.DB.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY taken_at DESC LIMIT 90)').run();
  return landscape;
}

async function makeBrief(env, { dryRun = false } = {}) {
  const landscape = await latestSnapshot(env);
  const brief = await buildBrief(env, landscape, await loadWatchlist(env), { dryRun });
  if (!dryRun) await setMeta(env, 'brief', brief);
  return brief;
}

/* ---------- stages ---------- */

const STAGES = {
  feedsA: async env => collectFeedsA(env),
  feedsB: async env => collectFeedsB(env, await loadWatchlist(env)),
  jobs:   async env => collectJobs(env, await loadWatchlist(env)),
  events: async env => collectEvents(env),
  yc:     async env => { const l = await rebuildLandscape(env); return { current: l.current, fresh: l.freshCount }; },
  intel:  async env => runIntel(env, await loadWatchlist(env)),
};

async function runStage(env, name) {
  const started = Date.now();
  try {
    const out = await STAGES[name](env);
    await setMeta(env, `stage:${name}`, { ok: true, at: started, ms: Date.now() - started, ...out });
    return { ok: true, ...out };
  } catch (e) {
    await setMeta(env, `stage:${name}`, { ok: false, at: started, error: e.message });
    return { ok: false, error: e.message };
  }
}

const BY_MINUTE = { 0: 'feedsA', 5: 'feedsB', 10: 'jobs', 15: 'events', 20: 'yc' };
/* The intel store (intel.js) runs once everything else has landed. */
const INTEL_AT = { hour: 10, minute: 35 };

/* Private job monitor (monitor.js) on the free minutes after 20,
   plus the first half of hour 10 for Notion writes. Kept out of
   STAGES so /api/refresh and /api/sources never touch it. */
const MONITOR_BY_MINUTE = {
  9:  { 25: 'monitorSync', 30: 'monitorCheckA', 35: 'monitorCheckB', 40: 'monitorCheckC', 45: 'monitorCheckD', 50: 'monitorCheckE', 55: 'monitorWrite' },
  10: { 0: 'monitorWrite', 5: 'monitorWrite', 10: 'monitorWrite', 15: 'monitorWrite', 20: 'monitorWrite', 25: 'monitorWrite', 30: 'monitorWrite' },
};

/* Manual monitor run: the whole nightly pipeline on demand. Set it off
   with D1 (no passphrase needed):
     INSERT INTO meta (key,value) VALUES ('monitor:manual','{"step":0}')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value;
   Each two-minute firing then runs the next stage: sync, checkA–E, and
   write until the Notion queue is empty (at most 25 writes). Progress
   and per-stage results stay in meta 'monitor:manual'. */
const MANUAL_SEQ = ['monitorSync', 'monitorCheckA', 'monitorCheckB', 'monitorCheckC', 'monitorCheckD', 'monitorCheckE'];
async function manualMonitorStep(env) {
  const m = await getMeta(env, 'monitor:manual');
  if (!m || m.done || env.MONITOR_ENABLED !== 'all') return false;
  const step = m.step || 0;
  const writes = Math.max(0, step - MANUAL_SEQ.length);
  if (step >= MANUAL_SEQ.length) {
    const q = await env.DB.prepare('SELECT COUNT(*) n FROM monitor_queue WHERE tries < 5').first();
    if (!q?.n || writes >= 25) { await setMeta(env, 'monitor:manual', { ...m, done: true, finishedAt: Date.now(), queueLeft: q?.n || 0 }); return false; }
  }
  const name = MANUAL_SEQ[step] || 'monitorWrite';
  // Record the step before running it, so an overlapping firing moves on.
  await setMeta(env, 'monitor:manual', { ...m, step: step + 1, startedAt: m.startedAt || Date.now(), running: name });
  const r = await runMonitorStage(env, name).catch(e => ({ ok: false, error: e.message }));
  const cur = await getMeta(env, 'monitor:manual') || {};
  const summary = { stage: name, ok: r.ok !== false, error: r.error, boards: r.boards, newRoles: r.newRoles, closed: r.closed,
                    matches: r.matches, written: r.written, linked: r.linked?.length, held: r.held, approved: r.approved };
  await setMeta(env, 'monitor:manual', { ...cur, running: null, log: [...(cur.log || []), summary] });
  return true;
}

/* ---------- auth for writes ---------- */

function authorised(req, env) {
  return !!env.RADAR_KEY && req.headers.get('X-Radar-Key') === env.RADAR_KEY;
}

/* ---------- read models for the site ---------- */

async function articlesFeed(env, days = 30) {
  const rows = (await env.DB.prepare(
    `SELECT id,tab,tier,title,link,source,published_at,excerpt,sectors,bay,funding,first_seen
     FROM articles WHERE COALESCE(published_at, first_seen) > ? ORDER BY COALESCE(published_at, first_seen) DESC LIMIT 1200`
  ).bind(Date.now() - days * DAY).all()).results;
  return rows.map(a => ({ ...a, sectors: JSON.parse(a.sectors || '[]'), publishedAt: a.published_at || a.first_seen }));
}

async function bayArea(env) {
  const now = Date.now();
  const wl = await loadWatchlist(env);
  const byId = Object.fromEntries(wl.map(w => [w.id, w]));
  const matchers = mentionMatchers(wl);

  const jobs = (await env.DB.prepare(
    `SELECT * FROM jobs WHERE last_seen > ? ORDER BY core DESC, first_seen DESC`
  ).bind(now - 2 * DAY).all()).results.filter(j => byId[j.company_id])
    .map(j => ({ ...j, company: byId[j.company_id].name, isNew: !j.baseline && now - j.first_seen < 7 * DAY }));

  const arts = (await env.DB.prepare(
    `SELECT id,tab,tier,title,link,source,published_at,excerpt,sectors,bay,funding,first_seen FROM articles
     WHERE COALESCE(published_at, first_seen) > ? ORDER BY COALESCE(published_at, first_seen) DESC LIMIT 1500`
  ).bind(now - 30 * DAY).all()).results.map(a => {
    const sectors = JSON.parse(a.sectors || '[]');
    const blob = `${a.title} ${a.excerpt || ''}`;
    const mentions = matchers.filter(m => m.re.test(blob) && (!m.needsContext || sectors.length)).map(m => m.id);
    return { ...a, sectors, mentions, publishedAt: a.published_at || a.first_seen };
  });

  const counts = {};
  for (const j of jobs) counts[j.company_id] = (counts[j.company_id] || 0) + 1;
  const lastNews = {};
  for (const a of arts) for (const id of a.mentions) if (!lastNews[id]) lastNews[id] = { title: a.title, link: a.link, at: a.publishedAt };

  return {
    generatedAt: now,
    sectors: Object.fromEntries(Object.entries(SECTORS).map(([k, s]) => [k, s.label])),
    watchlist: wl.map(w => ({ ...w, gtmRoles: counts[w.id] || 0, lastNews: lastNews[w.id] || null })),
    jobs,
    mentions: arts.filter(a => a.mentions.length).slice(0, 80),
    // Bay Area raises in the three sectors and any watchlist deal are the
    // focus; other raises in the sectors ride along, flagged, below them.
    funding: (await withDeals(env, arts.filter(a => a.funding && (a.sectors.length || a.mentions.length)).slice(0, 120)))
      .map(a => ({ ...a, focus: !!(a.mentions.length || (a.sectors.length && (a.bay || a.deal?.bay))) })),
    events: (await env.DB.prepare('SELECT * FROM events WHERE start_at > ? ORDER BY start_at LIMIT 60').bind(now - 3 * 3600 * 1000).all()).results,
  };
}

async function withDeals(env, list) {
  const deals = await dealsByArticle(env, list.map(a => a.id)).catch(() => ({}));
  return list.map(a => ({ ...a, deal: deals[a.id] || null }));
}

/* ---------- watchlist writes ---------- */

async function upsertWatch(env, body) {
  const now = Date.now();
  const name = (body.name || '').trim().slice(0, 80);
  if (!name) return { error: 'name is required' };
  const id = body.id || slugify(name);
  const existing = await env.DB.prepare('SELECT * FROM watchlist WHERE id=?').bind(id).first();

  let ats = body.ats ?? existing?.ats ?? null, slug = body.slug ?? existing?.slug ?? null;
  let detected = null;
  const careers = (body.careers || existing?.careers || '').trim() || null;
  const website = (body.website || existing?.website || '').trim() || null;
  if (!ats && (careers || website)) {
    detected = await sniffAts(careers || website.replace(/\/$/, '') + '/careers');
    if (detected) ({ ats, slug } = detected);
  }

  const aliases = Array.isArray(body.aliases) && body.aliases.length ? body.aliases : (existing ? JSON.parse(existing.aliases || '[]') : [name]);
  await env.DB.prepare(
    `INSERT INTO watchlist (id,name,sector,city,website,careers,ats,slug,aliases,needs_context,note,starred,origin,removed,added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, sector=excluded.sector, city=excluded.city, website=excluded.website,
       careers=excluded.careers, ats=excluded.ats, slug=excluded.slug, aliases=excluded.aliases, note=excluded.note,
       starred=excluded.starred, removed=0`
  ).bind(id, name, body.sector || existing?.sector || 'geo', (body.city || existing?.city || '').slice(0, 60), website, careers,
         ats, slug, JSON.stringify(aliases), body.needsContext ? 1 : (existing?.needs_context || 0), (body.note ?? existing?.note ?? '').slice(0, 280),
         body.starred === undefined ? (existing ? existing.starred : 1) : (body.starred ? 1 : 0), existing?.origin || 'user', existing?.added_at || now).run();

  // Read the board straight away so the site shows roles now,
  // not tomorrow. These are a baseline, not "new".
  let roles = null;
  if (ats && slug) {
    try {
      const all = await fetchJobs(ats, slug);
      const keep = all.map(p => ({ ...p, ...classifyLocation(p.location, p.remote), core: ROLE_CORE.test(p.title) }))
        .filter(p => isGtmRole(p.title) && (p.bay || p.remote));
      const hadAny = await env.DB.prepare('SELECT 1 FROM jobs WHERE company_id=? LIMIT 1').bind(id).first();
      const stmts = keep.map(p => env.DB.prepare(
        `INSERT INTO jobs (id,company_id,title,location,dept,url,core,bay,remote,posted_at,first_seen,last_seen,baseline)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`
      ).bind(p.id, id, p.title, p.location, p.dept, p.url, p.core ? 1 : 0, p.bay ? 1 : 0, p.remote ? 1 : 0, p.postedAt || null, now, now, hadAny ? 0 : 1));
      stmts.push(env.DB.prepare('UPDATE watchlist SET open_roles=?, roles_checked=? WHERE id=?').bind(all.length, now, id));
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      roles = { total: all.length, gtm: keep.length };
    } catch (e) { roles = { error: e.message }; }
  }
  return { ok: true, id, ats, slug, detected: !!detected, roles };
}

/* ---------- CORS proxy (reader fallback) ---------- */

async function proxy(url) {
  if (!/^https?:\/\//i.test(url)) return text('bad url', 400);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/2.0)', 'Accept': '*/*' },
      cf: { cacheTtl: 600, cacheEverything: true } });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'text/plain', ...CORS } });
  } catch (e) { return text(`proxy error: ${e.message}`, 502); }
}

/* ---------- routes ---------- */

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === PREP_CRON) {   // Prepare to Apply queue; runs on its own cron
      // A manual monitor run, when one is requested, takes this firing
      // instead (each invocation has its own 50-request budget).
      ctx.waitUntil(manualMonitorStep(env).then(ran => ran ? null : runPrepareQueue(env))
        .catch(e => console.error('prepare queue / manual monitor failed', e.message)));
      return;
    }
    const d = new Date(event.scheduledTime);
    if (d.getUTCHours() === INTEL_AT.hour && d.getUTCMinutes() === INTEL_AT.minute) {
      ctx.waitUntil(runStage(env, 'intel').then(r => { if (!r.ok) console.error('intel failed', r.error); }));
      return;
    }
    const mon = MONITOR_BY_MINUTE[d.getUTCHours()]?.[d.getUTCMinutes()];
    if (mon) {
      if (env.MONITOR_ENABLED !== 'all') return;   // off until launch
      ctx.waitUntil(runMonitorStage(env, mon).catch(async e => {
        console.error('monitor stage failed', mon);
        await setMeta(env, `monitor:${mon}`, { ok: false, at: Date.now(), error: e.message });
      }));
      return;
    }
    const stage = d.getUTCHours() === 9 ? BY_MINUTE[d.getUTCMinutes()] : null;
    if (!stage) return;
    ctx.waitUntil((async () => {
      const r = await runStage(env, stage);
      if (!r.ok) console.error('stage failed', stage, r.error);
      // Brief only on weekdays — the email only goes out Mon–Fri, and
      // building it is what marks items as shown. Monday's brief
      // therefore covers the whole weekend.
      if (stage === 'yc' && d.getUTCDay() >= 1 && d.getUTCDay() <= 5) {
        try { await makeBrief(env); } catch (e) { console.error('brief failed', e); await setMeta(env, 'stage:brief', { ok: false, at: Date.now(), error: e.message }); }
      }
    })());
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const target = url.searchParams.get('url');
    if (target) return proxy(target);

    try {
      switch (url.pathname) {
        case '/api/landscape': {
          const snap = await latestSnapshot(env);
          if (!snap) return json({ error: 'no snapshot yet' }, 503);
          return json(snap, 200, { 'Cache-Control': 'public, max-age=900' });
        }
        case '/api/brief': {
          const b = await getMeta(env, 'brief');
          if (!b) return json({ error: 'no brief yet' }, 503);
          return json(b, 200, { 'Cache-Control': 'public, max-age=300' });
        }
        case '/api/brief.txt': {
          const b = await getMeta(env, 'brief');
          if (!b) return text('no brief yet', 503);
          return text(briefToText(b));
        }
        case '/api/brief/preview':
          // What tomorrow's brief would contain right now; marks nothing as sent.
          return json(await makeBrief(env, { dryRun: true }));

        case '/api/articles':
          return json({ tabs: FEED_TABS, articles: await articlesFeed(env, Math.min(+url.searchParams.get('days') || 30, 60)) },
                      200, { 'Cache-Control': 'public, max-age=300' });

        case '/api/bayarea':
          return json(await bayArea(env), 200, { 'Cache-Control': 'no-store' });

        case '/api/watch':
          return json(await watchView(env, await loadWatchlist(env), Object.fromEntries(Object.entries(SECTORS).map(([k, s]) => [k, s.label]))),
                      200, { 'Cache-Control': 'no-store' });

        case '/api/company': {
          const id = url.searchParams.get('id') || '';
          const w = (await loadWatchlist(env)).find(x => x.id === id) || null;
          const v = await companyView(env, id, w);
          return v ? json(v, 200, { 'Cache-Control': 'no-store' }) : json({ error: 'unknown company' }, 404);
        }

        case '/api/suggestions': {
          if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
          if (!authorised(req, env)) return json({ error: 'wrong or missing passphrase' }, 401);
          await ensureIntelSchema(env);
          const b = await req.json().catch(() => ({}));
          const org = await env.DB.prepare('SELECT * FROM orgs WHERE id=?').bind(b.id || '').first();
          if (!org) return json({ error: 'unknown company' }, 404);
          if (b.action === 'dismiss') {
            await env.DB.prepare(`UPDATE suggestions SET status='dismissed', updated_at=? WHERE org_id=?`).bind(Date.now(), org.id).run();
            return json({ ok: true });
          }
          if (b.action !== 'follow') return json({ error: 'action must be follow or dismiss' }, 400);
          const sectors = JSON.parse(org.sectors || '[]');
          const r = await upsertWatch(env, { id: org.id, name: org.name, website: org.website || '', city: org.city || '',
            sector: sectors[0] || 'geo', note: org.one_liner || '', starred: true,
            ...(org.ats ? { ats: org.ats, slug: org.ats_slug } : {}) });
          if (r.error) return json(r, 400);
          await env.DB.prepare(`UPDATE suggestions SET status='followed', updated_at=? WHERE org_id=?`).bind(Date.now(), org.id).run();
          const w = (await loadWatchlist(env)).find(x => x.id === org.id);
          if (w) { r.jobList = await followToNotion(env, w); r.news = await backfillCompany(env, w); }
          return json(r);
        }

        case '/api/sources': {
          const rows = (await env.DB.prepare(`SELECT key, value FROM meta WHERE key LIKE 'stage:%'`).all()).results;
          return json(Object.fromEntries(rows.map(r => [r.key.slice(6), JSON.parse(r.value)])));
        }

        case '/api/watchlist': {
          if (req.method === 'GET') return json({ watchlist: await loadWatchlist(env, { includeRemoved: url.searchParams.has('all') }) });
          if (!env.RADAR_KEY) return json({ error: 'RADAR_KEY secret is not set on the worker' }, 503);
          if (!authorised(req, env)) return json({ error: 'wrong or missing passphrase' }, 401);
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({}));
            if (body.action === 'star') {
              await env.DB.prepare('UPDATE watchlist SET starred=? WHERE id=?').bind(body.starred ? 1 : 0, body.id).run();
              let jobList = null;
              if (body.starred) {
                const w = (await loadWatchlist(env)).find(x => x.id === body.id);
                if (w) jobList = await followToNotion(env, w);
              }
              return json({ ok: true, jobList });
            }
            const r = await upsertWatch(env, body);
            if (!r.error) {
              const w = (await loadWatchlist(env)).find(x => x.id === r.id);
              if (w) r.jobList = await followToNotion(env, w);   // every Radar company is also in the Job Database
              if (w) r.news = await backfillCompany(env, w).catch(() => 0);
            }
            return json(r, r.error ? 400 : 200);
          }
          if (req.method === 'DELETE') {
            await env.DB.prepare('UPDATE watchlist SET removed=1, starred=0 WHERE id=?').bind(url.searchParams.get('id')).run();
            return json({ ok: true });
          }
          return json({ error: 'method not allowed' }, 405);
        }

        case '/api/auth':
          return json({ ok: authorised(req, env), configured: !!env.RADAR_KEY }, authorised(req, env) ? 200 : 401);

        /* Dismissed feed cards (was on the shared NSL proxy). */
        case '/api/feedback': {
          if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
          const b = await req.json().catch(() => ({}));
          if (!b.articleId || !b.deviceId) return json({ error: 'articleId and deviceId required' }, 400);
          if (b.dismissed) await env.DB.prepare('INSERT OR IGNORE INTO dismissals (device_id,article_id,at) VALUES (?,?,?)').bind(String(b.deviceId).slice(0, 64), String(b.articleId).slice(0, 32), Date.now()).run();
          return json({ ok: true });
        }
        case '/api/state': {
          const dev = url.searchParams.get('device') || '';
          const rows = (await env.DB.prepare('SELECT article_id FROM dismissals WHERE device_id=?').bind(dev).all()).results;
          return json({ mine: rows.map(r => ({ article_id: r.article_id, dismissed: 1 })) });
        }

        case '/api/refresh': {
          // Stage runs are cheap to trigger by accident, so they need the key.
          if (!authorised(req, env)) return json({ error: 'needs passphrase (X-Radar-Key header)' }, 401);
          const stage = url.searchParams.get('stage');
          if (stage === 'brief') return json(await makeBrief(env));
          if (!STAGES[stage]) return json({ error: `stage must be one of ${Object.keys(STAGES).join(', ')}, brief` }, 400);
          return json(await runStage(env, stage));
        }

        case '/api/monitor':
          // Private job monitor. Every action needs the key.
          if (!authorised(req, env)) return json({ error: 'needs passphrase (X-Radar-Key header)' }, 401);
          return json(await monitorRoute(env, url, req), 200, { 'Cache-Control': 'no-store' });

        case '/health':
          return json({ ok: true, service: 'startup-intel', version: 2 });

        default:
          return text('startup-intel v2. Routes: /api/brief /api/brief.txt /api/brief/preview /api/landscape /api/articles /api/bayarea /api/watch /api/company /api/suggestions /api/watchlist /api/sources /health');
      }
    } catch (e) {
      console.error(e);
      return json({ error: e.message }, 500);
    }
  },
};
