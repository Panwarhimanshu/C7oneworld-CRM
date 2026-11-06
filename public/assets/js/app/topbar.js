import { http } from '../http.js';
import { h, icon, mount, fmt } from './dom.js';
import { dropdown, menuItem, toast, openModal, field, showFieldErrors, withBusy, SOURCE_LABELS, NEW_LEAD_SOURCES } from './ui.js';
import { openBulkUpload } from './bulkUpload.js';

// Global actions on the right of the top bar: Quick Create, waiting visitors,
// notifications and the user menu.
export function buildTopbarActions(ctx, { showQr }) {
  const { me, can } = ctx;
  const items = [];

  // ---------------------------------------------------------------- Quick Create
  const createEntries = [
    can('leads.create') && menuItem('New lead', { iconNode: icon('leads', 16), hint: 'Phone call, referral or other enquiry', onClick: () => { qc.close(); openNewLead(ctx); } }),
    can('users.manage') && menuItem('New login', { iconNode: icon('users', 16), hint: 'Create a staff login', onClick: () => { qc.close(); ctx.navigate('/app/users', { state: { open: 'new' } }); } }),
    can('leads.import') && menuItem('Bulk upload leads', { iconNode: icon('upload', 16), hint: 'Import many leads from a CSV file', onClick: () => { qc.close(); openBulkUpload(ctx); } }),
    can('roles.manage') && menuItem('New role', { iconNode: icon('shield', 16), hint: 'Department or team role', onClick: () => { qc.close(); ctx.navigate('/app/roles', { state: { open: 'new' } }); } }),
    can('walkins.view') && menuItem('Registration QR', { iconNode: icon('qr', 16), hint: 'Show the walk-in QR code', onClick: () => { qc.close(); showQr(ctx); } }),
  ].filter(Boolean);
  const qc = dropdown(
    h('button', { class: 'btn btn-quick', type: 'button' }, icon('plus', 16), h('span', { class: 'hide-sm' }, 'Quick Create')),
    { panelClass: 'menu', render: () => h('div', { role: 'menu' }, createEntries) },
  );
  if (createEntries.length) items.push(qc.el);

  // ---------------------------------------------------------------- Visitors waiting
  const waitingBadge = h('span', { class: 'icon-badge is-gold', hidden: true });
  if (can('walkins.view')) {
    items.push(h('button', {
      class: 'icon-btn', type: 'button', title: 'Visitors waiting at the front desk', 'aria-label': 'Visitors waiting',
      onClick: () => ctx.navigate('/app/walk-ins', { state: { status: 'waiting' } }),
    }, icon('clock', 19), waitingBadge));
  }

  // ---------------------------------------------------------------- Notifications
  const state = { items: [], unread: 0 };
  const bellBadge = h('span', { class: 'icon-badge is-red', hidden: true });
  const bell = dropdown(
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Notifications' }, icon('bell', 19), bellBadge),
    { panelClass: 'notif-panel', render: renderNotifications },
  );
  items.push(bell.el);

  function setUnread(n) {
    state.unread = n;
    bellBadge.textContent = n > 99 ? '99+' : String(n);
    bellBadge.hidden = n === 0;
    bell.el.querySelector('.icon-btn').setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  }

  async function loadNotifications() {
    try {
      const data = await http.get('/api/notifications');
      state.items = data.items;
      setUnread(data.unread);
      bell.rerender();
    } catch { /* best-effort */ }
  }

  async function openNotification(n, close) {
    if (!n.read) {
      n.read = true;
      setUnread(Math.max(0, state.unread - 1));
      http.post(`/api/notifications/${n.id}/read`).catch(() => {});
    }
    if (n.link) { close(); ctx.navigate(n.link); } else { bell.rerender(); }
  }

  function renderNotifications({ close }) {
    const markAll = h('button', { class: 'btn-link', type: 'button', disabled: state.unread === 0, onClick: async () => {
      await http.post('/api/notifications/read-all').catch(() => {});
      state.items.forEach((n) => { n.read = true; });
      setUnread(0);
      bell.rerender();
    } }, 'Mark all as read');
    return [
      h('div', { class: 'notif-head' }, h('strong', 'Notifications'), markAll),
      state.items.length
        ? h('ul', { class: 'notif-list' }, state.items.map((n) => h('li', null,
          h('button', { type: 'button', class: ['notif-item', !n.read && 'is-unread', !n.link && 'no-link'], onClick: () => openNotification(n, close) },
            h('span', { class: ['notif-icon', `t-${n.type.split('.')[0]}`], 'aria-hidden': 'true' }, icon(n.type === 'walkin.new' ? 'walkin' : 'leads', 15)),
            h('span', { class: 'notif-text' },
              h('span', { class: 'notif-title' }, n.title),
              n.body ? h('span', { class: 'notif-body' }, n.body) : null,
              h('span', { class: 'notif-time' }, fmt.ago(n.createdAt)),
            ),
            !n.read ? h('span', { class: 'notif-dot', 'aria-label': 'Unread' }) : null,
          ))))
        : h('div', { class: 'notif-empty' }, icon('bell', 22), h('strong', 'You’re all caught up'), 'New walk-ins and lead assignments will appear here.'),
    ];
  }

  ctx.feed.onNotification((n) => {
    state.items.unshift({ ...n, read: false });
    state.items = state.items.slice(0, 30);
    setUnread(state.unread + 1);
    bell.rerender();
    toast(h('span', null, h('strong', `${n.title}: `), n.body || '', ' ', n.link ? h('a', { href: n.link, dataset: { link: '' } }, 'Open') : null));
  });
  loadNotifications();

  // ---------------------------------------------------------------- User menu
  const signOut = async () => {
    try { await http.post('/api/auth/logout'); } catch { /* session may already be gone */ }
    location.replace('/login?reason=signed-out');
  };
  const user = dropdown(
    h('button', { class: 'user-btn', type: 'button', 'aria-label': `Account menu for ${me.user.fullName}` },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, fmt.initials(me.user.fullName)),
      h('span', { class: 'user-btn-text hide-sm' }, h('strong', me.user.fullName), h('span', me.user.roleLabel)),
      icon('chevron-down', 15),
    ),
    {
      panelClass: 'menu',
      render: ({ close }) => h('div', { role: 'menu' },
        h('div', { class: 'menu-header' }, h('strong', me.user.fullName), h('span', me.user.email)),
        menuItem('My account', { iconNode: icon('users', 16), onClick: () => { close(); ctx.navigate('/app/account'); } }),
        h('div', { class: 'menu-sep' }),
        menuItem('Sign out', { iconNode: icon('logout', 16), onClick: signOut, danger: true }),
      ),
    },
  );
  items.push(h('span', { class: 'topbar-sep', 'aria-hidden': 'true' }), user.el);

  return {
    el: h('div', { class: 'topbar-global' }, items),
    setWaiting(n) {
      waitingBadge.textContent = String(n);
      waitingBadge.hidden = n === 0;
    },
  };
}

