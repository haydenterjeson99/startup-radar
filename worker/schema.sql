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
