/* ============================================================
   analyze.js — turn raw batch rosters into the landscape
   ============================================================ */
import { THEMES, TOOLS, GAPS, INDUSTRIES } from './taxonomy.js';

/* Headline vocabulary. Themes are deliberately precise — "agent
   infrastructure" is not the same as saying the word "agent" — so we
   track the bare vocabulary separately. This is what moves fastest
   and what reads best as a headline number. */
const VOCAB = [
  ['agents',       /(^|[^a-z])agent(s|ic)?([^a-z]|$)/i],
  ['AI-native',    /ai[- ]native/i],
  ['robots',       /(^|[^a-z])robot/i],
  ['data centers', /data ?cent(er|re)/i],
  ['world models', /world model/i],
  ['evals',        /(^|[^a-z])(eval|benchmark)/i],
  ['MCP',          /(^|[^a-z])mcp([^a-z]|$)/i],
  ['humanoids',    /humanoid/i],
  ['nuclear',      /nuclear/i],
  ['defense',      /defen[cs]e/i],
];

/* Companies carry more than one tag, so shares never sum to 100%. */
const pct = (k, n) => (n ? +(100 * k / n).toFixed(1) : 0);

/** Everything a founder wrote about themselves, lowercased once. */
function blob(c) {
  return `${c.oneLiner} ${c.desc} ${(c.tags || []).join(' ')} ${(c.industries || []).join(' ')}`.toLowerCase();
}

function matches(text, kw) {
  for (const re of kw) if (re.test(text)) return true;
  return false;
}

/** Score a keyword set against one batch, keeping the matched roster. */
function scoreSet(hits, kw) {
  const roster = [];
  for (const c of hits) if (matches(c._blob, kw)) roster.push(c);
  return { count: roster.length, share: pct(roster.length, hits.length), roster };
}

/* A roster line is what makes the page readable — a few named
   companies beat any number of percentages. */
const rosterOf = (list, n = 10) => list.slice(0, n).map(c => ({
  name: c.name, oneLiner: c.oneLiner, url: c.url, batch: c.batch,
}));

function heatOf(delta, share) {
  if (share >= 12 && delta > 2)  return 'crowded';
  if (delta >= 3)                return 'filling fast';
  if (delta <= -2)               return 'cooling';
  if (share < 5)                 return 'open';
  return 'steady';
}

/**
 * @param batches  { "Summer 2026": [company], ... } newest first by convention
 * @param order    batch labels, most recent first
 */
export function buildLandscape(batches, order) {
  for (const label of order) for (const c of batches[label] || []) c._blob = blob(c);

  // Current batch = the most recent one large enough to read as a trend.
  const current = order.find(b => (batches[b] || []).length >= 60) || order[0];
  const cur     = batches[current] || [];
  // Prior batch (the one before current) and the year-ago batch of the same season.
  const prior   = order[order.indexOf(current) + 1];
  const season  = current.split(' ')[0];
  const year    = +current.split(' ')[1];
  const yearAgo = order.find(b => b === `${season} ${year - 1}`) || order[order.length - 1];

  const priorHits   = batches[prior]   || [];
  const yearAgoHits = batches[yearAgo] || [];

  /* ---- Industry share, current vs a year ago ---- */
  const industries = INDUSTRIES.map(name => {
    const has = h => h.filter(c => (c.industries || []).includes(name)).length;
    const nowN = has(cur), thenN = has(yearAgoHits);
    const now = pct(nowN, cur.length), then = pct(thenN, yearAgoHits.length);
    return { label: name, now, then, nowN, thenN, deltaPP: +(now - then).toFixed(1) };
  }).filter(r => r.nowN || r.thenN)
    .sort((a, b) => b.now - a.now);

  /* ---- Themes ---- */
  const themes = THEMES.map(t => {
    const now  = scoreSet(cur, t.kw);
    const then = scoreSet(yearAgoHits, t.kw);
    const prev = scoreSet(priorHits, t.kw);
    return {
      id: t.id, label: t.label, blurb: t.blurb,
      count: now.count, share: now.share,
      thenCount: then.count, thenShare: then.share,
      prevShare: prev.share,
      deltaPP: +(now.share - then.share).toFixed(1),
      companies: rosterOf(now.roster),
    };
  }).sort((a, b) => b.count - a.count);

  /* ---- Tools ---- */
  const tools = TOOLS.map(t => {
    const now = scoreSet(cur, t.kw), then = scoreSet(yearAgoHits, t.kw);
    return {
      id: t.id, label: t.label, note: t.note,
      count: now.count, share: now.share,
      deltaPP: +(now.share - then.share).toFixed(1),
      companies: rosterOf(now.roster, 6),
    };
  }).sort((a, b) => b.count - a.count);

  /* ---- Gaps, with a crowding read ---- */
  const gaps = GAPS.map(g => {
    const now = scoreSet(cur, g.kw), then = scoreSet(yearAgoHits, g.kw);
    const deltaPP = +(now.share - then.share).toFixed(1);
    return {
      n: g.n, problem: g.problem, response: g.response,
      count: now.count, share: now.share, deltaPP,
      heat: heatOf(deltaPP, now.share),
      companies: rosterOf(now.roster, 6),
    };
  }).sort((a, b) => b.count - a.count);

  /* ---- Whitespace: what is conspicuously thin ---- */
  const thin = industries
    .filter(i => i.now < 8 && i.label !== 'Unspecified')
    .sort((a, b) => a.now - b.now)
    .slice(0, 6)
    .map(i => ({
      label: i.label, share: i.now, count: i.nowN, deltaPP: i.deltaPP,
      falling: i.deltaPP < 0,
    }));

  /* ---- Headline vocabulary, current vs a year ago ---- */
  const vocabulary = VOCAB.map(([term, re]) => {
    const nowN  = cur.filter(c => re.test(c._blob)).length;
    const thenN = yearAgoHits.filter(c => re.test(c._blob)).length;
    const now = pct(nowN, cur.length), then = pct(thenN, yearAgoHits.length);
    return { term, count: nowN, share: now, thenCount: thenN, thenShare: then,
             deltaPP: +(now - then).toFixed(1) };
  }).sort((a, b) => b.count - a.count);

  return {
    generatedAt: Date.now(),
    current, prior, yearAgo, vocabulary,
    batchSizes: Object.fromEntries(order.map(b => [b, (batches[b] || []).length])),
    industries, themes, tools, gaps, thin,
  };
}
