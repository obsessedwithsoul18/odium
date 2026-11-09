-- D1 schema for order de-duplication.
-- One row per PayPal capture. INSERT OR IGNORE makes the claim atomic, which is
-- what stops a capture and a racing webhook from both emailing the same sale.

CREATE TABLE IF NOT EXISTS orders (
  capture_id  TEXT PRIMARY KEY,
  reference   TEXT NOT NULL DEFAULT '',
  order_id    TEXT NOT NULL DEFAULT '',
  amount      TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT '',
  payer_name  TEXT NOT NULL DEFAULT '',
  payer_email TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT '',
  paid_at     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders (reference);
