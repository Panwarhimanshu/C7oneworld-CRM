import { http, setCsrfToken, setAuthLostHandler, ApiError } from '../http.js';
import { h, icon, mount, localDayRange, todayIso } from './dom.js';
import { renderWalkins } from './pages/walkins.js';
import { renderLead } from './pages/lead.js';
import { renderLeads } from './pages/leads.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderRoles } from './pages/roles.js';
import { renderUsers } from './pages/users.js';
import { renderAudit } from './pages/audit.js';
import { renderAccount, passwordForm } from './pages/account.js';
import { buildTopbarActions } from './topbar.js';
import { buildSidebar } from './sidebar.js';
import { buildGlobalSearch } from './search.js';
import { showQr } from './pages/walkins.js';

const root = document.getElementById('root');

const LEADS = ['leads.view_all', 'leads.view_assigned'];

// perm: the user needs at least one of these permissions.
const ROUTES = [
  { path: /^\/app\/dashboard\/?$/, perm: LEADS, render: renderDashboard, nav: 'dashboard' },
  { path: /^\/app\/walk-ins\/?$/, perm: ['walkins.view'], render: renderWalkins, nav: 'walkins' },
  { path: /^\/app\/leads\/?$/, perm: LEADS, render: renderLeads, nav: 'leads' },
  { path: /^\/app\/leads\/(\d+)\/?$/, perm: LEADS, render: renderLead, nav: 'leads' },
  { path: /^\/app\/users\/?$/, perm: ['users.manage'], render: renderUsers, nav: 'users' },
  { path: /^\/app\/roles\/?$/, perm: ['roles.manage'], render: renderRoles, nav: 'roles' },
  { path: /^\/app\/audit\/?$/, perm: ['audit.view'], render: renderAudit, nav: 'audit' },
  { path: /^\/app\/account\/?$/, perm: null, render: renderAccount, nav: 'account' },
];

function redirectToLogin(reason = 'expired') {
  const next = encodeURIComponent(location.pathname);
  location.replace(`/login?reason=${reason}&next=${next}`);
}

setAuthLostHandler((err) => {
  if (err.status === 401) redirectToLogin();
  else location.reload();
});

// ---------------------------------------------------------------- live events (walk-ins + notifications)

function createLiveFeed() {
  const listeners = new Set();
  const notificationListeners = new Set();
  let source = null;
  let status = 'off';
  const statusListeners = new Set();

  const setStatus = (s) => {
    status = s;
    statusListeners.forEach((fn) => fn(s));
  };

  function connect() {
    source = new EventSource('/api/events');
    source.addEventListener('open', () => setStatus('on'));
    source.addEventListener('walkin', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      listeners.forEach((fn) => fn(data));
    });
    source.addEventListener('notification', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      notificationListeners.forEach((fn) => fn(data));
    });
    source.addEventListener('error', () => {
      setStatus('off');
      if (source.readyState === EventSource.CLOSED) {
        // Stream was refused (e.g. session ended). Confirm the session, then retry.
        http.get('/api/auth/me').then(() => setTimeout(connect, 5000)).catch(() => {});
      }
    });
  }

  return {
    start: connect,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onNotification(fn) { notificationListeners.add(fn); return () => notificationListeners.delete(fn); },
    onStatus(fn) { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); },
  };
}

// ---------------------------------------------------------------- shell

// Desktop sidebar can collapse to an icon rail; the choice is remembered per browser.
const COLLAPSE_KEY = 'c7.sidebarCollapsed';
const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
function saveCollapsed(value) {
  try { localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ }
}

function buildShell(me) {
  const shell = h('div', { class: 'shell' });
  const sidebarApi = buildSidebar(me, {
    expandShell: () => {
      if (isMobile()) shell.classList.add('nav-open');
      else if (shell.classList.contains('sidebar-collapsed')) { shell.classList.remove('sidebar-collapsed'); saveCollapsed(false); }
      syncMenuLabel();
    },
  });
  const sidebar = sidebarApi.el;
  const waitingCount = sidebarApi.waitingCount;

  const titleEl = h('div', { class: 'topbar-title' });
  const actionsEl = h('div', { class: 'topbar-actions' });
  const globalEl = h('div', { class: 'topbar-global-host' });
  const searchEl = h('div', { class: 'topbar-search-host' });
  const menuBtn = h('button', { class: 'btn btn-ghost btn-sm menu-btn', type: 'button' }, icon('menu', 18));
  const syncMenuLabel = () => {
    const open = isMobile() ? shell.classList.contains('nav-open') : !shell.classList.contains('sidebar-collapsed');
    menuBtn.setAttribute('aria-label', open ? 'Collapse menu' : 'Expand menu');
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.title = open ? 'Collapse menu' : 'Expand menu';
  };
  menuBtn.addEventListener('click', () => {
    if (isMobile()) {
      shell.classList.toggle('nav-open');
    } else {
      const collapsed = shell.classList.toggle('sidebar-collapsed');
      saveCollapsed(collapsed);
    }
    syncMenuLabel();
  });
  shell.classList.toggle('sidebar-collapsed', readCollapsed());
  syncMenuLabel();
  const content = h('div', { class: 'content', id: 'content' });

  mount(shell, sidebar, h('div', { class: 'main' },
    h('header', { class: 'topbar' }, menuBtn, titleEl, h('div', { class: 'spacer' }), searchEl, actionsEl, globalEl),
    h('main', content),
  ));

  return { shell, sidebar, sidebarApi, content, titleEl, actionsEl, globalEl, searchEl, waitingCount };
}

