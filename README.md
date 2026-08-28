# Startup Radar

Competitive intelligence on where companies are being built — which industries
are absorbing founders, which gaps are closing, and what they're building with.

Live: <https://haydenterjeson99.github.io/startup-radar/>

## Three views

| View | Question it answers | Source |
|---|---|---|
| **Brief** | What moved since yesterday? | pre-computed nightly |
| **Landscape** | What is the structural shape of the current YC batch? | pre-computed nightly |
| **Feed** | What happened on the wire today? | fetched in the browser |

## Architecture

```
index.html ── GitHub Pages, no build step
   │
   ├── feeds + dismiss sync ──► nsl-proxy.haydenmterjeson.workers.dev
   │                              (shared with the NSL intelligence feed)
   │
   └── landscape + brief ─────► startup-intel.haydenmterjeson.workers.dev
                                  │
                                  ├── cron 09:15 UTC nightly
                                  ├── D1: startup-intel
                                  └── pulls ycombinator.com/companies
```

The split matters. The feed is fetched client-side, because it's a few hundred
RSS requests and it's fine for those to trickle in. The landscape is **not** —
re-analysing 900+ YC companies on every page load would make the page unusable,
so the worker does it once a night and the page reads a snapshot.

### Why the YC key is scraped, not hardcoded

YC's directory is backed by an Algolia index whose public browser key rotates
every few months. A hardcoded key fails closed and silently — the radar would
just stop updating with no error anyone would notice. `worker/src/yc.js`
scrapes the current key from the live page on every run and keeps a pinned key
only as a fallback.

## Worker

```
worker/
  wrangler.toml     name, cron trigger, D1 binding
  schema.sql        snapshots + companies tables
  src/
    index.js        routes, cron handler, snapshot storage
    yc.js           Algolia key resolution + batch fetching
    taxonomy.js     what we measure — themes, tools, gaps
    analyze.js      rosters -> landscape
    news.js         funding/launch RSS
    brief.js        the morning brief
```

### Endpoints

| Route | Returns |
|---|---|
| `GET /api/landscape` | full analysis JSON |
| `GET /api/brief` | the morning brief, structured |
| `GET /api/brief.txt` | the same brief as plain text |
| `GET /api/refresh` | forces a rebuild now |
| `GET /?url=…` | CORS proxy |
| `GET /health` | liveness |

### Deploying

```sh
cd worker
npx wrangler deploy
```

Schema changes:

```sh
npx wrangler d1 execute startup-intel --remote --file=schema.sql
```

## Tuning what gets measured

Everything measurable lives in `worker/src/taxonomy.js` — three lists of
keyword sets (`THEMES`, `TOOLS`, `GAPS`). Add a theme by adding an entry; the
site picks it up on the next rebuild with no front-end change.

Counts are keyword matches against each company's one-line pitch, the opening
of its long description, and its tags. That measures **how founders describe
themselves**, which is the point — but it slightly undercounts companies that
avoid the common vocabulary. Industry percentages use YC's own taxonomy, which
is applied consistently across batches and is what makes the year-over-year
comparison trustworthy.

A batch under 60 companies is too small to read as a trend and is skipped as
the "current" cohort, so a newly-opened batch doesn't distort the numbers.

## Morning brief

A scheduled task (`startup-radar-morning-brief`) emails the brief on weekday
mornings at 6:30 local. It reads `/api/brief` and renders it — it does not
generate any analysis of its own, so the email can't drift from the site.

The brief is deterministic: every sentence traces to a count in the snapshot.
Nothing in it is model-written.