// ---------------------------------------------------------------- New lead (Quick Create)

const COUNTRY_CODES = [['91', '+91 IN'], ['1', '+1 US/CA'], ['44', '+44 UK'], ['61', '+61 AU'], ['64', '+64 NZ'], ['353', '+353 IE'], ['971', '+971 AE'], ['65', '+65 SG'], ['977', '+977 NP']];

async function openNewLead(ctx) {
  const name = h('input', { class: 'input', maxLength: 100, autocomplete: 'off' });
  const email = h('input', { class: 'input', type: 'email', maxLength: 254, autocomplete: 'off', placeholder: 'Optional' });
  const cc = h('select', { class: 'select', 'aria-label': 'Country code' }, COUNTRY_CODES.map(([v, l]) => h('option', { value: v }, l)));
  const mobile = h('input', { class: 'input', type: 'tel', inputmode: 'numeric', maxLength: 15, autocomplete: 'off' });
  const source = h('select', { class: 'select' },
    h('option', { value: '' }, 'Select source…'),
    NEW_LEAD_SOURCES.map((v) => h('option', { value: v }, SOURCE_LABELS[v])));
  const note = h('textarea', { class: 'textarea', maxLength: 2000, rows: 3, placeholder: 'What did they ask about? (optional)' });

  let assign = null;
  if (ctx.can('leads.assign')) {
    assign = h('select', { class: 'select' }, h('option', { value: '' }, 'Leave unassigned'));
    http.get('/api/assignees').then(({ items }) => {
      const roles = [...new Set(items.map((i) => i.roleName))];
      for (const r of roles) assign.append(h('optgroup', { label: r }, items.filter((i) => i.roleName === r).map((i) => h('option', { value: String(i.id) }, i.fullName))));
    }).catch(() => {});
  }

  const form = h('form', { novalidate: true, class: 'form-grid' },
    field({ label: 'Full name', name: 'fullName', input: name }),
    h('div', { class: 'field', dataset: { field: 'mobile' } },
      h('label', { class: 'label', htmlFor: 'f-mobile' }, 'Mobile number'),
      h('div', { class: 'phone-group-sm' }, cc, Object.assign(mobile, { id: 'f-mobile' })),
      h('p', { class: 'field-error', hidden: true }),
    ),
    field({ label: 'Email address', name: 'email', input: email }),
    field({ label: 'Lead source', name: 'source', input: source }),
    assign ? field({ label: 'Assign to', name: 'assigneeId', input: assign, hint: 'Only the person assigned (and the front desk) will see this lead.' })
      : ctx.can('leads.view_all') ? null : h('p', { class: 'hint form-span' }, 'This lead will be assigned to you'),
    h('div', { class: 'form-span' }, field({ label: 'Note', name: 'note', input: note })),
  );

  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Create lead');
  const { close } = openModal({
    title: 'New lead',
    description: 'For enquiries that did not come through the Walk-in Form.',
    body: form,
    actions: ({ close }) => [h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save],
  });
  form.closest('dialog').classList.add('modal-wide');
  name.focus();

  const submit = () => withBusy(save, 'Creating…', async () => {
    showFieldErrors(form, {});
    if (!source.value) { showFieldErrors(form, { source: 'Select where this lead came from.' }); return; }
    const body = { fullName: name.value, email: email.value.trim(), countryCode: cc.value, mobile: mobile.value, source: source.value, note: note.value };
    if (assign?.value) body.assigneeId = Number(assign.value);
    try {
      const res = await http.post('/api/leads', body);
      close();
      toast('Lead created.');
      ctx.navigate(`/app/leads/${res.id}`);
    } catch (err) {
      if (!showFieldErrors(form, err.fields)) toast(err.message, { kind: 'error' });
    }
  });
  save.addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}
