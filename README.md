# Startup Radar

Competitive and job-search intelligence on the startup environment, with a
Bay Area focus on three sectors: **EO & geospatial**, **drones, autonomy &
defense**, and **climate & risk sensing**.

Live: <https://haydenterjeson99.github.io/startup-radar/>

## Four views

| View | Question it answers | Source |
|---|---|---|
| **Brief** | What's new since the last brief? (never repeats) | built every weekday |
| **Bay Area** | Who is hiring for GTM, raising, in the news, and meeting up? Plus the editable watchlist | nightly |
| **Feed** | What happened on the wire? | nightly, from publisher RSS |
| **Landscape** | What is the structural shape of the current YC batch? | nightly |

## Architecture

```
index.html ── GitHub Pages, no build step
   │
   └── everything ────► startup-intel.haydenmterjeson.workers.dev
                          │
                          ├── cron "*/5 9 * * *" — one stage per firing:
                          │     09:00 feeds A    publisher RSS + search
                          │     09:05 feeds B    publisher RSS + search + watchlist names
                          │     09:10 jobs       watchlist job boards (Greenhouse/Lever/Ashby/Workable)
                          │     09:15 events     Luma (SF) + sector calendars
                          │     09:20 yc         YC directory → landscape; brief on weekdays
                          └── D1: startup-intel
```

The page no longer uses the shared `nsl-proxy` worker at all — feeds, dismiss
sync and the reader proxy all live on `startup-intel`, so the NSL work app is
untouched by anything here.

Stages are split because the Workers free plan allows 50 outbound requests per
invocation. Each stage stays under that; `/api/sources` shows what each stage
did last night, including any source that failed.

## Sources

All in `worker/src/sources.js`.

- **Tier 1 — publisher feeds** (the backbone): TechCrunch (startups, venture,
  space, climate, robotics), Crunchbase News, SF Standard, GeoConnexion,
  GIM International, Spatial Source, Via Satellite, Payload, SpaceNews,
  Canary Media, Latitude Media, CTVC, Trellis, Construction Dive, Utility Dive,
  DroneLife, sUAS News, DroneXL, The Robot Report, Breaking Defense,
  Defense One, DefenseScoop, Defense News, Insurance Journal, Artemis.
- **Tier 2 — keyword search** (safety net): a few tight Google/Bing News
  queries, plus one sweep for every watchlist company name. Labelled
  "via search" on the site and ranked below tier 1 in the brief.
- **Jobs**: each watchlist company's public job board API. Kept: RevOps/GTM
  titles (sales, BD, partnerships, CS, solutions) in the Bay Area or remote-US.
  Interns, accounting, legal and recruiting are excluded.
- **Events**: Luma's public San Francisco listing, filtered to the three
  sectors by title, plus the Defense Tech Luma calendar and GeoMeetup.

## The brief

`worker/src/brief.js`. Built from what is **new**:

1. New GTM roles at watchlist companies (RevOps first)
2. Watchlist companies in the news (max two stories per company)
3. Funding / M&A in the three sectors (Bay Area first)
4. Top sector stories from tier-1 publishers
5. Newly listed Bay Area events
6. YC landscape — only when a share moved ≥1.5pp since it last appeared
7. New YC companies in the three sectors

Every item shown is written to the `sent` table and is never eligible again.
Brief builds only on weekdays (the email only goes Mon–Fri), so Monday's
covers the weekend. A quiet day gives a short brief, not padding. Selection is
fixed rules — nothing is model-written.

`/api/brief/preview` shows what the next brief would contain right now,
without marking anything as sent.

## The watchlist

Seeded from `worker/src/watchlist.js` (31 companies, each job board verified),
then edited from the site's **Bay Area → Watchlist** tab: add a company, star
the ones you're interested in, remove ones you're not. Adding a company with a
careers link auto-detects its job board and reads current roles immediately.

Edits need the passphrase stored on the worker as the `RADAR_KEY` secret; the
site asks for it once and keeps it in that browser.

Names that are ordinary words (Planet, Felt, Kettle, Zipline, Pano, One
Concern) only match when the story also uses sector vocabulary.

## Endpoints

| Route | Returns |
|---|---|
| `GET /api/brief` · `/api/brief.txt` | the latest brief |
| `GET /api/brief/preview` | what the next brief would contain (dry run) |
| `GET /api/bayarea` | watchlist, open roles, funding, mentions, events |
| `GET /api/articles?days=30` | the feed |
| `GET /api/landscape` | YC analysis |
| `GET /api/sources` | last run of every stage, per source |
| `GET/POST/DELETE /api/watchlist` | watchlist (writes need `X-Radar-Key`) |
| `GET /api/refresh?stage=feedsA\|feedsB\|jobs\|events\|yc\|brief` | run a stage now (needs `X-Radar-Key`) |
| `GET /?url=…` | CORS proxy for the reader |
| `GET /health` | liveness |

## Deploying

```sh
cd worker
npx wrangler d1 execute startup-intel --remote --file=schema.sql   # additive, safe to re-run
npx wrangler secret put RADAR_KEY                                   # once
npx wrangler deploy
```

Local testing: put `RADAR_KEY=anything` in `worker/.dev.vars` (git-ignored),
then `npx wrangler d1 execute startup-intel --local --file=schema.sql` and
`npx wrangler dev --local`.

## Morning email

A task in the **Claude app's Scheduled tasks** (not Claude Code's) emails the
brief on weekday mornings. Its prompt is in `morning-brief-prompt.md`. It only
renders `/api/brief` and adds nothing of its own, so the email can't drift from
the site.

## Landscape (YC)

Unchanged from v1: `worker/src/yc.js` scrapes YC's rotating Algolia key at
runtime; `taxonomy.js` holds the THEMES / TOOLS / GAPS keyword sets;
`analyze.js` turns batch rosters into the landscape.
