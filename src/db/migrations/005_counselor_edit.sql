-- Counselors and coaching admins can correct details on the leads assigned to them.
-- (Visibility rules still apply: they can only edit leads they can see.)
INSERT OR IGNORE INTO role_permissions (role_key, permission)
  SELECT key, 'leads.edit' FROM roles WHERE key IN ('counselor', 'coaching_admin');
