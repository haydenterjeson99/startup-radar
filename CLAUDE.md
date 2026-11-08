# startup-radar

Startup and job-search intelligence (Bay Area; EO/geospatial, drones/defense, climate sensing). Live site: https://haydenterjeson99.github.io/startup-radar/

- Frontend: single `index.html`, GitHub Pages, no build step.
- Backend: Cloudflare Worker `startup-intel` in `worker/` with D1 database `startup-intel`. Staged crons in `worker/wrangler.toml`; stage map is in `worker/src/index.js` and README "Architecture".
- Key modules: `collect.js`/`sources.js` (feeds), `yc.js`/`analyze.js` (landscape), `brief.js` (daily brief), `monitor.js`/`notion.js` (private job monitor over the Notion Job Database), `prepare.js` (Prepare to Apply → fires a Claude Code routine), `intel.js` (persistent intel store), `watchlist.js`.
- Deploy worker: `cd worker && npx wrangler deploy` (wrangler is logged in). Remote D1: `npx wrangler d1 execute startup-intel --remote --command "…"`.
- Secrets: `wrangler secret put` (NOTION_TOKEN, ROUTINE_ID, ROUTINE_TOKEN, …) and `worker/.dev.vars` — never in git. `monitor-private/` is gitignored.
- Related: skill `~/.claude/skills/add-job-company`, scheduled task `startup-radar-morning-brief`, `morning-brief-prompt.md`.
- Branches: `wip/prepare-to-apply` (snapshot of in-progress work), `archive/desktop-draft-2026-08` (old draft copy, reference only).
