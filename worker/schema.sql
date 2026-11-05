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
