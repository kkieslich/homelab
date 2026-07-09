-- Schema for the actual.sqlite read-replica that Grafana queries against.
-- The sync container drops + recreates these tables on every refresh so this
-- file is the single source of truth for the schema.

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  offbudget     INTEGER NOT NULL,
  closed        INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  group_name TEXT,
  is_income  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payees (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  transfer_account_id TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id                  TEXT PRIMARY KEY,
  date                TEXT NOT NULL,             -- 'YYYY-MM-DD'
  account_id          TEXT NOT NULL,
  account_name        TEXT NOT NULL,
  account_offbudget   INTEGER NOT NULL,
  amount_cents        INTEGER NOT NULL,
  payee_id            TEXT,
  payee_name          TEXT,
  category_id         TEXT,
  category_name       TEXT,
  category_group_name TEXT,
  category_is_income  INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  cleared             INTEGER NOT NULL DEFAULT 0,
  reconciled          INTEGER NOT NULL DEFAULT 0,
  transfer_id         TEXT,
  is_transfer         INTEGER NOT NULL DEFAULT 0,
  imported_id         TEXT,
  -- Denormalised time slices for cheap GROUP BY in Grafana.
  year                INTEGER NOT NULL,
  month               TEXT    NOT NULL,           -- 'YYYY-MM'
  ymd_unix            INTEGER NOT NULL            -- midnight UTC of the tx date, seconds
);

-- Subscription detection lives in the sync container (reuses cli/src/commands/subs.mjs)
-- and the results land here so Grafana can render them as a table.
CREATE TABLE IF NOT EXISTS subscriptions (
  payee_id           TEXT PRIMARY KEY,
  payee_name         TEXT NOT NULL,
  cadence            TEXT NOT NULL,
  per_year           INTEGER NOT NULL,
  median_cents       INTEGER NOT NULL,
  min_cents          INTEGER NOT NULL,
  max_cents          INTEGER NOT NULL,
  annualized_cents   INTEGER NOT NULL,
  count              INTEGER NOT NULL,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  days_since_last    INTEGER NOT NULL,
  is_active          INTEGER NOT NULL,
  confidence         REAL NOT NULL
);

-- Pipeline freshness — one row per bank from fints-status.json + an internal
-- 'sync' row updated by this container. Compute the age dynamically in your
-- query (e.g. `strftime('%s','now') - strftime('%s', last_run_iso)`) — never
-- store it, it'd go stale between db-sync cycles.
CREATE TABLE IF NOT EXISTS pipeline_status (
  source             TEXT PRIMARY KEY,            -- e.g. 'umwelt', 'fnz', 'sync'
  last_run_iso       TEXT NOT NULL,
  added              INTEGER,
  updated            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tx_date          ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_month         ON transactions(month);
CREATE INDEX IF NOT EXISTS idx_tx_ymd_unix      ON transactions(ymd_unix);
CREATE INDEX IF NOT EXISTS idx_tx_category      ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_category_name ON transactions(category_name);
CREATE INDEX IF NOT EXISTS idx_tx_payee         ON transactions(payee_id);
CREATE INDEX IF NOT EXISTS idx_tx_account       ON transactions(account_id);

-- Securities holdings (current snapshot, drop+re-insert each db-sync cycle).
-- Populated from holdings.json that fints-actual-bridge writes on import for
-- depot accounts (currently only finanzen-zero / Baader Bank).
CREATE TABLE IF NOT EXISTS holdings (
  depot_account_id          TEXT NOT NULL,
  depot_account_name        TEXT NOT NULL,
  isin                      TEXT NOT NULL,
  name                      TEXT NOT NULL,
  pieces                    REAL NOT NULL,
  market_value_cents        INTEGER NOT NULL,   -- price per share at valuation_date
  total_value_cents         INTEGER NOT NULL,   -- pieces * market_value
  currency                  TEXT NOT NULL,
  valuation_date            TEXT,
  acquisition_price_cents   INTEGER,
  PRIMARY KEY (depot_account_id, isin)
);

-- Append-only history table — one row per holding per fetch-snapshot. Lets
-- Grafana plot portfolio value over time. Keyed on the snapshot timestamp +
-- holding so re-runs of db-sync against the same holdings.json are no-ops.
CREATE TABLE IF NOT EXISTS holdings_history (
  snapshot_iso              TEXT NOT NULL,
  snapshot_unix             INTEGER NOT NULL,
  depot_account_id          TEXT NOT NULL,
  isin                      TEXT NOT NULL,
  name                      TEXT NOT NULL,
  pieces                    REAL NOT NULL,
  total_value_cents         INTEGER NOT NULL,
  PRIMARY KEY (snapshot_unix, depot_account_id, isin)
);
CREATE INDEX IF NOT EXISTS idx_holdings_history_unix ON holdings_history(snapshot_unix);

-- ===== Views =====
-- Single source of truth for "spending" — every dashboard query that counts
-- outflows reads from this view instead of repeating a 4-clause WHERE. Drops
-- off-budget accounts (depots), transfers (linked to another account), inflows
-- (positive amounts), and explicit income categories.
DROP VIEW IF EXISTS spending;
CREATE VIEW spending AS
SELECT *
FROM transactions
WHERE account_offbudget = 0
  AND transfer_id IS NULL
  AND amount_cents < 0
  AND COALESCE(category_is_income, 0) = 0;

-- Mirror view for the income side. Inflows on on-budget accounts that are
-- categorised as income (Salary, Refunds, Family & Gifts, Interest & Dividends).
DROP VIEW IF EXISTS income;
CREATE VIEW income AS
SELECT *
FROM transactions
WHERE account_offbudget = 0
  AND transfer_id IS NULL
  AND amount_cents > 0
  AND COALESCE(category_is_income, 0) = 1;

-- ===== Budget targets =====
-- Per-category monthly budget targets in cents. Populated each db-sync cycle
-- from cli/config/budget.json — drop+insert means the JSON is the source of
-- truth and changes there propagate within 5 minutes.
CREATE TABLE IF NOT EXISTS budgets (
  category_name TEXT PRIMARY KEY,
  monthly_cents INTEGER NOT NULL
);
