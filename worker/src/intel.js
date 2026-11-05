/* ============================================================
   intel.js — the company intel store
   ------------------------------------------------------------
   Everything the radar scrapes is thrown away after a while
   (articles at 60 days, jobs at 30). This module keeps what is
   worth keeping, per company, forever, so a company's history
   builds up night after night instead of starting from zero:

     orgs         every company seen anywhere: watchlist, YC,
                  funding headlines. One row per company.
     org_news     every story that named a company (copy of the
                  headline, so it survives article pruning)
     rounds       funding rounds, acquisitions and listings
                  parsed out of headlines — company, round,
                  amount, valuation, investors
     org_daily    one row per company per night: open roles and
                  GTM roles, which is what the growth charts read
     suggestions  companies worth adding to the watchlist, with
                  the reasons, and whether Hayden followed or
                  dismissed them

   No model writes anything here. Every value comes from a
   headline, a job board or the YC directory by fixed rules, so
   it can be wrong (a headline parsed badly) but never invented.
   ============================================================ */

import { SECTORS, BAY_AREA, ROLE_CORE, classifyLocation } from './sources.js';
import { mentionMatchers, fetchJobs, sniffAts } from './watchlist.js';
import { resolveKey, fetchBatch } from './yc.js';
import { isGtmRole } from './collect.js';

