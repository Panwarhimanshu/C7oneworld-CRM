import { http } from '../../http.js';
import { h, icon, mount, fmt, localDayRange, todayIso, debounce } from '../dom.js';
import { statusPill, openModal, alertBox, STATUS_LABELS } from '../ui.js';

const TABS = ['all', 'waiting', 'with_counselor', 'completed', 'left'];
const TAB_LABELS = { all: 'All', ...STATUS_LABELS, left: 'Left' };

// Remember filters for the session so returning from a profile keeps the same view.
const saved = { date: null, status: 'all', q: '' };

export function renderWalkins(container, ctx) {
  const state = {
    date: saved.date && saved.date <= todayIso() ? saved.date : todayIso(),
    status: history.state?.status || saved.status,
    q: saved.q,
    data: null,
    flash: new Set(),
    loading: false,
  };

  // ---- header
  const qrBtn = h('button', { class: 'btn', type: 'button', onClick: () => showQr(ctx) }, icon('qr'), h('span', { class: 'hide-sm' }, 'Registration QR'));
  const live = liveBadge(ctx);
  ctx.setHeader('Walk-ins', { actions: [live.el, qrBtn] });

  // ---- toolbar
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter by status' });
  const dateInput = h('input', {
    class: 'input', type: 'date', value: state.date, max: todayIso(), 'aria-label': 'Date',
    onChange: () => {
      if (!dateInput.value) return;
      state.date = dateInput.value;
      load();
    },
  });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search walk-ins', value: state.q, 'aria-label': 'Search walk-ins',
    onInput: debounce(() => { state.q = search.value.trim(); load(); }, 250),
  });

  const tableHost = h('div', { class: 'card' });
  mount(container,
    h('div', { class: 'toolbar' },
      tabs,
      h('div', { class: 'spacer' }),
      h('div', { class: 'search' }, icon('search', 15), search),
      dateInput,
    ),
    tableHost,
  );

  function renderTabs() {
    const counts = state.data?.counts || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    mount(tabs, TABS.map((t) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.status === t),
      class: state.status === t ? 'is-active' : null,
      onClick: () => { state.status = t; load(); },
    }, TAB_LABELS[t], h('span', { class: 'count' }, String(t === 'all' ? total : counts[t] ?? 0)))));
  }

  function waitCell(v) {
    if (v.status === 'waiting') {
      const ms = Date.now() - v.checkedInAt;
      const cls = ms > 30 * 60_000 ? 'wait-long' : ms > 15 * 60_000 ? 'wait-mid' : null;
      return h('span', { class: cls }, fmt.duration(ms));
    }
    if (v.attendedAt) return h('span', { class: 'muted' }, fmt.duration(v.attendedAt - v.checkedInAt));
    return h('span', { class: 'muted' }, '—');
  }

  function renderTable() {
    const items = state.data?.items || [];
    if (!items.length) {
      const isToday = state.date === todayIso();
      mount(tableHost, h('div', { class: 'empty' },
        h('strong', state.q ? 'No walk-ins match your search.' : isToday ? 'No walk-ins yet today.' : 'No walk-ins on this date.'),
        isToday && !state.q ? 'New registrations from the Walk-in Form will appear here automatically.' : null,
      ));
      return;
    }

    const rows = items.map((v) => {
      const open = () => ctx.navigate(`/app/leads/${v.lead.id}`, { state: { from: 'walkins' } });
      return h('tr', {
        class: ['is-link', state.flash.has(v.id) && 'is-new'],
        onClick: (e) => { if (!e.target.closest('a')) open(); },
      },
        h('td', { class: 'nowrap' }, fmt.time(v.checkedInAt), h('span', { class: 'sub' }, fmt.ago(v.checkedInAt))),
        h('td', null,
          h('a', { class: 'primary', href: `/app/leads/${v.lead.id}`, dataset: { link: '', from: 'walkins' } }, v.lead.fullName),
          ' ',
          v.isReturning ? h('span', { class: 'tag tag-brand' }, 'Returning') : null,
          h('span', { class: 'sub mono' }, v.lead.code),
        ),
        h('td', { class: 'nowrap' }, v.lead.mobile, h('span', { class: 'sub' }, v.lead.email)),
        h('td', null, statusPill(v.status)),
        h('td', { class: 'hide-sm' }, v.counselor ? v.counselor.fullName : h('span', { class: 'muted' }, 'Unassigned')),
        h('td', { class: 'nowrap hide-sm' }, waitCell(v)),
      );
    });

    mount(tableHost, h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('thead', h('tr',
          h('th', 'Walk-in time'), h('th', 'Lead'), h('th', 'Contact'), h('th', 'Status'),
          h('th', { class: 'hide-sm' }, 'Counselor'), h('th', { class: 'hide-sm' }, 'Wait'),
        )),
        h('tbody', rows),
      ),
    ));
  }

  let seq = 0;
  async function load() {
    Object.assign(saved, { date: state.date, status: state.status, q: state.q });
    const mySeq = ++seq;
    const { from, to } = localDayRange(state.date);
    const params = new URLSearchParams({ from, to, status: state.status, q: state.q });
    try {
      const data = await http.get(`/api/walkins?${params}`);
      if (mySeq !== seq) return;
      state.data = data;
      renderTabs();
      renderTable();
      state.flash.clear();
    } catch (err) {
      if (mySeq !== seq) return;
      mount(tableHost, h('div', { class: 'card-body' }, alertBox('error', err.message)));
    }
  }

  const reloadSoon = debounce(load, 300);
  const off = ctx.feed.on((e) => {
    if (e.isNew && e.visitId) state.flash.add(e.visitId);
    if (state.date === todayIso()) reloadSoon();
  });
  // Keep the wait times current.
  const ticker = setInterval(() => { if (state.data) renderTable(); }, 30_000);

  renderTabs();
  load();

  return () => {
    off();
    live.off();
    clearInterval(ticker);
  };
}

function liveBadge(ctx) {
  const el = h('span', { class: 'live', title: 'New registrations appear without refreshing' });
  const off = ctx.feed.onStatus((s) => {
    el.className = `live ${s === 'on' ? 'is-on' : 'is-off'}`;
    el.textContent = s === 'on' ? 'Live' : 'Reconnecting…';
  });
  return { el, off };
}

export function showQr(ctx) {
  const url = ctx.me.app.registerUrl;
  openModal({
    title: 'Visitor registration QR code',
    description: 'Display this at the reception desk. Visitors scan it to register on their own phone.',
    body: [
      h('div', { class: 'qr-box' }, h('img', { src: '/api/walkins/qr.svg', alt: `QR code linking to ${url}`, width: 240, height: 240 })),
      h('p', { class: 'qr-url' }, url),
    ],
    actions: ({ close }) => [
      h('a', { class: 'btn', href: '/api/walkins/qr.svg', download: 'visitor-registration-qr.svg' }, 'Download'),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: close }, 'Done'),
    ],
  });
}
