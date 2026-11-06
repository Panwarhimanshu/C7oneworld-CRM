-- Lead pipeline stage, conversion date and "last updated by" for the lead profile.

ALTER TABLE leads ADD COLUMN stage TEXT NOT NULL DEFAULT 'new'
  CHECK (stage IN ('new','contacted','working','qualified','converted','unqualified','lost_interest','lost_to_competitor'));
ALTER TABLE leads ADD COLUMN stage_changed_at INTEGER;
ALTER TABLE leads ADD COLUMN converted_at INTEGER;
ALTER TABLE leads ADD COLUMN updated_by INTEGER REFERENCES users(id);
CREATE INDEX idx_leads_stage ON leads(stage);

-- Everyone who works on leads can move them through the pipeline by default.
INSERT INTO role_permissions (role_key, permission)
  SELECT key, 'leads.stage' FROM roles WHERE key IN ('reception', 'counselor', 'coaching_admin');