const DAY = 24 * 3600 * 1000;
export const slugify = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const dayKey = ts => new Date(ts).toISOString().slice(0, 10);
const J = (s, d = []) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/* ---------- schema (also in schema.sql) ---------- */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orgs (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT, city TEXT, bay INTEGER DEFAULT 0,
     sectors TEXT, one_liner TEXT, yc_slug TEXT, yc_batch TEXT, team_size INTEGER, yc_hiring INTEGER DEFAULT 0,
     ats TEXT, ats_slug TEXT, open_roles INTEGER, gtm_roles INTEGER, gtm_titles TEXT, roles_checked INTEGER,
     sources TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS org_news (
     org_id TEXT NOT NULL, article_id TEXT NOT NULL, title TEXT, link TEXT, source TEXT,
     published_at INTEGER, funding INTEGER DEFAULT 0, PRIMARY KEY (org_id, article_id))`,
  `CREATE INDEX IF NOT EXISTS idx_org_news_org ON org_news(org_id, published_at DESC)`,
  `CREATE TABLE IF NOT EXISTS rounds (
     id TEXT PRIMARY KEY, org_id TEXT NOT NULL, org_name TEXT, kind TEXT, amount_usd INTEGER, valuation_usd INTEGER,
     investors TEXT, acquirer TEXT, article_id TEXT, title TEXT, link TEXT, source TEXT,
     announced_at INTEGER, bay INTEGER DEFAULT 0, sectors TEXT, first_seen INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_rounds_org ON rounds(org_id, announced_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rounds_article ON rounds(article_id)`,
  `CREATE TABLE IF NOT EXISTS org_daily (
     org_id TEXT NOT NULL, day TEXT NOT NULL, open_roles INTEGER, gtm_roles INTEGER, PRIMARY KEY (org_id, day))`,
  `CREATE TABLE IF NOT EXISTS suggestions (
     org_id TEXT PRIMARY KEY, reasons TEXT, score REAL, status TEXT NOT NULL DEFAULT 'open',
     first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
];
let schemaReady = false;
export async function ensureIntelSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  schemaReady = true;
}

/* ---------- funding headline parser ----------
   Headlines follow a handful of shapes:
     "Northwood Space raises $375M Series C at $2B valuation from a16z"
     "Defense tech startup Colare raises $2.5M to …"
     "Exclusive: Numeracle Raises $28M To …"
     "CoStar Group announces intent to acquire Vexcel"
     "Dronamics to Go Public on Nasdaq Through Merger"
   Anything that doesn't fit one of them is skipped rather than
   guessed at. */

const RAISE_VERB = /\s(raises|raised|raise|secures|secured|lands|landed|nabs|bags|closes|closed|gets|receives|snags|pulls in|banks|picks up|scores|announces|completes|comes out of stealth|emerges from stealth|launches with)\s/i;
const DESCRIPTOR = /^.*\b(startup|start-up|company|firm|maker|developer|provider|platform|unicorn|specialist|operator|builder|pioneer|innovator|leader|player)\s+/i;
const NOT_A_COMPANY = /^(the|a|an|this|these|investors?|vcs?|report|exclusive|watch|why|how|what|who|most|top|\d+|week|weekly|daily|funding|venture|global|china|india|europe|us|u\.s\.|uk|air force|army|navy|space force|pentagon|nasa|dod|government|congress|state|city|county)\b/i;
const PREFIX = /^(exclusive|scoop|breaking|update|report|first look|deal|funding|fundraise|startup|news)\s*[:|—–-]\s*/i;

function money(str) {
  const m = str.match(/([$€£])\s?(\d+(?:[.,]\d+)?)\s?(billion|bn|b|million|mn|m|thousand|k)?\b/i);
  if (!m) return null;
  const n = parseFloat(m[2].replace(',', '.'));
  const unit = (m[3] || '').toLowerCase();
  const mult = /^b/.test(unit) ? 1e9 : /^m/.test(unit) ? 1e6 : /^(k|t)/.test(unit) ? 1e3 : 1;
  const fx = m[1] === '€' ? 1.08 : m[1] === '£' ? 1.27 : 1;
  const usd = Math.round(n * mult * fx);
  return usd >= 50000 ? { usd, at: m.index, len: m[0].length } : null;
}

function cleanName(raw) {
  let s = (raw || '').replace(PREFIX, '').replace(/[“”"']/g, '').trim();
  s = s.split(/,\s| — | – | - /)[0].trim();                 // "Acme, a robotics startup, raises"
  s = s.replace(DESCRIPTOR, '').trim();                       // "AI inference startup Fal"
  s = s.replace(/^(stealth|stealthy|ex-[\w]+|yc-backed|a16z-backed|[\w-]+-backed|[\w-]+-based)\s+/i, '').trim();
  s = s.replace(/[’']s$/i, '').trim();
  const words = s.split(/\s+/);
  if (!s || words.length > 5 || s.length > 48) return null;
  if (!/^[A-Z0-9]/.test(s) || NOT_A_COMPANY.test(s)) return null;
  if (words.filter(w => /^[a-z]/.test(w) && !/^(of|and|for|the|de|by|&|labs?|ai)$/.test(w)).length) return null;
  return s;
}

function roundKind(t) {
  const m = t.match(/\b(pre-seed|seed|series [a-h])\b/i);
  if (m) return m[1].toLowerCase().replace(/^series /, 'Series ').replace(/series ([a-h])/i, (_, l) => `Series ${l.toUpperCase()}`).replace(/^pre-seed$/, 'Pre-seed').replace(/^seed$/, 'Seed');
  if (/\b(growth round|growth equity)\b/i.test(t)) return 'Growth';
  if (/\b(debt|credit facility|loan)\b/i.test(t)) return 'Debt';
  if (/\b(grant|contract|award)\b/i.test(t) && !/raise|round/i.test(t)) return 'Contract';
  return 'Round';
}

function investorsOf(t) {
  const m = t.match(/\b(?:led by|from|backed by|with backing from)\s+([A-Za-z0-9][\w&.'’-]*(?:\s+[A-Z0-9][\w&.'’-]*){0,3}(?:(?:,\s*|\s+and\s+|\s*&\s*)[A-Za-z0-9][\w&.'’-]*(?:\s+[A-Z0-9][\w&.'’-]*){0,3}){0,4})/);
  if (!m) return null;
  const list = m[1].split(/,\s*|\s+and\s+|\s*&\s*/).map(x => x.trim()).filter(x => x && !/^(investors?|vcs?|a|the|others?)$/i.test(x));
  return list.length ? list.slice(0, 6) : null;
}

/** One parsed deal per headline, or null. */
export function parseDeal(title) {
  const t = (title || '').replace(/\s+/g, ' ').trim();

  // Acquisitions: the company that was bought is the subject.
  let m = t.match(/^(.+?)\s(?:acquires|has acquired|to acquire|will acquire|agrees to (?:buy|acquire)|announces (?:intent|plans|agreement) to acquire|buys|snaps up|scoops up)\s(.+?)(?:\s(?:for|in|to|as|amid|after|from)\s.*)?$/i);
  if (m) {
    const target = cleanName(m[2]), acquirer = cleanName(m[1]);
    if (target) return { name: target, kind: 'Acquired', acquirer, amount: money(t)?.usd || null };
  }
  m = t.match(/^(.+?)\s(?:acquired by|bought by|to be acquired by|agrees to be acquired by)\s(.+?)(?:\s(?:for|in)\s.*)?$/i);
  if (m && cleanName(m[1])) return { name: cleanName(m[1]), kind: 'Acquired', acquirer: cleanName(m[2]), amount: money(t)?.usd || null };

  // Listings.
  m = t.match(/^(.+?)\s(?:to go public|goes public|files (?:for|to go) public|files for (?:an )?IPO|prices IPO|to list on|lists on|to debut on)\b/i);
  if (m && cleanName(m[1])) return { name: cleanName(m[1]), kind: 'IPO', amount: money(t)?.usd || null };

  // Raises.
  const v = t.match(RAISE_VERB);
  if (!v) return null;
  const name = cleanName(t.slice(0, v.index));
  if (!name) return null;
  const after = t.slice(v.index);
  if (/\$[\d.,]+\s?\w*\s+(new\s+|debut\s+|second\s+|third\s+)?(venture\s+)?funds?\b|\bfund (i|ii|iii|iv|v|vi)\b/i.test(after)) return null;   // a VC raising a fund
  let rest = after, valuation = null;
  const val = after.match(/(?:at an?|at|valued at|valuation of|post-money of)\s([$€£]\s?[\d.,]+\s?(?:billion|bn|b|million|mn|m)?)\s?(?:post-money\s)?(?:valuation)?/i);
  if (val) { valuation = money(val[1])?.usd || null; rest = after.replace(val[0], ' '); }
  const amt = money(rest);
  if (!amt && !/\b(pre-seed|seed|series [a-h]|round|funding|stealth)\b/i.test(after)) return null;
  return { name, kind: roundKind(after), amount: amt?.usd || null, valuation, investors: investorsOf(after) };
}

/* ---------- org helpers ---------- */

function mergeSources(a, b) { return JSON.stringify([...new Set([...J(a), ...b])]); }

/** Upsert one org; fields left undefined are not overwritten. */
function orgStmt(env, o, now) {
  return env.DB.prepare(
    `INSERT INTO orgs (id,name,website,city,bay,sectors,one_liner,yc_slug,yc_batch,team_size,yc_hiring,sources,first_seen,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       website=COALESCE(orgs.website, excluded.website), city=COALESCE(NULLIF(excluded.city,''), orgs.city),
       bay=MAX(orgs.bay, excluded.bay),
       sectors=CASE WHEN excluded.sectors IS NOT NULL AND excluded.sectors!='[]' THEN excluded.sectors ELSE orgs.sectors END,
       one_liner=COALESCE(NULLIF(excluded.one_liner,''), orgs.one_liner),
       yc_slug=COALESCE(excluded.yc_slug, orgs.yc_slug), yc_batch=COALESCE(excluded.yc_batch, orgs.yc_batch),
       team_size=COALESCE(excluded.team_size, orgs.team_size), yc_hiring=COALESCE(excluded.yc_hiring, orgs.yc_hiring),
       sources=excluded.sources, last_seen=excluded.last_seen`
  ).bind(o.id, o.name, o.website || null, o.city || '', o.bay ? 1 : 0, JSON.stringify(o.sectors || []), o.oneLiner || '',
         o.ycSlug || null, o.ycBatch || null, o.teamSize ?? null, o.ycHiring == null ? null : (o.ycHiring ? 1 : 0),
         o.sources, now, now);
}

async function chunked(env, stmts, size = 80) {
  for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size));
}

const sectorsOf = blob => Object.entries(SECTORS).filter(([, s]) => s.re.test(blob)).map(([k]) => k);

/* ---------- the nightly intel stage ----------
   Runs after the jobs and YC stages. Roughly 3 YC requests plus up
   to ~36 job-board probes, well under the 50-request budget. */

export async function runIntel(env, watchlist) {
  await ensureIntelSchema(env);
  const now = Date.now();
  const report = {};
  const existing = Object.fromEntries(((await env.DB.prepare('SELECT id, sources FROM orgs').all()).results || []).map(r => [r.id, r.sources]));
  const stmts = [];

  // 1. Watchlist companies are orgs too (id shared with the watchlist).
  for (const w of watchlist) {
    stmts.push(orgStmt(env, { id: w.id, name: w.name, website: w.website, city: w.city, bay: BAY_AREA.test(w.city || ''),
      sectors: [w.sector].filter(Boolean), oneLiner: w.note, sources: mergeSources(existing[w.id], ['watchlist']) }, now));
    existing[w.id] = existing[w.id] || '["watchlist"]';
  }

  // 2. Recent YC batches, sector matches only.
  let yc = [];
  try {
    const key = await resolveKey();
    const snap = await env.DB.prepare('SELECT payload FROM snapshots ORDER BY taken_at DESC LIMIT 1').first();
    const l = J(snap?.payload, {});
    const batches = [l.current, l.prior].filter(Boolean);
    if (!batches.length) batches.push('Fall 2026', 'Summer 2026');
    for (const b of batches) yc.push(...(await fetchBatch(key, b)));
  } catch (e) { report.ycError = e.message; }
  const ycMatched = yc.map(c => ({ c, sectors: sectorsOf(`${c.oneLiner} ${c.tags.join(' ')}`) }))
    .filter(x => x.sectors.length && x.c.status !== 'Inactive');
  for (const { c, sectors } of ycMatched) {
    const id = slugify(c.name);
    stmts.push(orgStmt(env, { id, name: c.name, website: c.website, city: c.location, bay: BAY_AREA.test(c.location),
      sectors, oneLiner: c.oneLiner, ycSlug: c.slug, ycBatch: c.batch, teamSize: c.teamSize || null, ycHiring: c.isHiring,
      sources: mergeSources(existing[id], ['yc']) }, now));
    existing[id] = existing[id] || '["yc"]';
  }
  report.yc = ycMatched.length;

  // 3. News and funding from articles not yet processed (all of them the first time).
  const since = J((await env.DB.prepare(`SELECT value FROM meta WHERE key='intel:articlesThrough'`).first())?.value, 0) || 0;
  const arts = (await env.DB.prepare(
    `SELECT id,title,link,source,excerpt,published_at,first_seen,sectors,bay,funding FROM articles WHERE first_seen > ? ORDER BY first_seen`
  ).bind(since).all()).results || [];
  const matchers = mentionMatchers(watchlist);
  let nNews = 0, nRounds = 0;
  for (const a of arts) {
    const sectors = J(a.sectors), blob = `${a.title} ${a.excerpt || ''}`, at = a.published_at || a.first_seen;
    const hits = matchers.filter(m => m.re.test(blob) && (!m.needsContext || sectors.length)).map(m => m.id);
    const deal = a.funding ? parseDeal(a.title) : null;
    let dealOrg = null;
    if (deal) {
      // A watchlist company named as the subject keeps its own id.
      const own = matchers.find(m => m.re.test(deal.name));
      dealOrg = own ? own.id : slugify(deal.name);
      if (!own) {
        stmts.push(orgStmt(env, { id: dealOrg, name: deal.name, bay: !!a.bay, sectors, sources: mergeSources(existing[dealOrg], ['funding']) }, now));
        existing[dealOrg] = existing[dealOrg] || '["funding"]';
      }
      const month = dayKey(at).slice(0, 7);
      stmts.push(env.DB.prepare(
        `INSERT INTO rounds (id,org_id,org_name,kind,amount_usd,valuation_usd,investors,acquirer,article_id,title,link,source,announced_at,bay,sectors,first_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET amount_usd=COALESCE(rounds.amount_usd, excluded.amount_usd),
           valuation_usd=COALESCE(rounds.valuation_usd, excluded.valuation_usd), investors=COALESCE(rounds.investors, excluded.investors),
           bay=MAX(rounds.bay, excluded.bay)`
      ).bind(`${dealOrg}:${deal.kind}:${month}`, dealOrg, deal.name, deal.kind, deal.amount, deal.valuation || null,
             deal.investors ? JSON.stringify(deal.investors) : null, deal.acquirer || null, a.id, a.title, a.link, a.source,
             at, a.bay ? 1 : 0, a.sectors || '[]', now));
      nRounds++;
    }
    for (const id of new Set([...hits, ...(dealOrg ? [dealOrg] : [])])) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO org_news (org_id,article_id,title,link,source,published_at,funding) VALUES (?,?,?,?,?,?,?)`
      ).bind(id, a.id, a.title, a.link, a.source, at, a.funding ? 1 : 0));
      nNews++;
    }
  }
  await chunked(env, stmts);
  if (arts.length) await env.DB.prepare(`INSERT INTO meta (key,value) VALUES ('intel:articlesThrough',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .bind(JSON.stringify(arts[arts.length - 1].first_seen)).run();
  Object.assign(report, { articles: arts.length, news: nNews, rounds: nRounds });

  // 4. Tonight's hiring numbers for every watchlist company with a board.
  report.daily = await recordDaily(env, watchlist, now);

  // 5. Suggestions, then probe the best candidates' job boards.
  report.suggestions = await buildSuggestions(env, watchlist, now);
  report.probed = await probeCandidates(env, now);
  report.suggestions = await buildSuggestions(env, watchlist, now);   // again, now with hiring signal
  return report;
}

/* ---------- daily hiring snapshot (+ one-off backfill from the jobs table) ---------- */

async function recordDaily(env, watchlist, now) {
  const today = dayKey(now);
  const gtm = Object.fromEntries(((await env.DB.prepare(
    'SELECT company_id, COUNT(*) n FROM jobs WHERE last_seen > ? GROUP BY company_id').bind(now - 2 * DAY).all()).results || []).map(r => [r.company_id, r.n]));
  const boards = watchlist.filter(w => w.ats && w.slug && w.roles_checked);
  const stmts = boards.map(w => env.DB.prepare(
    `INSERT INTO org_daily (org_id,day,open_roles,gtm_roles) VALUES (?,?,?,?)
     ON CONFLICT(org_id,day) DO UPDATE SET open_roles=excluded.open_roles, gtm_roles=excluded.gtm_roles`
  ).bind(w.id, today, w.open_roles ?? null, gtm[w.id] || 0));

  // First run: rebuild the last 30 days of GTM-role counts from
  // first_seen/last_seen so the charts don't start empty.
  const have = new Set(((await env.DB.prepare('SELECT DISTINCT org_id FROM org_daily').all()).results || []).map(r => r.org_id));
  const fresh = boards.filter(w => !have.has(w.id)).map(w => w.id);
  if (fresh.length) {
    const jobs = (await env.DB.prepare(`SELECT company_id, first_seen, last_seen FROM jobs WHERE company_id IN (${fresh.map(() => '?').join(',')})`)
      .bind(...fresh).all()).results || [];
    for (const id of fresh) {
      const mine = jobs.filter(j => j.company_id === id);
      if (!mine.length) continue;
      const start = Math.min(...mine.map(j => j.first_seen));
      for (let t = Math.max(start, now - 30 * DAY); t < now - DAY / 2; t += DAY) {
        const end = t + DAY;
        const n = mine.filter(j => j.first_seen < end && j.last_seen >= t).length;
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO org_daily (org_id,day,open_roles,gtm_roles) VALUES (?,?,NULL,?)').bind(id, dayKey(t), n));
      }
    }
  }
  await chunked(env, stmts);
  return stmts.length;
}

/* ---------- suggestions ----------
   Four signals, each worth points, summed:
     funded   raised in the last 120 days, Bay Area, in a sector   +3
     yc       in a recent YC batch, in a sector                    +2  (+1 Bay Area)
     like     description close to companies Hayden follows        +0–2.5
     hiring   GTM / RevOps roles open on its board                 +2  (YC "hiring" flag +0.5)
   Companies already on the watchlist (or removed from it) and
   dismissed suggestions are never suggested. */

const STOP = new Set('the and for with from that this into your their our its are was were has have will can all any more most over under about using based built build builds platform company startup software data solutions solution technology technologies services service ai first new help helps helping make makes enable enables world global inc labs'.split(' '));
const tokens = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));

async function buildSuggestions(env, watchlist, now) {
  const all = (await env.DB.prepare('SELECT id, name, website, city, bay, sectors, one_liner, yc_batch, yc_hiring, gtm_roles, gtm_titles, sources FROM orgs').all()).results || [];
  const onList = new Set((await env.DB.prepare('SELECT id FROM watchlist').all()).results.map(r => r.id));
  const status = Object.fromEntries(((await env.DB.prepare('SELECT org_id, status, first_seen FROM suggestions').all()).results || []).map(r => [r.org_id, r]));
  const rounds = (await env.DB.prepare('SELECT org_id, kind, amount_usd, announced_at, bay, sectors FROM rounds WHERE announced_at > ? ORDER BY announced_at DESC').bind(now - 120 * DAY).all()).results || [];
  const lastRound = {};
  for (const r of rounds) if (!lastRound[r.org_id]) lastRound[r.org_id] = r;

  const followed = watchlist.filter(w => w.starred);
  const profile = (followed.length ? followed : watchlist).map(w => ({ name: w.name, sector: w.sector, t: tokens(`${w.note} ${w.name}`) }));
  const snap = await env.DB.prepare('SELECT payload FROM snapshots ORDER BY taken_at DESC LIMIT 1').first();
  const latestBatch = J(snap?.payload, {}).current || null;

  const out = [];
  for (const o of all) {
    if (onList.has(o.id) || status[o.id]?.status === 'dismissed' || status[o.id]?.status === 'followed') continue;
    const sectors = J(o.sectors);
    const reasons = [];
    let score = 0;
    const r = lastRound[o.id];
    if (r && r.kind !== 'Acquired' && J(r.sectors).length && (r.bay || o.bay)) {
      score += 3; reasons.push({ kind: 'funded', text: `Raised ${r.amount_usd ? fmtUsd(r.amount_usd) + ' ' : ''}${r.kind === 'Round' ? '' : r.kind}`.trim(), at: r.announced_at });
    }
    if (o.yc_batch && sectors.length) {
      score += 2 + (o.bay ? 1 : 0); reasons.push({ kind: 'yc', text: `YC ${o.yc_batch}` });
    }
    if (sectors.length && o.one_liner) {
      const t = tokens(o.one_liner);
      const sims = profile.map(p => {
        let n = 0; for (const w of t) if (p.t.has(w)) n++;
        return { p, s: (n / Math.max(3, Math.min(t.size, p.t.size))) + (sectors.includes(p.sector) ? 0.15 : 0) };
      }).filter(x => x.s >= 0.3).sort((a, b) => b.s - a.s);
      if (sims.length) { score += Math.min(2.5, sims[0].s * 3); reasons.push({ kind: 'like', text: `Like ${sims.slice(0, 2).map(x => x.p.name).join(', ')}` }); }
    }
    if (o.gtm_roles > 0) { score += 2; reasons.push({ kind: 'hiring', text: `Hiring: ${J(o.gtm_titles)[0] || `${o.gtm_roles} GTM roles`}` }); }
    else if (o.yc_hiring) score += 0.5;
    if (!reasons.length || !sectors.length && !reasons.some(x => x.kind === 'funded')) continue;
    if (o.yc_batch && o.yc_batch !== latestBatch && !reasons.some(x => x.kind !== 'yc')) continue;   // older YC batch with nothing else going on
    out.push({ id: o.id, score: Math.round(score * 100) / 100, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  const keep = out.slice(0, 60);
  const keepIds = new Set(keep.map(s => s.id));
  const stmts = keep.map(s => env.DB.prepare(
    `INSERT INTO suggestions (org_id,reasons,score,status,first_seen,updated_at) VALUES (?,?,?,'open',?,?)
     ON CONFLICT(org_id) DO UPDATE SET reasons=excluded.reasons, score=excluded.score, updated_at=excluded.updated_at`
  ).bind(s.id, JSON.stringify(s.reasons), s.score, now, now));
  // Open suggestions that dropped out of the top 60 are retired, not deleted.
  for (const [id, row] of Object.entries(status)) if (row.status === 'open' && !keepIds.has(id))
    stmts.push(env.DB.prepare(`UPDATE suggestions SET status='stale', updated_at=? WHERE org_id=?`).bind(now, id));
  await chunked(env, stmts);
  return keep.length;
}

export const fmtUsd = n => n >= 1e9 ? `$${+(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : `$${Math.round(n / 1e3)}K`;

/* Read the job boards of the top suggestions that haven't been
   checked this week. A known careers page is sniffed; otherwise the
   company's slug is tried on Ashby, Greenhouse and Lever. */
async function probeCandidates(env, now) {
  const cands = (await env.DB.prepare(
    `SELECT o.id, o.name, o.website, o.ats, o.ats_slug FROM suggestions s JOIN orgs o ON o.id = s.org_id
     WHERE s.status='open' AND (o.roles_checked IS NULL OR o.roles_checked < ?) ORDER BY s.score DESC LIMIT 10`
  ).bind(now - 7 * DAY).all()).results || [];
  const results = await Promise.allSettled(cands.map(async c => {
    let board = c.ats ? { ats: c.ats, slug: c.ats_slug } : null;
    if (!board && c.website) board = await sniffAts(c.website.replace(/\/$/, '') + '/careers');
    if (!board) {
      const guess = slugify(c.name).replace(/-/g, '');
      for (const ats of ['ashby', 'greenhouse', 'lever']) {
        try { const jobs = await fetchJobs(ats, guess); if (jobs.length) { board = { ats, slug: guess, jobs }; break; } } catch {}
      }
    }
    if (!board) return { id: c.id, none: true };
    const jobs = board.jobs || await fetchJobs(board.ats, board.slug);
    const gtm = jobs.map(p => ({ ...p, ...classifyLocation(p.location, p.remote) })).filter(p => isGtmRole(p.title) && (p.bay || p.remote));
    gtm.sort((a, b) => ROLE_CORE.test(b.title) - ROLE_CORE.test(a.title));
    return { id: c.id, ats: board.ats, slug: board.slug, total: jobs.length, gtm: gtm.map(p => p.title) };
  }));
  const stmts = results.map((r, i) => {
    const v = r.status === 'fulfilled' ? r.value : { id: cands[i].id, none: true };
    return v.none
      ? env.DB.prepare('UPDATE orgs SET roles_checked=? WHERE id=?').bind(now, v.id)
      : env.DB.prepare('UPDATE orgs SET ats=?, ats_slug=?, open_roles=?, gtm_roles=?, gtm_titles=?, roles_checked=? WHERE id=?')
          .bind(v.ats, v.slug, v.total, v.gtm.length, JSON.stringify(v.gtm.slice(0, 8)), now, v.id);
  });
  if (stmts.length) await env.DB.batch(stmts);
  return cands.length;
}

/* ---------- following a company: backfill its history ---------- */

export async function backfillCompany(env, w) {
  await ensureIntelSchema(env);
  const [m] = mentionMatchers([w]);
  const arts = (await env.DB.prepare('SELECT id,title,link,source,excerpt,published_at,first_seen,sectors,funding FROM articles').all()).results || [];
  const stmts = arts.filter(a => m.re.test(`${a.title} ${a.excerpt || ''}`) && (!m.needsContext || J(a.sectors).length)).map(a => env.DB.prepare(
    'INSERT OR IGNORE INTO org_news (org_id,article_id,title,link,source,published_at,funding) VALUES (?,?,?,?,?,?,?)'
  ).bind(w.id, a.id, a.title, a.link, a.source, a.published_at || a.first_seen, a.funding ? 1 : 0));
  await chunked(env, stmts);
  return stmts.length;
}

/* ---------- read models ---------- */

/** Watchlist tab: every watchlist company with its summary numbers, plus open suggestions. */
export async function watchView(env, watchlist, sectorsLabel) {
  await ensureIntelSchema(env);
  const now = Date.now();
  const gtm = Object.fromEntries(((await env.DB.prepare('SELECT company_id, COUNT(*) n FROM jobs WHERE last_seen > ? GROUP BY company_id').bind(now - 2 * DAY).all()).results || []).map(r => [r.company_id, r.n]));
  const news30 = Object.fromEntries(((await env.DB.prepare('SELECT org_id, COUNT(*) n, MAX(published_at) last FROM org_news WHERE published_at > ? GROUP BY org_id').bind(now - 30 * DAY).all()).results || []).map(r => [r.org_id, r]));
  const latest = {};
  for (const r of (await env.DB.prepare(
    `SELECT n.org_id, n.title, n.link, n.published_at FROM org_news n
     JOIN (SELECT org_id, MAX(published_at) m FROM org_news GROUP BY org_id) x ON x.org_id = n.org_id AND x.m = n.published_at`).all()).results || [])
    if (!latest[r.org_id]) latest[r.org_id] = { title: r.title, link: r.link, at: r.published_at };
  const lastRound = {};
  for (const r of (await env.DB.prepare('SELECT org_id, kind, amount_usd, announced_at FROM rounds ORDER BY announced_at DESC').all()).results || [])
    if (!lastRound[r.org_id]) lastRound[r.org_id] = r;
  const spark = {};
  for (const r of (await env.DB.prepare('SELECT org_id, day, open_roles, gtm_roles FROM org_daily WHERE day >= ? ORDER BY day').bind(dayKey(now - 60 * DAY)).all()).results || [])
    (spark[r.org_id] ||= []).push([r.day, r.open_roles, r.gtm_roles]);

  const sugg = (await env.DB.prepare(
    `SELECT s.org_id, s.reasons, s.score, s.first_seen, o.name, o.website, o.city, o.bay, o.sectors, o.one_liner, o.yc_batch, o.gtm_roles
     FROM suggestions s JOIN orgs o ON o.id = s.org_id WHERE s.status='open' ORDER BY s.score DESC LIMIT 18`).all()).results || [];

  return {
    generatedAt: now,
    sectors: sectorsLabel,
    companies: watchlist.map(w => ({
      ...w, gtmRoles: gtm[w.id] || 0, news30: news30[w.id]?.n || 0, lastNews: latest[w.id] || null,
      lastRound: lastRound[w.id] || null, spark: spark[w.id] || [],
    })),
    suggestions: sugg.map(s => ({ id: s.org_id, name: s.name, website: s.website, city: s.city, bay: !!s.bay, sectors: J(s.sectors),
      oneLiner: s.one_liner, ycBatch: s.yc_batch, gtmRoles: s.gtm_roles, score: s.score, reasons: J(s.reasons), isNew: now - s.first_seen < 3 * DAY })),
  };
}

/** One company page: everything the store knows about it. */
export async function companyView(env, id, watch) {
  await ensureIntelSchema(env);
  const now = Date.now();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id=?').bind(id).first();
  if (!org && !watch) return null;
  const [news, rounds, daily, roles, sugg] = await env.DB.batch([
    env.DB.prepare('SELECT article_id, title, link, source, published_at, funding FROM org_news WHERE org_id=? ORDER BY published_at DESC LIMIT 200').bind(id),
    env.DB.prepare('SELECT * FROM rounds WHERE org_id=? ORDER BY announced_at DESC').bind(id),
    env.DB.prepare('SELECT day, open_roles, gtm_roles FROM org_daily WHERE org_id=? ORDER BY day').bind(id),
    env.DB.prepare('SELECT * FROM jobs WHERE company_id=? AND last_seen > ? ORDER BY core DESC, first_seen DESC').bind(id, now - 2 * DAY),
    env.DB.prepare('SELECT reasons, status FROM suggestions WHERE org_id=?').bind(id),
  ]);
  const s = sugg.results?.[0];
  return {
    generatedAt: now,
    id,
    onWatchlist: !!watch,
    watch: watch || null,
    org: org ? { ...org, sectors: J(org.sectors), sources: J(org.sources), gtmTitles: J(org.gtm_titles) } : null,
    suggestion: s ? { status: s.status, reasons: J(s.reasons) } : null,
    news: news.results || [],
    rounds: (rounds.results || []).map(r => ({ ...r, investors: J(r.investors, null), sectors: J(r.sectors) })),
    daily: daily.results || [],
    roles: (roles.results || []).map(j => ({ ...j, isNew: !j.baseline && now - j.first_seen < 7 * DAY })),
  };
}

/** Parsed deals keyed by article id, for the Bay Area funding list. */
export async function dealsByArticle(env, ids) {
  await ensureIntelSchema(env);
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    for (const r of (await env.DB.prepare(
      `SELECT r.article_id, r.org_id, r.org_name, r.kind, r.amount_usd, r.valuation_usd, r.investors, COALESCE(o.bay, 0) org_bay
       FROM rounds r LEFT JOIN orgs o ON o.id = r.org_id WHERE r.article_id IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results || [])
      out[r.article_id] = { orgId: r.org_id, org: r.org_name, kind: r.kind, amount: r.amount_usd, valuation: r.valuation_usd,
                            investors: J(r.investors, null), bay: !!r.org_bay };
  }
  return out;
}
