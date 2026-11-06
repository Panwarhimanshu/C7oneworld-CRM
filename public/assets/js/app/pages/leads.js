import { http } from '../../http.js';
import { h, icon, mount, fmt, debounce } from '../dom.js';
import { statusPill, alertBox, ownerChip } from '../ui.js';
import { stageChip } from './lead.js';
import { openBulkUpload } from '../bulkUpload.js';

const STATUS_FILTERS = [
  ['all', 'Any visit status'],
  ['waiting', 'Waiting'],
  ['with_counselor', 'With counselor'],
  ['completed', 'Completed'],
  ['left', 'Left without meeting'],
];

const STAGE_FILTERS = [
  ['all', 'Any stage'],
  ['open', 'Open (not closed)'],
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['working', 'Working'],
  ['qualified', 'Qualified'],
  ['converted', 'Converted'],
  ['lost', 'Lost'],
];

const saved = { q: '', owner: 'all', status: 'all', stage: 'all', page: 1 };

export function renderLeads(container, ctx) {
  const seeAll = ctx.can('leads.view_all');
  const urlParams = new URLSearchParams(location.search);
  const state = { ...saved, assignees: [], q: urlParams.get('q') ?? '', owner: seeAll ? (urlParams.get('owner') || 'all') : 'all', page: 1 };

  ctx.setHeader(seeAll ? 'Leads' : 'My leads', {
    actions: ctx.can('leads.import')
      ? [h('button', { class: 'btn', type: 'button', onClick: () => openBulkUpload(ctx, { onDone: () => load() }) }, icon('upload', 15), 'Bulk upload')]
      : null,
  });

  const search = h('input', {
    class: 'input', type: 'search', value: state.q, placeholder: 'Search leads', 'aria-label': 'Search leads',
    onInput: debounce(() => { state.q = search.value.trim(); state.page = 1; load(); }, 250),
  });
  const ownerSelect = h('select', { class: 'select', 'aria-label': 'Owner', onChange: () => { state.owner = ownerSelect.value; state.page = 1; load(); } });
  const statusSelect = h('select', { class: 'select', 'aria-label': 'Visit status', onChange: () => { state.status = statusSelect.value; state.page = 1; load(); } },
    STATUS_FILTERS.map(([v, l]) => h('option', { value: v, selected: state.status === v }, l)));
  const stageSelect = h('select', { class: 'select', 'aria-label': 'Stage', onChange: () => { state.stage = stageSelect.value; state.page = 1; load(); } },
    STAGE_FILTERS.map(([v, l]) => h('option', { value: v, selected: state.stage === v }, l)));
  const summary = h('span', { class: 'muted' });
  const host = h('div', { class: 'card' });

  mount(container,
    h('div', { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search', 15), search),
      seeAll ? ownerSelect : null,
      stageSelect,
      statusSelect,
      h('div', { class: 'spacer' }),
      summary,
    ),
    host,
  );

  function renderOwnerOptions() {
    mount(ownerSelect,
      h('option', { value: 'all' }, 'All owners'),
      h('option', { value: 'unassigned' }, 'Awaiting counselor'),
      state.assignees.length ? h('optgroup', { label: 'Assigned to' },
        state.assignees.map((a) => h('option', { value: String(a.id) }, `${a.fullName} · ${a.roleName}`))) : null,
    );
    ownerSelect.value = state.owner;
    if (ownerSelect.value !== state.owner) { state.owner = 'all'; ownerSelect.value = 'all'; }
  }

  function render({ items, total, page, pageSize }) {
    summary.textContent = `${total} lead${total === 1 ? '' : 's'}`;
    if (!items.length) {
      const filtered = state.q || state.owner !== 'all' || state.status !== 'all' || state.stage !== 'all';
      mount(host, h('div', { class: 'empty' },
        h('strong', filtered ? 'No leads match these filters.' : seeAll ? 'No leads yet.' : 'No leads are assigned to you yet.'),
        !filtered && !seeAll ? 'Leads appear here once the front desk assigns them to you.' : null,
      ));
      return;
    }

    const pages = Math.max(1, Math.ceil(total / pageSize));
    mount(host,
      h('div', { class: 'table-wrap' },
        h('table', { class: 'data' },
          h('thead', h('tr',
            h('th', 'Lead'), h('th', 'Contact'), h('th', 'Stage'), h('th', 'Owner'), h('th', 'Last visit'),
            h('th', { class: 'num hide-sm' }, 'Visits'), h('th', { class: 'hide-sm' }, 'Created'),
          )),
          h('tbody', items.map((l) => h('tr', {
            class: 'is-link',
            onClick: (e) => { if (!e.target.closest('a')) ctx.navigate(`/app/leads/${l.id}`); },
          },
            h('td', null, h('div', { class: 'lead-cell' },
              h('span', { class: 'avatar-sm', 'aria-hidden': 'true' }, fmt.initials(l.fullName)),
              h('div', null,
                h('a', { class: 'primary', href: `/app/leads/${l.id}`, dataset: { link: '' } }, l.fullName),
                l.access === 'readonly' ? h('span', { class: 'tag tag-warning tag-self' }, 'View only') : null,
                h('span', { class: 'sub mono' }, l.code),
              ),
            )),
            h('td', { class: 'nowrap' }, l.mobile, h('span', { class: 'sub' }, l.email)),
            h('td', null, stageChip(l.stage)),
            h('td', null, ownerChip(l.owner)),
            h('td', null, l.lastVisit
              ? [statusPill(l.lastVisit.status), h('span', { class: 'sub' }, fmt.dateTime(l.lastVisit.checkedInAt))]
              : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'num hide-sm' }, String(l.visitCount)),
            h('td', { class: 'nowrap hide-sm muted' }, fmt.date(l.createdAt)),
          ))),
        ),
      ),
      pages > 1 ? h('div', { class: 'pager' },
        h('span', `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`),
        h('div', { class: 'btns' },
          h('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, onClick: () => { state.page -= 1; load(); } }, 'Previous'),
          h('button', { class: 'btn btn-sm', type: 'button', disabled: page >= pages, onClick: () => { state.page += 1; load(); } }, 'Next'),
        ),
      ) : null,
    );
  }

  let seq = 0;
  async function load() {
    Object.assign(saved, { status: state.status, stage: state.stage });
    const url = new URLSearchParams();
    if (state.owner !== 'all') url.set('owner', state.owner);
    if (state.q) url.set('q', state.q);
    const next = `/app/leads${url.toString() ? `?${url}` : ''}`;
    if (location.pathname + location.search !== next) {
      history.replaceState(history.state, '', next);
      ctx.syncNav?.();
    }
    const mySeq = ++seq;
    const params = new URLSearchParams({ q: state.q, owner: state.owner, status: state.status, stage: state.stage, page: state.page });
    try {
      const data = await http.get(`/api/leads?${params}`);
      if (mySeq === seq) render(data);
    } catch (err) {
      if (mySeq === seq) mount(host, h('div', { class: 'card-body' }, alertBox('error', err.message)));
    }
  }

  if (seeAll) {
    renderOwnerOptions();
    if (ctx.can('leads.assign') || ctx.can('walkins.manage')) {
      http.get('/api/assignees').then((r) => { state.assignees = r.items; renderOwnerOptions(); }).catch(() => {});
    }
  }
  load();

  const off = ctx.feed.on(debounce(load, 400));
  return off;
}
