/* ============================================================
   yc.js — pulling the Y Combinator company directory
   ------------------------------------------------------------
   YC's public directory is backed by an Algolia index. The
   browser key is embedded in the page and rotates every few
   months, so we scrape it at run time and keep a known-good
   fallback. A hardcoded-only approach silently returns 403 and
   the whole radar goes stale without anyone noticing.
   ============================================================ */

const ALGOLIA_APP  = '45BWZJ1SGC';
const ALGOLIA_HOST = `https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;
const YC_INDEX     = 'YCCompany_production';

// Known-good key, used only if scraping the live page fails.
const FALLBACK_KEY =
  'NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE';

function b64decode(s) {
  try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
}

/** Scrape the current Algolia search key out of the YC companies page. */
export async function resolveKey() {
  try {
    const res = await fetch('https://www.ycombinator.com/companies', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/1.0)' },
      cf: { cacheTtl: 3600 },
    });
    if (res.ok) {
      const html = await res.text();
      // The key is a long base64 blob that decodes to text naming the index.
      for (const cand of html.match(/[A-Za-z0-9+/=_-]{120,}/g) || []) {
        if (b64decode(cand).includes('YCCompany')) return cand;
      }
    }
  } catch { /* fall through to the pinned key */ }
  return FALLBACK_KEY;
}

/** Fetch every company in one batch (e.g. "Summer 2026"). */
export async function fetchBatch(key, batch) {
  const facet  = encodeURIComponent(JSON.stringify([[`batch:${batch}`]]));
  const params = `query=&hitsPerPage=1000&page=0&facetFilters=${facet}`;
  const res = await fetch(ALGOLIA_HOST, {
    method: 'POST',
    headers: {
      'x-algolia-application-id': ALGOLIA_APP,
      'x-algolia-api-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests: [{ indexName: YC_INDEX, params }] }),
  });
  if (!res.ok) throw new Error(`algolia ${res.status} for ${batch}`);
  const json = await res.json();
  const out  = json?.results?.[0];
  if (!out || !Array.isArray(out.hits)) throw new Error(`no hits for ${batch}`);
  // Keep only the fields the analysis needs — long_description dominates payload size.
  return out.hits.map(h => ({
    slug:      h.slug || h.objectID,
    name:      h.name || '',
    batch:     h.batch || batch,
    oneLiner:  h.one_liner || '',
    desc:      (h.long_description || '').slice(0, 700),
    industries: h.industries || [],
    tags:      h.tags || [],
    teamSize:  h.team_size || 0,
    status:    h.status || '',
    website:   h.website || '',
    location:  h.all_locations || '',
    isHiring:  !!h.isHiring,
    url:       h.slug ? `https://www.ycombinator.com/companies/${h.slug}` : (h.website || ''),
  }));
}
