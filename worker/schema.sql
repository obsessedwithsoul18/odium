CREATE TABLE IF NOT EXISTS orders (
  capture_id  TEXT PRIMARY KEY,
  reference   TEXT NOT NULL DEFAULT '',
  order_id    TEXT NOT NULL DEFAULT '',
  amount      TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT '',
  payer_email TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT '',
  paid_at     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS licenses (
  key             TEXT PRIMARY KEY,
  discord_id      TEXT,
  email           TEXT,
  hwid_set        TEXT NOT NULL DEFAULT '[]',
  active_session  TEXT,
  banned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_reset_at   INTEGER NOT NULL DEFAULT 0,
  resets_month    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_licenses_discord ON licenses (discord_id);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  ip_hash    TEXT NOT NULL DEFAULT '',
  ua_hash    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_seen  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (key) REFERENCES licenses(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions (key);
CREATE TABLE IF NOT EXISTS builds (
  name       TEXT PRIMARY KEY,
  key_b64    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
