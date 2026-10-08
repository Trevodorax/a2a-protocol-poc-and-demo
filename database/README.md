# Database

Minimal SQLite bank schema shared by `informations-agent` (read-only) and `actions-agent` (read-write). All data is fictional.

| Table | Content |
|---|---|
| `clients` | `id`, `full_name` |
| `accounts` | `checking` or `savings`, `iban`, `balance_cents` (EUR, integer cents) |
| `cards` | `last4`, `status` (`active` or `blocked`), linked to an account |
| `transactions` | `amount_cents` (negative = debit), `label`, `created_at` (ISO 8601 UTC) |

Seed: clients `c_001` (2 accounts, 2 cards) and `c_002` (2 accounts, 1 card).

```bash
python3 init_db.py   # (re)creates bank.db, no dependencies
```
