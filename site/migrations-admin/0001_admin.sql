-- genclass.dev/admin aggregates, filled every minute from the telemetry collector's R2 bucket.
CREATE TABLE IF NOT EXISTS processed (key TEXT PRIMARY KEY, at TEXT NOT NULL, events INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, host TEXT NOT NULL DEFAULT '', route TEXT, runtime TEXT, model TEXT, mode TEXT, country TEXT,
  device TEXT, first_at TEXT NOT NULL, last_at TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_host ON sessions (host);
CREATE INDEX IF NOT EXISTS sessions_first ON sessions (first_at);
-- daily counters per host: metric (decisions, detections, acted, undos, actions_ok, actions_failed, model_ready,
-- model_error, model_load_ms, model_load_n, sessions) with an optional breakdown key (diagnosis, action, backend...)
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL, host TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', n REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host, metric, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS recent (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, sid TEXT, host TEXT, route TEXT, kind TEXT, trigger TEXT,
  diagnosis TEXT, action TEXT, ran TEXT, confidence REAL, mode TEXT, outcome TEXT, runtime TEXT
);
CREATE INDEX IF NOT EXISTS recent_at ON recent (at);
