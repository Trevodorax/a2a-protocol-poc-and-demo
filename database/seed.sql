INSERT INTO clients (id, full_name) VALUES
  ('c_001', 'Alice Martin'),
  ('c_002', 'Bruno Leroy');

INSERT INTO accounts (id, client_id, type, iban, balance_cents) VALUES
  ('a_001', 'c_001', 'checking', 'FR7630001007941234567890185', 184250),
  ('a_002', 'c_001', 'savings',  'FR7630001007949876543210142', 1250000),
  ('a_003', 'c_002', 'checking', 'FR7630001007945555666677781', 42010),
  ('a_004', 'c_002', 'savings',  'FR7630001007941111222233394', 300000);

INSERT INTO cards (id, account_id, last4, status) VALUES
  ('k_001', 'a_001', '4821', 'active'),
  ('k_002', 'a_001', '7710', 'active'),
  ('k_003', 'a_003', '1234', 'active');

INSERT INTO transactions (account_id, amount_cents, label, created_at) VALUES
  ('a_001', 250000,  'Salary',                 '2026-09-01T08:00:00Z'),
  ('a_001', -89000,  'Rent',                   '2026-09-03T09:12:00Z'),
  ('a_001', -6420,   'Supermarket',            '2026-09-10T17:45:00Z'),
  ('a_001', -1599,   'Streaming subscription', '2026-09-15T00:01:00Z'),
  ('a_001', -4500,   'Restaurant',             '2026-09-21T20:30:00Z'),
  ('a_001', -64231,  'Transfer to savings',    '2026-09-28T10:00:00Z'),
  ('a_002', 64231,   'Transfer from checking', '2026-09-28T10:00:00Z'),
  ('a_003', 180000,  'Salary',                 '2026-09-01T08:00:00Z'),
  ('a_003', -72000,  'Rent',                   '2026-09-05T09:00:00Z'),
  ('a_003', -3990,   'Phone bill',             '2026-09-12T06:00:00Z'),
  ('a_003', -12000,  'Online shop',            '2026-09-25T14:22:00Z');
