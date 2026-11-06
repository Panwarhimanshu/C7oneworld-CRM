'use strict';

// Catalogue of everything a role or login can be granted. Roles and their mappings
// live in the database (Roles & permissions screen); this list defines what exists.
//   menu        - the sidebar menu this permission switches on
//   requires    - all of these must also be granted
//   requiresAny - at least one of these must also be granted
//   restricted  - Super Admin only; can never be granted to another role or login
const PERMISSIONS = [
  { key: 'walkins.view', group: 'Front desk', menu: 'Walk-ins', label: 'Walk-ins', description: 'See the live walk-in queue and every new registration.', requires: ['leads.view_all'] },
  { key: 'walkins.manage', group: 'Front desk', label: 'Manage walk-in visits', description: 'Assign a counselor, start, complete or close a visit.', requires: ['walkins.view'] },

  { key: 'leads.view_all', group: 'Leads', menu: 'Leads', label: 'View all leads', description: 'Leads menu shows every lead in the system.' },
  { key: 'leads.view_assigned', group: 'Leads', menu: 'Leads', label: 'View assigned leads', description: 'Leads menu shows only leads assigned to this login.' },
  { key: 'leads.create', group: 'Leads', label: 'Create leads', description: 'Add a lead by hand from Quick Create, e.g. a phone call or referral.', requiresAny: ['leads.view_all', 'leads.view_assigned'] },
  { key: 'leads.import', group: 'Leads', label: 'Bulk upload leads', description: 'Upload many leads at once from a CSV file.', restricted: true },
  { key: 'leads.search_unassigned', group: 'Leads', label: 'Find unassigned leads in search', description: 'Search (3+ characters) also finds unassigned leads. They are view-only: notes can be added, but fields change only once the lead is assigned to this login.', requires: ['leads.view_assigned'] },
  { key: 'leads.receive', group: 'Leads', label: 'Can be assigned leads', description: 'Appears in the list when assigning leads and walk-in visits.' },
  { key: 'leads.assign', group: 'Leads', label: 'Assign and reassign leads', description: 'Choose which login owns a lead.', requires: ['leads.view_all'] },
  { key: 'leads.edit', group: 'Leads', label: 'Edit lead details', description: 'Correct a lead’s name and email.', requiresAny: ['leads.view_all', 'leads.view_assigned'] },
  { key: 'leads.note', group: 'Leads', label: 'Add notes', description: 'Add notes to leads they can see.', requiresAny: ['leads.view_all', 'leads.view_assigned'] },
  { key: 'leads.stage', group: 'Leads', label: 'Update lead stage', description: 'Move a lead through the pipeline, mark it converted or close it as lost.', requiresAny: ['leads.view_all', 'leads.view_assigned'] },

  { key: 'payments.record', group: 'Fees & payments', label: 'Record fees and payments', description: 'Set the agreed amount and record payments on leads they can edit. Payments can never be changed or deleted.', requiresAny: ['leads.view_all', 'leads.view_assigned'] },
  { key: 'reports.revenue', group: 'Fees & payments', label: 'Office revenue dashboard', description: 'See revenue, agreed and outstanding amounts for every counselor and lead source.', restricted: true },

  { key: 'users.manage', group: 'Administration', menu: 'Logins', label: 'Logins', description: 'Create logins, reset passwords, activate or deactivate.', restricted: true },
  { key: 'roles.manage', group: 'Administration', menu: 'Roles & permissions', label: 'Roles & permissions', description: 'Create roles and map menus and permissions.', restricted: true },
  { key: 'audit.view', group: 'Administration', menu: 'Audit log', label: 'Audit log', description: 'Review every sign-in, record view and change.', restricted: true },
];

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));
const ALL_KEYS = PERMISSIONS.map((p) => p.key);

// A locked role (Super Admin) holds every permission except being a lead assignee.
const LOCKED_ROLE_PERMISSIONS = ALL_KEYS.filter((k) => k !== 'leads.receive');

function isKnown(key) {
  return BY_KEY.has(key);
}

// Returns a human-readable problem with the permission set, or null when consistent.
function dependencyProblem(set) {
  for (const key of set) {
    const p = BY_KEY.get(key);
    for (const r of p.requires || []) {
      if (!set.has(r)) return `“${p.label}” also needs “${BY_KEY.get(r).label}”.`;
    }
    if (p.requiresAny && !p.requiresAny.some((r) => set.has(r))) {
      return `“${p.label}” needs one of: ${p.requiresAny.map((r) => `“${BY_KEY.get(r).label}”`).join(' or ')}.`;
    }
  }
  return null;
}

module.exports = { PERMISSIONS, BY_KEY, ALL_KEYS, LOCKED_ROLE_PERMISSIONS, isKnown, dependencyProblem };
