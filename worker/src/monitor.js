/* ============================================================
   monitor.js — private job monitor for the Notion Job Database
   ------------------------------------------------------------
   Kept apart from the public radar. Nothing here is read by the
   site, the brief or news matching. Its D1 tables (monitor_*)
   are only exposed through /api/monitor, which needs X-Radar-Key.
   The company list lives in Notion and D1, never in this repo.

   Nightly stages (see index.js):
     sync    read the Job Database: new company rows, URL edits,
             clipped role rows, Fit and deleted rows; approved
             suggestions; Radar watchlist companies missing here
     checkA–E  read up to 40 job boards each (200 in all); queue Notion writes
     write   drain the Notion write queue (carries over nightly)

   Company sourcing: the "Company sourcing" cloud routine adds
   company rows with Monitor Status = Suggested. Hayden approves one
   by setting it to Watching, or passes with Not interested. The
   monitor never reads boards for, or rewrites the status of, a row
   in either HOLD status.
   ============================================================ */

import { notion, queryAll, prop, put, textToBlocks, pageText } from './notion.js';
import { fetchJobs, sniffAts, detectAts, htmlToText, annual } from './watchlist.js';
import { ROLE_CORE, ROLE_EXCLUDE, classifyLocation } from './sources.js';

const DAY = 24 * 3600 * 1000;
const PER_CHECK = 40;          // boards per check stage (free plan: 50 requests)
const BUDGET = 45;             // outbound requests a stage allows itself

/* Monitor Status values only Hayden (or the sourcing routine) sets. */
export const HOLD = new Set(['Suggested', 'Not interested']);
const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/* ============================================================
   Filters
   ============================================================ */

/* ROLE_CORE plus the extra target titles. The broad ROLE_GTM list
   (sales, AE, CS…) is deliberately not used. */
export const ROLE_EXTRA = /\b(strategy\s*(&|and)\s*operations|revenue strategy|revenue systems|business systems|sales systems|gtm engineer(ing)?|go[- ]to[- ]market engineer(ing)?)\b/i;
/* Engineering, product and workplace roles that ride in on "GTM systems"
   or "business operations". GTM engineer titles are always kept. */
export const ROLE_EXCLUDE_MONITOR = /\b((software|data|devops|agentops|analytics|ml|machine learning|security|infrastructure|platform|backend|front[- ]?end|full[- ]?stack|site reliability) engineer(ing)?|product manager|workplace)\b/i;
const GTM_ENG = /\b(gtm|go[- ]to[- ]market)( systems)? engineer(ing)?\b/i;
export const titlePasses = t => (ROLE_CORE.test(t) || ROLE_EXTRA.test(t)) && !ROLE_EXCLUDE.test(t) && (GTM_ENG.test(t) || !ROLE_EXCLUDE_MONITOR.test(t));

/* A near miss: a revenue/sales/GTM word next to an ops/systems word. */
const NEAR = /\b(revenue|sales|gtm|go[- ]to[- ]market|commercial|deal|growth|marketing|customer|partner|pricing|monetization|business)\b.*\b(operations|ops|systems|strategy|enablement|planning|programs|analytics)\b|\b(operations|ops|systems|strategy|enablement|planning)\b.*\b(revenue|sales|gtm|commercial|business)\b|\b(salesforce|crm|hubspot|cpq)\b/i;

export function levelOf(title) {
  const t = title || '';
  if (/\b(head of|director|vp|vice president|chief|svp|evp|cro)\b/i.test(t)) return 'Head or Director';
  if (/\b(senior|sr\.?)\s*(\/\s*)?(staff\s+)?manager\b|\bmanager\s*,?\s*senior\b|\bsenior manager\b/i.test(t)) return 'Senior Manager';
  if (/\bmanager\b/i.test(t)) return 'Manager';
  return 'Other';
}

const NYC = /\b(new york( city)?|nyc|ny,?\s*ny|brooklyn|manhattan|jersey city|hoboken)\b/i;

/** {keep, workLoc, why} for one posting. */
export function judge(p) {
  const title = p.title || '';
  const loc = classifyLocation(p.location, p.remote);
  const level = levelOf(title);
  const nyc = NYC.test(p.location || '');
  const tOk = titlePasses(title);
  // Some boards flag an office role as remote; if the location names
  // New York and never says "remote", it is a New York role.
  const saysRemote = /remote|anywhere/i.test(p.location || '');
  const workLoc = loc.bay ? 'Bay Area' : (nyc && !saysRemote) ? 'New York' : loc.remote ? 'Remote' : nyc ? 'New York' : null;
  const lOk = workLoc === 'Bay Area' || workLoc === 'Remote' || (workLoc === 'New York' && (level === 'Manager' || level === 'Senior Manager'));
  let why = null;
  if (tOk && !lOk) why = workLoc === 'New York' ? `New York but level is ${level}` : `location: ${p.location || 'none'}`;
  else if (!tOk && (ROLE_CORE.test(title) || ROLE_EXTRA.test(title))) why = 'title excluded (engineering, product or ROLE_EXCLUDE)';
  else if (!tOk && lOk && NEAR.test(title)) why = 'title close but not a target';
  return { keep: tOk && lOk, workLoc, level, why };
}

