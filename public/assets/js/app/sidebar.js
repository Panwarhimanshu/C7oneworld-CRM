import { h, icon, mount } from './dom.js';

const OPEN_KEY = 'c7.navOpenGroups';

function readOpen() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); }
}
function saveOpen(set) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* storage unavailable */ }
}

// Menu model, filtered by what this login may use. Also used by the global search.
export function menuFor(can) {
  const items = [];
  if (can('leads.view_all') || can('leads.view_assigned')) {
    items.push({ type: 'link', key: 'dashboard', href: '/app/dashboard', icon: 'dashboard', label: 'Dashboard' });
  }
  if (can('walkins.view')) {
    items.push({ type: 'link', key: 'walkins', href: '/app/walk-ins', icon: 'walkin', label: 'Walk-ins', badge: true });
  }
  if (can('leads.view_all')) {
    items.push({
      type: 'group', key: 'leads', icon: 'leads', label: 'Leads',
      children: [
        { key: 'leads', sub: 'all', href: '/app/leads', label: 'All leads' },
        { key: 'leads', sub: 'me', href: '/app/leads?owner=me', label: 'Assigned to me' },
        { key: 'leads', sub: 'unassigned', href: '/app/leads?owner=unassigned', label: 'Awaiting counselor' },
      ],
    });
  } else if (can('leads.view_assigned')) {
    items.push({ type: 'link', key: 'leads', href: '/app/leads', icon: 'leads', label: 'My leads' });
  }
  const admin = [
    can('users.manage') && { key: 'users', href: '/app/users', label: 'Logins' },
    can('roles.manage') && { key: 'roles', href: '/app/roles', label: 'Roles & permissions' },
    can('audit.view') && { key: 'audit', href: '/app/audit', label: 'Audit log' },
  ].filter(Boolean);
  if (admin.length) items.push({ type: 'group', key: 'admin', icon: 'shield', label: 'Administration', children: admin });
  return items;
}

export function buildSidebar(me, { expandShell }) {
  const can = (p) => me.permissions.includes(p);
  const model = menuFor(can);
  const openGroups = readOpen();
  const waitingCount = h('span', { class: 'nav-count', hidden: true });
  let active = { key: null, sub: null };

  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });

  function linkEl(item, { child = false } = {}) {
    const isActive = active.key === item.key && (!child || active.sub === item.sub);
    return h('a', {
      href: item.href, title: item.label,
      class: [child ? 'nav-sub' : 'nav-item', isActive && 'is-active'],
      'aria-current': isActive ? 'page' : null,
      dataset: { link: '' },
    },
    child ? null : icon(item.icon, 17),
    h('span', { class: 'nav-label' }, item.label),
    item.badge ? waitingCount : null);
  }

  function groupEl(group) {
    const hasActive = group.children.some((c) => c.key === active.key);
    const open = openGroups.has(group.key);
    const toggle = h('button', {
      type: 'button', title: group.label,
      class: ['nav-item', 'nav-group-toggle', hasActive && 'has-active'],
      'aria-expanded': String(open),
      onClick: () => {
        // In the icon rail, a group click opens the menu with that group expanded.
        if (document.querySelector('.shell.sidebar-collapsed')) {
          expandShell();
          openGroups.add(group.key);
        } else if (openGroups.has(group.key)) {
          openGroups.delete(group.key);
        } else {
          openGroups.add(group.key);
        }
        saveOpen(openGroups);
        render();
      },
    }, icon(group.icon, 17), h('span', { class: 'nav-label' }, group.label), h('span', { class: 'nav-chevron' }, icon('chevron', 14)));
    return h('div', { class: ['nav-group', open && 'is-open'] },
      toggle,
      h('div', { class: 'nav-children', hidden: !open }, group.children.map((c) => linkEl(c, { child: true }))),
    );
  }

  function render() {
    mount(nav, model.map((item) => (item.type === 'link' ? linkEl(item) : groupEl(item))));
  }
  render();

  const el = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-brand' },
      h('img', { src: '/assets/img/logo-96.png', alt: '', width: 34, height: 34 }),
      h('div', h('strong', me.app.name), h('span', 'Lead Management')),
    ),
    nav,
    h('div', { class: 'sidebar-foot' }, me.app.org),
  );

  return {
    el,
    waitingCount,
    // Highlights the current page; opens its group so it is visible.
    sync(navKey) {
      const owner = new URLSearchParams(location.search).get('owner');
      const isLeadList = location.pathname.replace(/\/+$/, '') === '/app/leads';
      active = { key: navKey, sub: navKey === 'leads' && isLeadList ? (owner === 'me' || owner === 'unassigned' ? owner : 'all') : null };
      const group = model.find((m) => m.type === 'group' && m.children.some((c) => c.key === navKey));
      if (group && !openGroups.has(group.key)) { openGroups.add(group.key); saveOpen(openGroups); }
      render();
    },
  };
}
