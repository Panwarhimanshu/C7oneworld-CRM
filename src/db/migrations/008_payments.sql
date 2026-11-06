-- Fees & payments: an agreed amount per lead and an immutable payment ledger.
-- Amounts are stored in paise (integer) to avoid rounding errors.

ALTER TABLE leads ADD COLUMN agreed_amount INTEGER CHECK (agreed_amount IS NULL OR agreed_amount >= 0);
ALTER TABLE leads ADD COLUMN agreed_set_at INTEGER;
ALTER TABLE leads ADD COLUMN agreed_set_by INTEGER REFERENCES users(id);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  paid_on      INTEGER NOT NULL,
  mode         TEXT    NOT NULL CHECK (mode IN ('cash','upi','card','bank_transfer','cheque','other')),
  reference    TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT '',
  recorded_by  INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_payments_lead ON payments(lead_id);
CREATE INDEX idx_payments_paid_on ON payments(paid_on);

-- Payments are financial records: never edited, never deleted.
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'Payments cannot be changed');
END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'Payments cannot be deleted');
END;

-- People who work leads can record fees and payments on leads they own.
INSERT OR IGNORE INTO role_permissions (role_key, permission)
  SELECT key, 'payments.record' FROM roles WHERE key IN ('reception', 'counselor', 'coaching_admin');