/* ============================================================
   Keys and dates
   ============================================================ */

/** Dedupe key: the posting id when the URL is a known board,
    otherwise the URL with its query string and hash removed. */
export function roleKey(url) {
  const u = url || '';
  let m;
  if ((m = u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/)) || (m = u.match(/[?&]gh_jid=(\d+)/))) return `gh:${m[1]}`;
  if ((m = u.match(/jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f-]{36})/i))) return `ab:${m[1].toLowerCase()}`;
  if ((m = u.match(/jobs\.lever\.co\/[^/]+\/([0-9a-f-]{36})/i))) return `lv:${m[1].toLowerCase()}`;
  if ((m = u.match(/workable\.com\/.*\/j\/([A-Z0-9]+)/i))) return `wk:${m[1].toUpperCase()}`;
  try { const x = new URL(u); return `url:${x.host.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '')}`; }
  catch { return `url:${u.split(/[?#]/)[0]}`; }
}

/** A clean, query-free URL to store in Notion for a posting. */
function cleanUrl(ats, slug, p) {
  if (ats === 'greenhouse' && p.postingId) return `https://job-boards.greenhouse.io/${slug}/jobs/${p.postingId}`;
  return (p.url || '').split(/[?#]/)[0];
}

/* Dates in Pacific time. */
const today = () => new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10);

/* ============================================================
   D1 helpers
   ============================================================ */

const all = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];
const run = (env, sql, ...b) => env.DB.prepare(sql).bind(...b).run();
async function batch(env, stmts) { for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50)); }

/** Queue a Notion write. One pending item per (kind, ref): a newer
    company or role update replaces the older one. */
function enqueue(env, kind, ref, payload) {
  return [
    env.DB.prepare(`DELETE FROM monitor_queue WHERE kind=? AND ref=? AND kind != 'create'`).bind(kind, ref),
    env.DB.prepare(`INSERT INTO monitor_queue (kind,ref,payload,created_at) VALUES (?,?,?,?)`).bind(kind, ref, JSON.stringify(payload), Date.now()),
  ];
}

/* ============================================================
   Notion: reading the Job Database
   ============================================================ */

export async function readJobDb(env, budget) {
  const rows = await queryAll(env, env.JOB_DS_ID, null, budget);
  return rows.map(r => {
    const p = r.properties;
    return {
      pageId: r.id,
      name: prop.title(p.Name),
      position: prop.formula(p.Position),
      url: prop.url(p.URL),
      monitorStatus: prop.select(p['Monitor Status']),
      roleStatus: prop.select(p['Role Status']),
      fit: prop.select(p.Fit),
      newRoleDate: prop.date(p['New Role Date']),
      company: prop.formula(p.Company),
      newJob: prop.formula(p['New Job']),
    };
  });
}
const isCompanyRow = r => !r.position;

/* ============================================================
   Stage: sync — Notion → D1
   ============================================================ */

