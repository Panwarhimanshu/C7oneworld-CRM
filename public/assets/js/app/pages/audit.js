import { http } from '../../http.js';
import { h, mount, fmt } from '../dom.js';
import { alertBox } from '../ui.js';

const CATEGORIES = [
  ['', 'All events'],
  ['auth.', 'Sign-in & security'],
  ['lead.', 'Leads'],
  ['visit.', 'Visits'],
  ['user.', 'Logins'],
  ['role.', 'Roles & permissions'],
  ['registration.', 'Visitor registration'],
];

const ACTION_LABELS = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in',
  'auth.login_blocked': 'Sign-in blocked (locked)',
  'auth.password_changed': 'Changed password',
  'lead.created': 'Lead registered',
  'lead.checked_in': 'Lead walked in again',
  'lead.viewed': 'Viewed lead',
  'lead.updated': 'Edited lead',
  'lead.note_added': 'Added note',
  'lead.assigned': 'Assigned lead',
  'lead.stage_changed': 'Changed lead stage',
  'leads.imported': 'Bulk uploaded leads',
  'lead.agreed_amount': 'Set agreed amount',
  'lead.payment_recorded': 'Recorded payment',
  'role.created': 'Created role',
  'role.updated': 'Renamed role',
  'role.deleted': 'Deleted role',
  'role.permissions_changed': 'Changed role permissions',
  'user.permissions_changed': 'Changed login access',
  'visit.updated': 'Updated visit',
  'user.created': 'Created user',
  'user.updated': 'Updated user',
  'user.password_reset': 'Reset password',
  'registration.otp_locked': 'OTP locked after failed attempts',
};

export function renderAudit(container, ctx) {
  ctx.setHeader('Audit log');
  const state = { page: 1, action: '' };

  const filter = h('select', { class: 'select', 'aria-label': 'Event type', onChange: () => { state.action = filter.value; state.page = 1; load(); } },
    CATEGORIES.map(([v, l]) => h('option', { value: v }, l)));
  const host = h('div', { class: 'card' });
  mount(container, h('div', { class: 'toolbar' }, h('div', { style: null }, filter), h('div', { class: 'spacer' }),
    h('span', { class: 'muted' }, 'Every sign-in, record view and change is recorded here.')), host);

  async function load() {
    try {
      const data = await http.get(`/api/audit?${new URLSearchParams({ page: state.page, action: state.action })}`);
      render(data);
    } catch (err) {
      mount(host, h('div', { class: 'card-body' }, alertBox('error', err.message)));
    }
  }

  function render({ items, page, pageSize, total }) {
    if (!items.length) {
      mount(host, h('div', { class: 'empty' }, h('strong', 'No events recorded.')));
      return;
    }
    const pages = Math.max(1, Math.ceil(total / pageSize));
    mount(host,
      h('div', { class: 'table-wrap' },
        h('table', { class: 'data' },
          h('thead', h('tr', h('th', 'When'), h('th', 'User'), h('th', 'Event'), h('th', 'Record'), h('th', { class: 'hide-sm' }, 'Details'), h('th', { class: 'hide-sm' }, 'IP address'))),
          h('tbody', items.map((a) => h('tr', null,
            h('td', { class: 'nowrap' }, fmt.dateTime(a.createdAt)),
            h('td', { class: 'nowrap' }, a.actorName || h('span', { class: 'muted' }, a.action.startsWith('lead.') || a.action.startsWith('registration.') ? 'Visitor' : 'System')),
            h('td', { class: 'nowrap' }, ACTION_LABELS[a.action] || a.action),
            h('td', null, a.entityType === 'lead' && a.entityId
              ? h('a', { href: `/app/leads/${a.entityId}`, dataset: { link: '' }, class: 'mono' }, a.entityLabel || `#${a.entityId}`)
              : a.entityLabel || a.details?.role || h('span', { class: 'muted' }, '—')),
            h('td', { class: 'hide-sm' }, a.details ? h('span', { class: 'details-json' }, summarise(a.details)) : null),
            h('td', { class: 'hide-sm mono' }, a.ip || '—'),
          ))),
        ),
      ),
      h('div', { class: 'pager' },
        h('span', `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, onClick: () => { state.page -= 1; load(); } }, 'Previous'),
          h('button', { class: 'btn btn-sm', type: 'button', disabled: page >= pages, onClick: () => { state.page += 1; load(); } }, 'Next'),
        ),
      ),
    );
  }

  load();
}

function summarise(details) {
  return Object.entries(details)
    .map(([k, v]) => {
      if (v && typeof v === 'object' && 'from' in v) return `${k}: ${v.from} → ${v.to}`;
      return `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`;
    })
    .join(' · ');
}
