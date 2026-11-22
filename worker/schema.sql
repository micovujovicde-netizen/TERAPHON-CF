-- Use a BRAND-NEW Cloudflare D1 database exclusively for TERAPHON.
-- Based on the user-supplied BrakeMonster v4 schema and migration.
CREATE TABLE IF NOT EXISTS licenses (
 id TEXT PRIMARY KEY, creem_customer_id TEXT, creem_subscription_id TEXT,
 creem_order_id TEXT, product_id TEXT, customer_email TEXT,
 status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 last_event_ms INTEGER NOT NULL DEFAULT 0, last_paid_transaction_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tera_subscription ON licenses(creem_subscription_id);
CREATE TABLE IF NOT EXISTS license_transactions (
 transaction_id TEXT PRIMARY KEY, license_id TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tera_transactions ON license_transactions(license_id);
CREATE TABLE IF NOT EXISTS license_devices (
 license_id TEXT NOT NULL, token_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (license_id, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_tera_device_token ON license_devices(token_hash);
CREATE TABLE IF NOT EXISTS webhook_events (
 event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'received',
 received_at TEXT DEFAULT CURRENT_TIMESTAMP,
 processed_at TEXT, error_message TEXT
);
CREATE TABLE IF NOT EXISTS teraphon_trial_devices (
 device_fingerprint TEXT PRIMARY KEY NOT NULL,
 first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms > 0)
);

CREATE TABLE IF NOT EXISTS teraphon_activation_codes (
 license_id TEXT PRIMARY KEY NOT NULL,
 code_hash TEXT UNIQUE NOT NULL,
 code_cipher TEXT NOT NULL,
 code_nonce TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- Additive mail queue; does not modify existing licence tables.
CREATE TABLE IF NOT EXISTS teraphon_email_outbox (
  license_id TEXT PRIMARY KEY NOT NULL,
  recipient_email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);
