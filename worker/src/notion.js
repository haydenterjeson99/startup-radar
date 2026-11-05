/* ============================================================
   notion.js — a small Notion API client for the job monitor
   ------------------------------------------------------------
   Uses the NOTION_TOKEN secret. Notion allows about three
   requests a second per integration, so calls are spaced out
   and a 429 (or a 5xx) is retried after Retry-After.
   Nothing here logs request bodies or the token.
   ============================================================ */

const API = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';
const GAP_MS = 350;

let last = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One Notion call. Counts against the stage's outbound budget
    (including retries), so callers pass a `budget` object. */
export async function notion(env, method, path, body, budget) {
  if (!env.NOTION_TOKEN) throw new Error('NOTION_TOKEN secret is not set');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (budget) { if (budget.left <= 0) throw new Error('request budget used up'); budget.left--; }
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const ra = +(res.headers.get('Retry-After') || 0);
      await sleep(Math.min(Math.max(ra * 1000, 1000 * 2 ** attempt), 10000));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`notion ${method} ${path.split('?')[0]} ${res.status} ${j.code || ''}`);
    return j;
  }
  throw new Error(`notion ${method} ${path.split('?')[0]} kept failing (rate limit or 5xx)`);
}

/** Every row of a data source (paged). */
export async function queryAll(env, dataSourceId, filter, budget) {
  const out = [];
  let cursor;
  do {
    const j = await notion(env, 'POST', `/data_sources/${dataSourceId}/query`,
      { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) }, budget);
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

/** Plain text of a page body (top-level blocks only). */
export async function pageText(env, pageId, budget) {
  const j = await notion(env, 'GET', `/blocks/${pageId}/children?page_size=100`, null, budget);
  return (j.results || []).map(b => (b[b.type]?.rich_text || []).map(t => t.plain_text).join('')).filter(Boolean).join('\n');
}

/* ---------- property readers ---------- */

export const prop = {
  title:   p => (p?.title || []).map(t => t.plain_text).join(''),
  text:    p => (p?.rich_text || []).map(t => t.plain_text).join(''),
  select:  p => p?.select?.name || null,
  url:     p => p?.url || null,
  date:    p => p?.date?.start || null,
  number:  p => p?.number ?? null,
  formula: p => p?.formula ? (p.formula.string ?? p.formula.number ?? p.formula.boolean ?? p.formula.date?.start ?? null) : null,
};

/* ---------- property writers ---------- */

const rt = s => [{ type: 'text', text: { content: String(s).slice(0, 2000) } }];
export const put = {
  title:  s => ({ title: rt(s) }),
  text:   s => ({ rich_text: s ? rt(s) : [] }),
  select: s => ({ select: s ? { name: s } : null }),
  url:    s => ({ url: s || null }),
  date:   s => ({ date: s ? { start: s } : null }),
  number: n => ({ number: n ?? null }),
};

/** Split posting text into paragraph blocks under Notion's
    2,000-character limit, breaking on paragraph then word. */
export function textToBlocks(text, max = 1900) {
  const blocks = [];
  for (const para of (text || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean)) {
    let rest = para;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      blocks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    if (rest) blocks.push(rest);
  }
  return blocks.map(s => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(s) } }));
}