export async function stageSync(env) {
  const budget = { left: BUDGET };
  const rows = await readJobDb(env, budget);
  const now = Date.now();
  const companies = rows.filter(isCompanyRow);
  const roles = rows.filter(r => !isCompanyRow(r));
  const known = Object.fromEntries((await all(env, 'SELECT * FROM monitor_companies')).map(c => [c.page_id, c]));
  const stmts = [];
  const approvals = [];
  const report = { companies: companies.length, roles: roles.length, added: [], resniffed: [], held: 0, approved: [], linked: [], linkPending: 0, clipped: 0, gone: 0 };

  // Companies: new rows and URL edits. A URL we wrote ourselves is
  // remembered in notion_url, so only a hand edit triggers a re-sniff.
  for (const c of companies) {
    const k = known[c.pageId];
    if (k && k.name !== c.name) stmts.push(env.DB.prepare('UPDATE monitor_companies SET name=? WHERE page_id=?').bind(c.name, c.pageId));

    // Suggested / Not interested: remember the status, read no board.
    if (HOLD.has(c.monitorStatus)) {
      if (!k) stmts.push(env.DB.prepare(`INSERT INTO monitor_companies (page_id,name,careers,status,note,fails,notion_url,updated_at) VALUES (?,?,?,?,?,0,?,?)`)
        .bind(c.pageId, c.name, c.url, c.monitorStatus, 'held: ' + c.monitorStatus, c.url, now));
      else if (k.status !== c.monitorStatus) stmts.push(env.DB.prepare('UPDATE monitor_companies SET status=?, note=? WHERE page_id=?').bind(c.monitorStatus, 'held: ' + c.monitorStatus, c.pageId));
      if (c.monitorStatus === 'Not interested')        // keep the Radar from suggesting it again
        stmts.push(env.DB.prepare(`UPDATE suggestions SET status='dismissed', updated_at=? WHERE org_id=? AND status != 'followed'`).bind(now, slug(c.name)));
      report.held++;
      continue;
    }
    // Hayden moved a held row to a watch status: treat it as new.
    const released = k && HOLD.has(k.status);
    if (released && k.status === 'Suggested') { approvals.push(c); report.approved.push(c.name); }
    // A sourcing row approved before any sync saw it as Suggested: its
    // page body says so. One read, only for rows the monitor never saw.
    else if (!k && budget.left >= 6) {
      const body = await pageText(env, c.pageId, budget).catch(() => '');
      if (/by company sourcing/i.test(body)) { approvals.push(c); report.approved.push(c.name); }
    }
    const edited = k && c.url && c.url !== k.notion_url && c.url !== k.careers;
    if (k && !edited && !released) continue;
    if (!c.url) {
      if (!k) { stmts.push(env.DB.prepare(`INSERT INTO monitor_companies (page_id,name,status,note,updated_at) VALUES (?,?,NULL,'no careers URL yet',?)`).bind(c.pageId, c.name, now)); report.added.push(`${c.name} (no URL)`); }
      else if (released) stmts.push(env.DB.prepare(`UPDATE monitor_companies SET status=NULL, note='no careers URL yet' WHERE page_id=?`).bind(c.pageId));
      continue;
    }
    if (budget.left < 4) break;                       // finish tomorrow
    budget.left -= 2;                                  // sniff: page + maybe redirect
    const d = await sniffAts(c.url);
    const status = d ? 'Watching' : 'Manual check';
    stmts.push(env.DB.prepare(
      `INSERT INTO monitor_companies (page_id,name,careers,ats,slug,status,note,fails,notion_url,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)
       ON CONFLICT(page_id) DO UPDATE SET careers=excluded.careers, ats=excluded.ats, slug=excluded.slug, status=excluded.status,
         note=excluded.note, fails=0, notion_url=excluded.notion_url, updated_at=excluded.updated_at`
    ).bind(c.pageId, c.name, c.url, d?.ats || null, d?.slug || null, status, d ? '' : 'careers page has no supported board', c.url, now));
    if (c.monitorStatus !== status) stmts.push(...enqueue(env, 'company', c.pageId, { 'Monitor Status': status }));
    (k ? report.resniffed : report.added).push(`${c.name}: ${d ? d.ats : 'unsupported'}`);
  }

  // Role rows: copy Fit, adopt clipped rows, notice hand deletions.
  const byKey = Object.fromEntries((await all(env, 'SELECT key, page_id, gone FROM monitor_roles')).map(r => [r.key, r]));
  const byPage = new Set(roles.map(r => r.pageId));
  for (const r of roles) {
    if (!r.url) continue;
    const key = roleKey(r.url);
    const mine = byKey[key];
    if (mine) {
      stmts.push(env.DB.prepare('UPDATE monitor_roles SET fit=?, page_id=COALESCE(page_id, ?) WHERE key=?').bind(r.fit, r.pageId, key));
    } else {
      // A row that existed before the monitor saw it ("clipped").
      // Only its Role Status may ever change, and only to Closed.
      const d = detectAts(r.url);
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO monitor_roles (key,page_id,company_id,board,title,url,status,clipped,fit,first_seen,last_seen)
         VALUES (?,?,NULL,?,?,?,?,1,?,?,?)`
      ).bind(key, r.pageId, d ? `${d.ats}:${d.slug}` : null, r.name.split(' @ ')[0], r.url, r.roleStatus || 'Open', r.fit, r.newRoleDate, now));
      report.clipped++;
    }
  }
  // Monitor-made rows whose Notion page was deleted: never recreate.
  for (const m of Object.values(byKey)) {
    if (m.page_id && !m.gone && !byPage.has(m.page_id)) { stmts.push(env.DB.prepare('UPDATE monitor_roles SET gone=1 WHERE key=?').bind(m.key)); report.gone++; }
  }
  // Clipped rows: attach to a monitored company when the board matches.
  stmts.push(env.DB.prepare(`UPDATE monitor_roles SET company_id = (SELECT page_id FROM monitor_companies c WHERE c.ats || ':' || c.slug = monitor_roles.board)
                             WHERE clipped = 1 AND company_id IS NULL AND board IS NOT NULL`));
  await batch(env, stmts);

  // Approved suggestions join the Radar watchlist, so their news and
  // funding show up on the site and in the brief.
  if (approvals.length) await addToRadar(env, approvals, now);

  // Every Radar watchlist company is also a company row in the Job
  // Database. Missing ones are added here, as many as the budget allows;
  // the rest wait for the next night.
  const names = new Set(companies.map(c => c.name.toLowerCase()));
  const boards = new Set(Object.values(known).filter(k => k.ats && k.slug).map(k => `${k.ats}:${k.slug}`));
  for (const w of await all(env, 'SELECT * FROM watchlist WHERE removed = 0 ORDER BY added_at, name')) {
    if (names.has(w.name.toLowerCase()) || (w.ats && boards.has(`${w.ats}:${w.slug}`))) continue;
    if (budget.left < 4) { report.linkPending++; continue; }
    const r = await addCompanyRow(env, w, `Added ${new Date(now).toISOString().slice(0, 10)} from the Startup Radar watchlist.`, budget).catch(e => ({ notion: 'error', error: e.message.slice(0, 120) }));
    report.linked.push(`${w.name}: ${r.status || r.error || r.notion}`);
    names.add(w.name.toLowerCase());
  }
  return report;
}

/* Approved suggestions → Radar watchlist (starred, origin 'sourcing').
   Short one-word names (Mill, Quilt) only match news that also uses
   sector vocabulary, so ordinary-word headlines don't attach to them. */
async function addToRadar(env, rows, now) {
  const stmts = [];
  for (const c of rows) {
    const m = await env.DB.prepare('SELECT careers, ats, slug FROM monitor_companies WHERE page_id=?').bind(c.pageId).first();
    const id = slug(c.name);
    const vague = /^[a-z]{2,6}$/i.test(c.name.trim());
    stmts.push(env.DB.prepare(
      `INSERT INTO watchlist (id,name,sector,city,website,careers,ats,slug,aliases,needs_context,note,starred,origin,removed,added_at)
       VALUES (?,?,'risk','',NULL,?,?,?,?,?,'Approved from company sourcing',1,'sourcing',0,?)
       ON CONFLICT(id) DO UPDATE SET removed=0, starred=1, careers=COALESCE(watchlist.careers, excluded.careers),
         ats=COALESCE(watchlist.ats, excluded.ats), slug=COALESCE(watchlist.slug, excluded.slug)`
    ).bind(id, c.name, m?.careers || c.url, m?.ats || null, m?.slug || null, JSON.stringify([c.name]), vague ? 1 : 0, now));
    stmts.push(env.DB.prepare(`UPDATE suggestions SET status='followed', updated_at=? WHERE org_id=?`).bind(now, id));
  }
  await batch(env, stmts);
}

/* ============================================================
   Stage: check — job boards → D1 + queue
   ============================================================ */

/** Boards to read tonight, in a stable order, split into slices of
    PER_CHECK. Clipped-only boards (companies not in the database)
    ride at the end of the list. */
async function boardsFor(env, slice) {
  const cos = await all(env, `SELECT * FROM monitor_companies WHERE ats IS NOT NULL AND slug IS NOT NULL
                              AND status IN ('Watching','Match found') ORDER BY name`);
  const extra = (await all(env, `SELECT DISTINCT board FROM monitor_roles WHERE clipped=1 AND company_id IS NULL AND status='Open' AND board IS NOT NULL`))
    .map(r => ({ page_id: null, name: null, ats: r.board.split(':')[0], slug: r.board.split(':').slice(1).join(':'), clippedOnly: true }));
  const list = [...cos, ...extra];
  const boards = list.slice(slice * PER_CHECK, (slice + 1) * PER_CHECK);
  boards.total = list.length;
  return boards;
}

export async function checkBoards(env, boards, { dryRun = false } = {}) {
  const now = Date.now(), day = today();
  const out = { checked: 0, failed: [], matches: [], nearMisses: [], newRoles: 0, closed: 0 };
  const results = await Promise.allSettled(boards.map(b => fetchJobs(b.ats, b.slug, { details: true })));
  const stmts = [];
  // One read of the (small) roles table instead of queries per board:
  // the free plan also caps D1 queries per invocation.
  const known = dryRun ? [] : await all(env, 'SELECT * FROM monitor_roles');
  const byKey = Object.fromEntries(known.map(x => [x.key, x]));

  for (let i = 0; i < boards.length; i++) {
    const b = boards[i], r = results[i];
    const board = `${b.ats}:${b.slug}`;
    if (r.status !== 'fulfilled') {
      out.failed.push({ name: b.name || board, error: r.reason?.message });
      if (!dryRun && b.page_id) {
        const fails = (b.fails || 0) + 1;
        stmts.push(env.DB.prepare('UPDATE monitor_companies SET fails=?, last_error=? WHERE page_id=?').bind(fails, String(r.reason?.message).slice(0, 200), b.page_id));
        if (fails >= 3) {
          stmts.push(env.DB.prepare(`UPDATE monitor_companies SET status='Manual check', note='board failed 3 nights running' WHERE page_id=?`).bind(b.page_id));
          stmts.push(...enqueue(env, 'company', b.page_id, { 'Monitor Status': 'Manual check' }));
        }
      }
      continue;
    }
    out.checked++;
    const posts = r.value;
    const seen = new Set();

    if (!b.clippedOnly) for (const p of posts) {
      const j = judge(p);
      const url = cleanUrl(b.ats, b.slug, p);
      const row = { company: b.name, title: p.title, location: p.location, level: j.level, workLoc: j.workLoc, url };
      if (!j.keep) { if (j.why) out.nearMisses.push({ ...row, why: j.why }); continue; }
      out.matches.push(row);
      seen.add(roleKey(url));
    }
    // Every posting key on the board, for closing clipped rows too.
    const onBoard = new Set(posts.map(p => roleKey(cleanUrl(b.ats, b.slug, p))));
    if (dryRun) continue;

    // New and returning roles.
    const existing = byKey;
    for (const p of posts) {
      const url = cleanUrl(b.ats, b.slug, p), key = roleKey(url);
      if (!seen.has(key)) continue;
      const e = existing[key], j = judge(p);
      if (!e) {
        stmts.push(env.DB.prepare(
          `INSERT INTO monitor_roles (key,company_id,board,title,url,level,work_loc,status,clipped,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,'Open',0,?,?)`
        ).bind(key, b.page_id, board, p.title.trim(), url, j.level, j.workLoc, day, now));
        stmts.push(...enqueue(env, 'create', key, {
          name: `${p.title.trim()} @ ${b.name}`, url, level: j.level, workLoc: j.workLoc, firstSeen: day,
          comp: p.comp || null, text: (p.text || '').slice(0, 60000),
          ghPay: b.ats === 'greenhouse' && p.postingId ? { slug: b.slug, id: p.postingId } : null,
          workable: b.ats === 'workable' ? { slug: b.slug, code: (p.id || '').split(':').pop() } : null,
        }));
        out.newRoles++;
      } else {
        stmts.push(env.DB.prepare('UPDATE monitor_roles SET last_seen=?, missed=0 WHERE key=?').bind(now, key));
        // A monitor row that closed and came back reopens. Clipped
        // rows are never reopened — only ever set to Closed.
        if (e.status === 'Closed' && !e.clipped && !e.gone) {
          stmts.push(env.DB.prepare(`UPDATE monitor_roles SET status='Open' WHERE key=?`).bind(key));
          if (e.page_id) stmts.push(...enqueue(env, 'role', key, { 'Role Status': 'Open' }));
        }
      }
    }

    // Removed roles. An empty board must be empty two nights running
    // before its roles close, so an API hiccup can't close everything.
    const open = known.filter(o => o.board === board && o.status === 'Open' && !o.gone);
    for (const o of open) {
      const present = o.clipped ? onBoard.has(o.key) : seen.has(o.key) || onBoard.has(o.key);
      if (present) { if (o.clipped) stmts.push(env.DB.prepare('UPDATE monitor_roles SET last_seen=?, missed=0 WHERE key=?').bind(now, o.key)); continue; }
      const missed = (o.missed || 0) + 1;
      if (posts.length > 0 || missed >= 2) {
        stmts.push(env.DB.prepare(`UPDATE monitor_roles SET status='Closed', missed=? WHERE key=?`).bind(missed, o.key));
        if (o.page_id) stmts.push(...enqueue(env, 'role', o.key, { 'Role Status': 'Closed' }));
        out.closed++;
      } else stmts.push(env.DB.prepare('UPDATE monitor_roles SET missed=? WHERE key=?').bind(missed, o.key));
    }
    if (b.page_id) stmts.push(env.DB.prepare('UPDATE monitor_companies SET fails=0, last_error=NULL, last_checked=? WHERE page_id=?').bind(now, b.page_id));
  }
  if (!dryRun) await batch(env, stmts);
  return out;
}

export async function stageCheck(env, slice) {
  const boards = await boardsFor(env, slice);
  const r = await checkBoards(env, boards);
  // After the last slice that has boards, queue each company's nightly summary.
  const total = boards.total;
  if ((slice + 1) * PER_CHECK >= total && (slice * PER_CHECK < total || slice === 0)) await queueCompanyRollups(env);
  return { slice, boards: boards.length, checked: r.checked, newRoles: r.newRoles, closed: r.closed, matches: r.matches.length, failed: r.failed };
}

/** Last Checked, Fit Roles Open, Latest Match, New Role Date and
    Monitor Status for every company with a board, from D1. */
async function queueCompanyRollups(env, onlyIds = null) {
  const cos = (await all(env, `SELECT * FROM monitor_companies WHERE ats IS NOT NULL`))
    .filter(c => !HOLD.has(c.status) && (!onlyIds || onlyIds.includes(c.page_id)));
  const roles = await all(env, `SELECT company_id, title, fit, first_seen, status, gone FROM monitor_roles WHERE company_id IS NOT NULL`);
  const stmts = [];
  for (const c of cos) {
    const mine = roles.filter(r => r.company_id === c.page_id && !r.gone && r.fit !== 'Skip');
    const open = mine.filter(r => r.status === 'Open').sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''));
    const fitOpen = open.filter(r => ['Perfect', 'Strong', 'Stretch'].includes(r.fit)).length;
    const newest = mine.map(r => r.first_seen).filter(Boolean).sort().pop() || null;
    let status = c.status;
    if (status === 'Watching' || status === 'Match found') status = open.length ? 'Match found' : 'Watching';
    if (status !== c.status) stmts.push(env.DB.prepare('UPDATE monitor_companies SET status=? WHERE page_id=?').bind(status, c.page_id));
    const props = { 'Monitor Status': status, 'Fit Roles Open': fitOpen, 'Latest Match': (open[0]?.title || '').trim() };
    if (c.last_checked) props['Last Checked'] = new Date(c.last_checked - 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (newest) props['New Role Date'] = newest;
    stmts.push(...enqueue(env, 'company', c.page_id, props));
  }
  await batch(env, stmts);
}

/* ============================================================
   Stage: write — drain the Notion queue
   ============================================================ */

function propsFor(p) {
  const out = {};
  if ('Monitor Status' in p) out['Monitor Status'] = put.select(p['Monitor Status']);
  if ('Role Status' in p) out['Role Status'] = put.select(p['Role Status']);
  if ('Fit Roles Open' in p) out['Fit Roles Open'] = put.number(p['Fit Roles Open']);
  if ('Latest Match' in p) out['Latest Match'] = put.text(p['Latest Match']);
  if ('Last Checked' in p) out['Last Checked'] = put.date(p['Last Checked']);
  if ('New Role Date' in p) out['New Role Date'] = put.date(p['New Role Date']);
  if ('URL' in p) out.URL = put.url(p.URL);
  return out;
}

async function greenhousePay(slug, id) {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}?pay_transparency=true`);
  if (!r.ok) return null;
  const j = await r.json();
  const rng = (j.pay_input_ranges || []).find(x => x.currency_type === 'USD') || null;
  if (!rng) return null;
  return annual(rng.min_cents / 100, rng.max_cents / 100, 'USD', /\bOTE\b|on[- ]target/i.test(`${rng.title} ${rng.blurb || ''}`) ? 'OTE' : 'Base');
}

async function workableText(slug, code) {
  const r = await fetch(`https://apply.workable.com/api/v2/accounts/${slug}/jobs/${code}`);
  if (!r.ok) return '';
  const j = await r.json();
  return [j.description, j.requirements, j.benefits].map(htmlToText).filter(Boolean).join('\n\n');
}

export async function stageWrite(env, { max = 40 } = {}) {
  const budget = { left: BUDGET };
  const items = await all(env, `SELECT * FROM monitor_queue WHERE tries < 5 ORDER BY CASE kind WHEN 'company' THEN 2 ELSE 1 END, id LIMIT ?`, max);
  // Preload role rows once; D1 writes are collected and flushed in
  // batches (the free plan caps D1 queries per invocation too).
  const roles = Object.fromEntries((await all(env, 'SELECT key, page_id, gone FROM monitor_roles')).map(r => [r.key, r]));
  const done = [], failed = [];
  let stmts = [];
  const flush = async () => {
    if (done.length) stmts.push(env.DB.prepare(`DELETE FROM monitor_queue WHERE id IN (${done.map(() => '?').join(',')})`).bind(...done));
    await batch(env, stmts); stmts = []; done.length = 0;
  };
  let written = 0, n = 0;
  for (const it of items) {
    if (budget.left < 4) break;
    const p = JSON.parse(it.payload || '{}');
    const role = roles[it.ref];
    try {
      if (it.kind === 'create') {
        if (role?.page_id || role?.gone) { done.push(it.id); continue; }     // already written
        let comp = p.comp, text = p.text;
        if (!comp && p.ghPay) { budget.left--; comp = await greenhousePay(p.ghPay.slug, p.ghPay.id).catch(() => null); }
        if (!text && p.workable) { budget.left--; text = await workableText(p.workable.slug, p.workable.code).catch(() => ''); }
        const props = {
          Name: put.title(p.name), URL: put.url(p.url), 'New Role Date': put.date(p.firstSeen),
          Level: put.select(p.level), 'Work Location': put.select(p.workLoc), 'Role Status': put.select('Open'),
        };
        if (comp) { props['Comp Min'] = put.number(comp.min); props['Comp Max'] = put.number(comp.max); props['Comp Basis'] = put.select(comp.basis); }
        const blocks = textToBlocks(text || 'Posting text was not available from the job board.');
        const page = await notion(env, 'POST', '/pages', {
          parent: { type: 'data_source_id', data_source_id: env.JOB_DS_ID }, properties: props, children: blocks.slice(0, 100),
        }, budget);
        // Record the page at once so a later failure can never duplicate it.
        stmts.push(env.DB.prepare('UPDATE monitor_roles SET page_id=? WHERE key=?').bind(page.id, it.ref));
        if (role) role.page_id = page.id;
        for (let i = 100; i < blocks.length && budget.left > 2; i += 100) await notion(env, 'PATCH', `/blocks/${page.id}/children`, { children: blocks.slice(i, i + 100) }, budget).catch(() => {});
      } else if (it.kind === 'role') {
        if (!role?.page_id || role.gone) { done.push(it.id); continue; }
        await notion(env, 'PATCH', `/pages/${role.page_id}`, { properties: propsFor(p) }, budget);
      } else if (it.kind === 'company') {
        await notion(env, 'PATCH', `/pages/${it.ref}`, { properties: propsFor(p) }, budget);
        if (p.URL) stmts.push(env.DB.prepare('UPDATE monitor_companies SET notion_url=? WHERE page_id=?').bind(p.URL, it.ref));
      }
      done.push(it.id); written++;
    } catch (e) {
      failed.push({ kind: it.kind, error: e.message });
      stmts.push(env.DB.prepare('UPDATE monitor_queue SET tries=tries+1, last_error=? WHERE id=?').bind(e.message.slice(0, 200), it.id));
      if (/budget/.test(e.message)) break;
    }
    if (++n % 10 === 0) await flush();
  }
  await flush();
  const left = (await env.DB.prepare('SELECT COUNT(*) n FROM monitor_queue WHERE tries < 5').first()).n;
  return { written, failed, queueLeft: left };
}

/* ============================================================
   Phase 1 import: careers URLs + boards from a private mapping
   (posted to the keyed route; never stored in the repo)
   ============================================================ */

async function importMapping(env, mapping) {
  const budget = { left: BUDGET };
  const rows = (await readJobDb(env, budget)).filter(isCompanyRow);
  const byName = Object.fromEntries(rows.map(r => [r.name.toLowerCase(), r]));
  const now = Date.now(), stmts = [], missing = [];
  for (const m of mapping) {
    const r = byName[(m.name || '').toLowerCase()];
    if (!r) { missing.push(m.name); continue; }
    stmts.push(env.DB.prepare(
      `INSERT INTO monitor_companies (page_id,name,careers,ats,slug,status,note,fails,notion_url,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)
       ON CONFLICT(page_id) DO UPDATE SET name=excluded.name, careers=excluded.careers, ats=excluded.ats, slug=excluded.slug,
         status=excluded.status, note=excluded.note, notion_url=excluded.notion_url, updated_at=excluded.updated_at`
    ).bind(r.pageId, r.name, m.careers || null, m.ats || null, m.slug || null, m.status || null, m.note || '', m.careers || r.url || null, now));
    const props = {};
    if (m.careers && m.careers !== r.url) props.URL = m.careers;
    if (m.status && m.status !== r.monitorStatus) props['Monitor Status'] = m.status;
    if (Object.keys(props).length) stmts.push(...enqueue(env, 'company', r.pageId, props));
  }
  await batch(env, stmts);
  return { imported: mapping.length - missing.length, missing, queued: (await env.DB.prepare('SELECT COUNT(*) n FROM monitor_queue').first()).n };
}

/* ============================================================
   Keyed route: /api/monitor?action=…   (X-Radar-Key checked in index.js)
   ============================================================ */

export async function monitorRoute(env, url, req) {
  const a = url.searchParams.get('action');
  const q = k => url.searchParams.get(k);

  if (a === 'status') {
    const [byStatus, roles, queue] = await Promise.all([
      all(env, 'SELECT status, COUNT(*) n FROM monitor_companies GROUP BY status'),
      all(env, 'SELECT status, clipped, COUNT(*) n FROM monitor_roles GROUP BY status, clipped'),
      all(env, 'SELECT kind, COUNT(*) n, SUM(tries > 0) retrying FROM monitor_queue GROUP BY kind'),
    ]);
    // Stored under 'monitor:' (not 'stage:') so the public /api/sources never lists them.
    const stages = Object.fromEntries((await all(env, `SELECT key, value FROM meta WHERE key LIKE 'monitor:%'`)).map(r => [r.key.slice(8), JSON.parse(r.value)]));
    return { companies: byStatus, roles, queue, stages };
  }
  if (a === 'companies') return { companies: await all(env, 'SELECT name, status, ats, slug, careers, fails, last_error, last_checked, note FROM monitor_companies ORDER BY name') };
  if (a === 'roles') return { roles: await all(env, 'SELECT r.*, c.name company FROM monitor_roles r LEFT JOIN monitor_companies c ON c.page_id = r.company_id ORDER BY first_seen DESC') };
  if (a === 'peek') return { rows: (await readJobDb(env, { left: 10 })).filter(r => !q('name') || r.name.includes(q('name'))) };
  if (a === 'queue') return { queue: await all(env, 'SELECT id, kind, tries, last_error, substr(payload,1,160) payload FROM monitor_queue ORDER BY id LIMIT 200') };

  if (a === 'import' && req.method === 'POST') return importMapping(env, await req.json());

  // Dry run: read boards and apply filters. No D1 or Notion writes.
  // ?from=0&n=40 pages through the board list (40 per call).
  if (a === 'dryrun') {
    const from = +q('from') || 0, n = Math.min(+q('n') || PER_CHECK, PER_CHECK);
    const cos = await all(env, `SELECT * FROM monitor_companies WHERE ats IS NOT NULL AND slug IS NOT NULL AND status IN ('Watching','Match found') ORDER BY name`);
    const r = await checkBoards(env, cos.slice(from, from + n), { dryRun: true });
    return { from, n, total: cos.length, ...r };
  }

  // Run one stage now: sync | checkA | checkB | checkC | write
  if (a === 'stage') return runMonitorStage(env, q('stage'), { only: q('only') });

  return { error: 'action must be one of status, companies, roles, queue, dryrun, stage, import (POST)' };
}

/* ============================================================
   Stage runner (used by cron and the keyed route)
   ============================================================ */

export const MONITOR_STAGES = {
  monitorSync:   env => stageSync(env),
  monitorCheckA: env => stageCheck(env, 0),
  monitorCheckB: env => stageCheck(env, 1),
  monitorCheckC: env => stageCheck(env, 2),
  monitorCheckD: env => stageCheck(env, 3),
  monitorCheckE: env => stageCheck(env, 4),
  monitorWrite:  env => stageWrite(env),
};

export async function runMonitorStage(env, name, { only } = {}) {
  const fn = MONITOR_STAGES[name];
  if (!fn) return { error: `stage must be one of ${Object.keys(MONITOR_STAGES).join(', ')}` };
  const started = Date.now();
  // `only` (comma-separated company names) limits a check stage, for
  // testing on a handful of companies.
  const r = only && name.startsWith('monitorCheck')
    ? await (async () => {
        const names = only.split(',').map(s => s.trim().toLowerCase());
        const boards = (await all(env, `SELECT * FROM monitor_companies WHERE ats IS NOT NULL AND status IN ('Watching','Match found')`)).filter(c => names.includes(c.name.toLowerCase()));
        // "board:ats:slug" adds a board that only clipped rows point at.
        for (const n of names.filter(n => n.startsWith('board:'))) { const [, ats, ...rest] = n.split(':'); boards.push({ page_id: null, name: null, ats, slug: rest.join(':'), clippedOnly: true }); }
        const out = await checkBoards(env, boards);
        await queueCompanyRollups(env, boards.map(b => b.page_id));
        return { boards: boards.length, checked: out.checked, newRoles: out.newRoles, closed: out.closed, failed: out.failed };
      })()
    : await fn(env);
  const rec = { ok: true, at: started, ms: Date.now() - started, ...r };
  await env.DB.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(`monitor:${name}`, JSON.stringify(rec)).run();
  return rec;
}

/* ============================================================
   Follow → Notion: following a company on the radar adds it to
   the Job Database as a company row and registers its board, so
   the next nightly run checks it. Unfollowing never deletes.
   ============================================================ */

const BOARD_HOME = {
  greenhouse: s => `https://job-boards.greenhouse.io/${s}`,
  lever:      s => `https://jobs.lever.co/${s}`,
  ashby:      s => `https://jobs.ashbyhq.com/${s}`,
  workable:   s => `https://apply.workable.com/${s}`,
};

/** Add a followed watchlist company to the Job Database. Following a
    company that sits there as Suggested (or Not interested) approves
    it: the row is set to Watching and the next sync starts the board.
    Returns { notion: 'added' | 'approved' | 'exists' | 'off' | 'error', ... }. */
export async function followToNotion(env, w) {
  if (env.MONITOR_ENABLED === 'off' || !env.NOTION_TOKEN || !env.JOB_DS_ID) return { notion: 'off' };
  const name = (w.name || '').replace(/ @ /g, ' ').trim();
  if (!name) return { notion: 'error', error: 'no name' };
  try {
    const budget = { left: 8 };
    const approve = async pageId => {
      await notion(env, 'PATCH', `/pages/${pageId}`, { properties: { 'Monitor Status': put.select('Watching') } }, budget);
      return { notion: 'approved', status: 'Watching' };
    };
    // Already monitored? Same name, or the same job board.
    const known = await env.DB.prepare(
      `SELECT page_id, status FROM monitor_companies WHERE lower(name)=lower(?) OR (ats IS NOT NULL AND ats=? AND slug=?) LIMIT 1`
    ).bind(name, w.ats || '', w.slug || '').first();
    if (known) return HOLD.has(known.status) ? approve(known.page_id) : { notion: 'exists' };
    const hits = (await queryAll(env, env.JOB_DS_ID, { property: 'Name', title: { equals: name } }, budget))
      .filter(r => !prop.formula(r.properties.Position));
    if (hits.length) return HOLD.has(prop.select(hits[0].properties['Monitor Status'])) ? approve(hits[0].id) : { notion: 'exists' };
    return await addCompanyRow(env, w, `Added ${new Date().toISOString().slice(0, 10)} by following on Startup Radar.`, budget);
  } catch (e) {
    return { notion: 'error', error: e.message.slice(0, 160) };
  }
}

/** Create the company row and register its board. The caller has
    already checked it isn't in the Job Database. A watchlist entry
    with no known board gets its careers page sniffed first. */
async function addCompanyRow(env, w, note, budget) {
  const name = (w.name || '').replace(/ @ /g, ' ').trim();
  let board = w.ats && w.slug && BOARD_HOME[w.ats] ? { ats: w.ats, slug: w.slug } : null;
  const site = w.careers || (w.website ? w.website.replace(/\/$/, '') + '/careers' : null);
  if (!board && site && budget.left >= 4) {
    budget.left -= 2;
    const d = await sniffAts(site).catch(() => null);
    if (d && BOARD_HOME[d.ats]) board = { ats: d.ats, slug: d.slug };
  }
  const careers = w.careers || (board ? BOARD_HOME[board.ats](board.slug) : null) || w.website || null;
  const status = board ? 'Watching' : careers ? 'Manual check' : 'No board found';
  const page = await notion(env, 'POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: env.JOB_DS_ID },
    properties: { Name: put.title(name), URL: put.url(careers), 'Monitor Status': put.select(status) },
    children: textToBlocks(`${note} Board: ${board ? `${board.ats}/${board.slug}` : 'none detected'}.`),
  }, budget);
  await env.DB.prepare(
    `INSERT INTO monitor_companies (page_id,name,careers,ats,slug,status,note,fails,notion_url,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)
     ON CONFLICT(page_id) DO NOTHING`
  ).bind(page.id, name, careers, board?.ats || null, board?.slug || null, status, 'added from radar watchlist', careers, Date.now()).run();
  return { notion: 'added', status };
}
