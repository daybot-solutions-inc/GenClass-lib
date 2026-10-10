-- GenClass per-app tokens and dashboards (D1 database `genclass-dashboard`).
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- One row per web app. `token` is public (ships in client code); only a SHA-256 hex of the private dashboard
-- secret is stored, so the database alone cannot be used to open a dashboard.
CREATE TABLE projects (
  token       TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created     TEXT NOT NULL,
  last_event  TEXT
);

-- Counters per UTC day. metric = what is counted, key = the breakdown value ('' for plain totals).
-- Sums (e.g. latency) are stored as metric `<name>_sum` next to `<name>_n`.
CREATE TABLE daily (
  token  TEXT NOT NULL,
  day    TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  metric TEXT NOT NULL,
  key    TEXT NOT NULL DEFAULT '',
  count  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (token, day, metric, key)
) WITHOUT ROWID;

-- The same counters per UTC hour, kept for 48 hours only (the dashboard's 24 h window).
CREATE TABLE hourly (
  token  TEXT NOT NULL,
  hour   TEXT NOT NULL,           -- YYYY-MM-DDTHH (UTC)
  metric TEXT NOT NULL,
  key    TEXT NOT NULL DEFAULT '',
  count  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (token, hour, metric, key)
) WITHOUT ROWID;

-- Recent detections / interventions, at most 500 per token. Never situation text.
CREATE TABLE recent (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL,
  t          TEXT NOT NULL,       -- ISO time the batch was received
  route      TEXT,
  fn         TEXT,
  trigger    TEXT,
  diagnosis  TEXT,
  action     TEXT,                -- the action the model chose
  ran        TEXT,                -- the action that actually ran
  confidence REAL,
  mode       TEXT,                -- effectiveMode
  executed   INTEGER,
  acted      INTEGER,
  kind       TEXT                 -- 'detect' | 'acted'
);
CREATE INDEX recent_token_id ON recent (token, id);
CREATE INDEX recent_t ON recent (t);

-- Last cumulative `summary` counters seen per page load (sid hashed), so repeated summaries are counted as deltas.
-- Kept for 2 days.
CREATE TABLE sessions (
  sid_hash TEXT PRIMARY KEY,
  token    TEXT NOT NULL,
  day      TEXT NOT NULL,
  counts   TEXT NOT NULL
);
CREATE INDEX sessions_day ON sessions (day);
