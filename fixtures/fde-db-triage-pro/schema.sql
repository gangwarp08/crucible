-- fde-db-triage-pro synthetic schema (GENERATED — do not edit by hand)
-- Portable subset that runs in both Postgres (\i schema.sql) and SQLite (.read schema.sql).
-- Regenerate via:  pnpm exec tsx fixtures/fde-db-triage-pro/generate.ts

DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  plan         TEXT NOT NULL,
  mrr          INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  status       TEXT NOT NULL
);

CREATE TABLE payments (
  id                   TEXT PRIMARY KEY,
  external_payment_id  TEXT NOT NULL,
  subscription_id      TEXT NOT NULL,
  amount_cents         INTEGER NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX payments_external_payment_id ON payments (external_payment_id);
CREATE INDEX payments_created_at          ON payments (created_at);
CREATE INDEX payments_status              ON payments (status);
CREATE INDEX subscriptions_status         ON subscriptions (status);
CREATE INDEX customers_name               ON customers (name);
