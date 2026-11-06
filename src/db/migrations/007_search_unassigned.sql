-- Counselors and coaching admins can find unassigned leads through search
-- (view and add notes only; editing needs the lead to be assigned to them).
INSERT OR IGNORE INTO role_permissions (role_key, permission)
  SELECT key, 'leads.search_unassigned' FROM roles WHERE key IN ('counselor', 'coaching_admin');
