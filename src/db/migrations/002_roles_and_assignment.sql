-- Configurable roles and permissions, per-user permission overrides, and lead ownership.

CREATE TABLE roles (
  key          TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  description  TEXT    NOT NULL DEFAULT '',
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  -- A locked role always has every permission and cannot be edited (Super Admin).
  is_locked    INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO roles (key, name, description, is_system, is_locked, created_at, updated_at) VALUES
  ('super_admin',    'Super Admin',    'Full access to every module, login and setting.',               1, 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('reception',      'Reception',      'Front desk. Handles walk-ins, sees all leads and assigns them.', 1, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('counselor',      'Counselor',      'Works only on the leads assigned to them.',                     1, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('coaching_admin', 'Coaching Admin', 'Works only on the leads assigned to them.',                     1, 0, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE role_permissions (
  role_key    TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role_key, permission)
);

INSERT INTO role_permissions (role_key, permission) VALUES
  ('reception', 'walkins.view'),
  ('reception', 'walkins.manage'),
  ('reception', 'leads.view_all'),
  ('reception', 'leads.assign'),
  ('reception', 'leads.edit'),
  ('reception', 'leads.note'),
  ('counselor', 'leads.view_assigned'),
  ('counselor', 'leads.receive'),
  ('counselor', 'leads.note'),
  ('coaching_admin', 'leads.view_assigned'),
  ('coaching_admin', 'leads.receive'),
  ('coaching_admin', 'leads.note');

-- Rebuild users so role references the roles table instead of a fixed CHECK list.
CREATE TABLE users_new (
  id                    INTEGER PRIMARY KEY,
  full_name             TEXT    NOT NULL,
  email                 TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  role                  TEXT    NOT NULL REFERENCES roles(key),
  password_hash         TEXT    NOT NULL,
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password  INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          INTEGER,
  last_login_at         INTEGER,
  password_changed_at   INTEGER,
  created_by            INTEGER REFERENCES users(id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
INSERT INTO users_new SELECT id, full_name, email, role, password_hash, is_active, must_change_password, failed_attempts,
  locked_until, last_login_at, password_changed_at, created_by, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_role ON users(role);

-- Per-login adjustments on top of the role: granted = 1 adds, granted = 0 removes.
CREATE TABLE user_permissions (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT    NOT NULL,
  granted     INTEGER NOT NULL CHECK (granted IN (0,1)),
  PRIMARY KEY (user_id, permission)
);

-- Lead ownership drives who can see a lead.
ALTER TABLE leads ADD COLUMN assigned_to INTEGER REFERENCES users(id);
ALTER TABLE leads ADD COLUMN assigned_at INTEGER;
CREATE INDEX idx_leads_assigned ON leads(assigned_to);

UPDATE leads SET
  assigned_to = (SELECT v.assigned_counselor_id FROM visits v
                 WHERE v.lead_id = leads.id AND v.assigned_counselor_id IS NOT NULL ORDER BY v.id DESC LIMIT 1),
  assigned_at = (SELECT v.attended_at FROM visits v
                 WHERE v.lead_id = leads.id AND v.assigned_counselor_id IS NOT NULL ORDER BY v.id DESC LIMIT 1);