// ---------------------------------------------------------------- boot

async function boot() {
  let me;
  try {
    me = await http.get('/api/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return redirectToLogin();
    mount(root, h('div', { class: 'boot-msg' }, 'Unable to load the workspace. Please refresh the page.'));
    return;
  }
  setCsrfToken(me.csrfToken);
  document.title = me.app.name;

  if (me.user.mustChangePassword) return renderForcedChange(me);

  const ui = buildShell(me);
  root.className = '';
  mount(root, ui.shell);

  const can = (p) => me.permissions.includes(p);
  const feed = createLiveFeed();
  let cleanup = null;

  const ctx = {
    me,
    can,
    feed,
    navigate,
    setHeader(title, { crumbs, actions } = {}) {
      document.title = `${typeof title === 'string' ? title : 'Lead'} · ${me.app.name}`;
      mount(ui.titleEl, crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', title));
      mount(ui.actionsEl, actions || null);
    },
  };

  const topbar = buildTopbarActions(ctx, { showQr });
  mount(ui.globalEl, topbar.el);
  mount(ui.searchEl, buildGlobalSearch(ctx).el);

  // Waiting count in the sidebar and the top bar, kept live by the event feed.
  async function refreshBadge() {
    if (!can('walkins.view')) return;
    try {
      const { from, to } = localDayRange(todayIso());
      const data = await http.get(`/api/walkins?from=${from}&to=${to}&status=waiting`);
      const n = data.counts.waiting;
      ui.waitingCount.textContent = String(n);
      ui.waitingCount.hidden = n === 0;
      topbar.setWaiting(n);
    } catch { /* badge is best-effort */ }
  }

  feed.start();
  if (can('walkins.view')) {
    feed.on(refreshBadge);
    refreshBadge();
  }

  let currentNav = null;
  ctx.syncNav = () => ui.sidebarApi.sync(currentNav);

  function render() {
    cleanup?.();
    cleanup = null;
    ui.shell.classList.remove('nav-open');
    window.scrollTo({ top: 0 });

    let path = location.pathname;
    if (path === '/app' || path === '/app/') {
      path = can('leads.view_all') || can('leads.view_assigned') ? '/app/dashboard' : can('walkins.view') ? '/app/walk-ins' : '/app/account';
      history.replaceState(null, '', path);
    }

    const route = ROUTES.find((r) => r.path.test(path));
    currentNav = route?.nav ?? null;
    ui.sidebarApi.sync(currentNav);

    if (!route) {
      ctx.setHeader('Page not found');
      mount(ui.content, h('div', { class: 'card' }, h('div', { class: 'empty' }, h('strong', 'This page does not exist.'), h('a', { href: '/app', dataset: { link: '' } }, 'Go to the workspace home'))));
      return;
    }
    if (route.perm && !route.perm.some(can)) {
      ctx.setHeader('Access restricted');
      mount(ui.content, h('div', { class: 'card' }, h('div', { class: 'empty' }, h('strong', 'You do not have access to this page.'), 'Contact a Super Admin if you believe this is a mistake.')));
      return;
    }
    const params = path.match(route.path).slice(1);
    mount(ui.content);
    cleanup = route.render(ui.content, ctx, ...params) || null;
  }

  function navigate(path, { replace = false, state = null } = {}) {
    if (replace) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
    render();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href'), { state: a.dataset.from ? { from: a.dataset.from } : null });
  });
  window.addEventListener('popstate', render);

  render();
}

function renderForcedChange(me) {
  root.className = '';
  const form = passwordForm({
    submitLabel: 'Set password and continue',
    onDone: () => location.replace('/app'),
  });
  mount(root, h('div', { class: 'forced-change' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Set a new password')),
      h('div', { class: 'card-body' },
        h('p', { class: 'muted', style: null }, `Welcome, ${me.user.fullName.split(' ')[0]}. For security, replace your temporary password before using ${me.app.name}.`),
        h('div', { class: 'spacer-12' }),
        form,
      ),
    ),
  ));
}

boot();
