-- Phase 1 schema: staff, sessions, OTP verification, leads, walk-in visits, audit trail.

CREATE TABLE users (
  id                    INTEGER PRIMARY KEY,
  full_name             TEXT    NOT NULL,
  email                 TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  role                  TEXT    NOT NULL CHECK (role IN ('super_admin','coaching_admin','counselor','reception')),
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

CREATE TABLE sessions (
  token_hash    TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT    NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- A registration attempt from the walk-in form. Nothing reaches the leads table
-- until the OTP is verified.
CREATE TABLE otp_requests (
  id              TEXT    PRIMARY KEY,
  full_name       TEXT    NOT NULL,
  email           TEXT    NOT NULL,
  mobile          TEXT    NOT NULL,
  channel         TEXT    NOT NULL CHECK (channel IN ('sms','email')),
  destination     TEXT    NOT NULL,
  code_hash       TEXT    NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  sends           INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','locked','expired')),
  ip              TEXT,
  last_sent_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  verified_at     INTEGER,
  lead_id         INTEGER REFERENCES leads(id),
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_otp_destination ON otp_requests(destination, created_at);
CREATE INDEX idx_otp_ip ON otp_requests(ip, created_at);
CREATE INDEX idx_otp_created ON otp_requests(created_at);

-- Every individual OTP dispatch, used for abuse caps.
CREATE TABLE otp_sends (
  id           INTEGER PRIMARY KEY,
  request_id   TEXT    NOT NULL REFERENCES otp_requests(id) ON DELETE CASCADE,
  destination  TEXT    NOT NULL,
  ip           TEXT,
  sent_at      INTEGER NOT NULL
);
CREATE INDEX idx_otp_sends_dest ON otp_sends(destination, sent_at);
CREATE INDEX idx_otp_sends_ip ON otp_sends(ip, sent_at);
CREATE INDEX idx_otp_sends_time ON otp_sends(sent_at);

CREATE TABLE leads (
  id                 INTEGER PRIMARY KEY,
  lead_code          TEXT    NOT NULL UNIQUE,
  full_name          TEXT    NOT NULL,
  email              TEXT    NOT NULL COLLATE NOCASE,
  mobile             TEXT    NOT NULL,
  mobile_verified_at INTEGER,
  email_verified_at  INTEGER,
  source             TEXT    NOT NULL DEFAULT 'walk_in',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_leads_mobile ON leads(mobile);
CREATE INDEX idx_leads_email ON leads(email);

-- One row per physical walk-in. A returning lead gets a new visit, not a new lead.
CREATE TABLE visits (
  id                     INTEGER PRIMARY KEY,
  lead_id                INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status                 TEXT    NOT NULL DEFAULT 'waiting'
                                 CHECK (status IN ('waiting','with_counselor','completed','left')),
  assigned_counselor_id  INTEGER REFERENCES users(id),
  submitted_name         TEXT    NOT NULL,
  submitted_email        TEXT    NOT NULL,
  submitted_mobile       TEXT    NOT NULL,
  verified_channel       TEXT    NOT NULL CHECK (verified_channel IN ('sms','email')),
  checked_in_at          INTEGER NOT NULL,
  attended_at            INTEGER,
  closed_at              INTEGER,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_visits_lead ON visits(lead_id);
CREATE INDEX idx_visits_checkin ON visits(checked_in_at);
CREATE INDEX idx_visits_status ON visits(status);

CREATE TABLE lead_notes (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_notes_lead ON lead_notes(lead_id, created_at);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  actor_id     INTEGER REFERENCES users(id),
  action       TEXT    NOT NULL,
  entity_type  TEXT,
  entity_id    INTEGER,
  details      TEXT,
  ip           TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at);
