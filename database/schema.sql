PRAGMA foreign_keys = ON;

CREATE TABLE clients (
  id        TEXT PRIMARY KEY,
  full_name TEXT NOT NULL
);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id),
  type          TEXT NOT NULL CHECK (type IN ('checking', 'savings')),
  iban          TEXT NOT NULL UNIQUE,
  -- Integer cents: no float rounding on money.
  balance_cents INTEGER NOT NULL
);

CREATE TABLE cards (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  last4      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active', 'blocked'))
);

CREATE TABLE transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX transactions_account_created ON transactions (account_id, created_at);
