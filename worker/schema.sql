CREATE TABLE IF NOT EXISTS snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  INTEGER NOT NULL,
  payload   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_taken ON snapshots(taken_at DESC);

CREATE TABLE IF NOT EXISTS companies (
  slug        TEXT PRIMARY KEY,
  name        TEXT,
  batch       TEXT,
  one_liner   TEXT,
  industries  TEXT,
  tags        TEXT,
  url         TEXT,
  first_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_seen  ON companies(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_companies_batch ON companies(batch);

-- v2: feeds, Bay Area tracking, editable watchlist, no-repeat brief

CREATE TABLE IF NOT EXISTS articles (
  id            TEXT PRIMARY KEY,      -- fnv1a of normalised title, same as the old front end
  tab           TEXT NOT NULL,
  tier          INTEGER NOT NULL,      -- 1 publisher feed, 2 search
  title         TEXT NOT NULL,
  link          TEXT NOT NULL,
  source        TEXT,
  published_at  INTEGER,
  excerpt       TEXT,
  sectors       TEXT,                  -- JSON array of sector ids
  bay           INTEGER DEFAULT 0,
  funding       INTEGER DEFAULT 0,
  first_seen    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_seen ON articles(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_articles_pub  ON articles(published_at DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sector        TEXT,
  city          TEXT,
  website       TEXT,
  careers       TEXT,
  ats           TEXT,
  slug          TEXT,
  aliases       TEXT,                  -- JSON array
  needs_context INTEGER DEFAULT 0,
  note          TEXT,
  starred       INTEGER DEFAULT 0,     -- Hayden's own "interesting" list
  origin        TEXT DEFAULT 'seed',   -- seed | user
  removed       INTEGER DEFAULT 0,
  open_roles    INTEGER,
  roles_checked INTEGER,
  added_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,        -- ats:slug:postingId
  company_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  location    TEXT,
  dept        TEXT,
  url         TEXT,
  core        INTEGER DEFAULT 0,       -- RevOps / sales ops / bizops
  bay         INTEGER DEFAULT 0,
  remote      INTEGER DEFAULT 0,
  posted_at   INTEGER,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  baseline    INTEGER DEFAULT 0        -- was already open the first time we read the board
);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_seen    ON jobs(first_seen DESC);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  start_at    INTEGER NOT NULL,
  city        TEXT,
  url         TEXT,
  source      TEXT,
  first_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);

-- Everything the brief has ever shown, so it never shows it twice.
CREATE TABLE IF NOT EXISTS sent (
  key      TEXT PRIMARY KEY,
  sent_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Dismissed feed cards, moved here from the shared NSL proxy.
CREATE TABLE IF NOT EXISTS dismissals (
  device_id   TEXT NOT NULL,
  article_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (device_id, article_id)
);

/* ---------- private job monitor (monitor.js) ----------
   Holds the company list and Notion row ids for the job monitor.
   Never read by the site, the brief or news matching; exposed
   only through /api/monitor, which needs X-Radar-Key. */
CREATE TABLE IF NOT EXISTS monitor_companies (
  page_id      TEXT PRIMARY KEY,        -- Notion company row
  name         TEXT NOT NULL,
  careers      TEXT,                    -- careers URL written to Notion
  ats          TEXT,
  slug         TEXT,
  status       TEXT,                    -- Watching | Match found | Manual check | No board found
  note         TEXT,
  fails        INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  last_checked INTEGER,                 -- last successful board check (ms)
  notion_url   TEXT,                    -- URL as last seen in Notion, to spot edits
  updated_at   INTEGER
);
CREATE TABLE IF NOT EXISTS monitor_roles (
  key          TEXT PRIMARY KEY,        -- posting key, or URL without query string
  page_id      TEXT,                    -- Notion role row (null until written)
  company_id   TEXT,                    -- monitor_companies.page_id, null for clipped rows of other companies
  board        TEXT,                    -- ats:slug the role lives on
  title        TEXT,
  url          TEXT,
  level        TEXT,
  work_loc     TEXT,
  status       TEXT NOT NULL,           -- Open | Closed
  clipped      INTEGER NOT NULL DEFAULT 0,  -- row existed before the monitor saw it
  fit          TEXT,                    -- copied from Notion each night
  first_seen   TEXT,                    -- YYYY-MM-DD
  last_seen    INTEGER,
  missed       INTEGER NOT NULL DEFAULT 0,
  gone         INTEGER NOT NULL DEFAULT 0   -- Notion row deleted by hand; never recreate
);
CREATE INDEX IF NOT EXISTS monitor_roles_company ON monitor_roles(company_id);
CREATE INDEX IF NOT EXISTS monitor_roles_board   ON monitor_roles(board);
CREATE TABLE IF NOT EXISTS monitor_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,            -- create | role | company
  ref         TEXT NOT NULL,            -- role key or company page id
  payload     TEXT,
  tries       INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_queue_ref ON monitor_queue(kind, ref);

/* ---------- company intel store (intel.js) ----------
   Kept forever and built up nightly; also created on first use. */
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT, city TEXT, bay INTEGER DEFAULT 0,
  sectors TEXT, one_liner TEXT, yc_slug TEXT, yc_batch TEXT, team_size INTEGER, yc_hiring INTEGER DEFAULT 0,
  ats TEXT, ats_slug TEXT, open_roles INTEGER, gtm_roles INTEGER, gtm_titles TEXT, roles_checked INTEGER,
  sources TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS org_news (
  org_id TEXT NOT NULL, article_id TEXT NOT NULL, title TEXT, link TEXT, source TEXT,
  published_at INTEGER, funding INTEGER DEFAULT 0, PRIMARY KEY (org_id, article_id));
CREATE INDEX IF NOT EXISTS idx_org_news_org ON org_news(org_id, published_at DESC);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, org_name TEXT, kind TEXT, amount_usd INTEGER, valuation_usd INTEGER,
  investors TEXT, acquirer TEXT, article_id TEXT, title TEXT, link TEXT, source TEXT,
  announced_at INTEGER, bay INTEGER DEFAULT 0, sectors TEXT, first_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rounds_org ON rounds(org_id, announced_at DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_article ON rounds(article_id);
CREATE TABLE IF NOT EXISTS org_daily (
  org_id TEXT NOT NULL, day TEXT NOT NULL, open_roles INTEGER, gtm_roles INTEGER, PRIMARY KEY (org_id, day));
CREATE TABLE IF NOT EXISTS suggestions (
  org_id TEXT PRIMARY KEY, reasons TEXT, score REAL, status TEXT NOT NULL DEFAULT 'open',
  first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL);
