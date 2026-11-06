-- Manually created leads (Quick Create) and per-login notifications.

ALTER TABLE leads ADD COLUMN created_by INTEGER REFERENCES users(id);

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body        TEXT,
  link        TEXT,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at);

-- The front desk can add leads by hand (phone calls, referrals) by default.
INSERT INTO role_permissions (role_key, permission)
  SELECT key, 'leads.create' FROM roles WHERE key = 'reception';
