-- Odium licensing schema
-- Run: wrangler d1 execute licdb --file=schema.sql --remote

-- -----------------------------------------------------------------------
-- Orders: idempotency store for PayPal captures.
-- INSERT OR IGNORE makes claim() atomic so a capture + racing webhook
-- never both send the same receipt.
-- -----------------------------------------------------------------------
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

-- -----------------------------------------------------------------------
-- Licenses: one row per key.
--
-- hwid_set        JSON array of up to 5 salted component hashes.
--                 Set on first successful /auth. Cleared on /reset.
-- active_session  Token of the ONE session that may /heartbeat right now.
--                 Overwritten every /auth → second PC boots the first.
-- banned          1 = key is dead, all endpoints reject it immediately.
-- resets_month    Counter reset on the 1st of each month (or on demand).
-- last_reset_at   Unix-ms timestamp, enforces the 72-hour cooldown.
-- -----------------------------------------------------------------------
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

-- -----------------------------------------------------------------------
-- Sessions: lookup table so /heartbeat and /payload don't need the key.
-- -----------------------------------------------------------------------
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

-- -----------------------------------------------------------------------
-- Builds: one AES-GCM key per shipped binary.
-- If one key leaks you burn that build, not every build you've ever shipped.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builds (
  name       TEXT PRIMARY KEY,
  key_b64    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- -----------------------------------------------------------------------
-- Challenges: single-use nonces for challenge-response auth.
-- Prevents replay attacks — a captured auth request can never be reused.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenges (
  nonce      TEXT PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  used_at    INTEGER
);

-- Auto-expire old challenges (run periodically or on insert)
CREATE INDEX IF NOT EXISTS idx_challenges_created ON challenges (created_at);

-- -----------------------------------------------------------------------
-- Auth log: every auth attempt logged for anomaly detection.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash   TEXT NOT NULL,     -- sha256 of the key, never the key itself
  ip_hash    TEXT NOT NULL,
  hwid_hash  TEXT NOT NULL,     -- sha256 of the joined hwid hashes
  result     TEXT NOT NULL,     -- 'ok' | 'invalid_key' | 'hwid_mismatch' | 'banned' | 'challenge_fail'
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_auth_log_key ON auth_log (key_hash);
CREATE INDEX IF NOT EXISTS idx_auth_log_created ON auth_log (created_at);
