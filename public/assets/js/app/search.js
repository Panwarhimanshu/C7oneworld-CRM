import { http } from '../http.js';
import { h, icon, mount, debounce } from './dom.js';
import { menuFor } from './sidebar.js';

const LEAD_PREVIEW = 5;

// Global search in the top bar: menu pages plus live lead matches.
export function buildGlobalSearch(ctx) {
  const { me, can } = ctx;
  const canLeads = can('leads.view_all') || can('leads.view_assigned');
  const canSearchUnassigned = !can('leads.view_all') && can('leads.search_unassigned');

  // Flatten the menu into searchable page entries ("Leads › Unassigned").
  const pages = [];
  for (const item of menuFor(can)) {
    if (item.type === 'link') pages.push({ label: item.label, href: item.href, iconName: item.icon });
    else for (const c of item.children) pages.push({ label: c.label, trail: item.label, href: c.href, iconName: item.icon });
  }
  pages.push({ label: 'My account', href: '/app/account', iconName: 'users' });

  const input = h('input', {
    class: 'gs-input', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Search',
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'gs-results', 'aria-autocomplete': 'list',
    'aria-label': 'Search',
  });
  const clearBtn = h('button', { class: 'gs-clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, '×');
  const panel = h('div', { class: 'gs-panel', id: 'gs-results', role: 'listbox', hidden: true });
  const box = h('div', { class: 'gs-box' }, icon('search', 16), input, clearBtn, h('kbd', { class: 'gs-kbd', 'aria-hidden': 'true' }, '/'));
  const mobileBtn = h('button', { class: 'icon-btn gs-mobile-btn', type: 'button', 'aria-label': 'Search' }, icon('search', 19));
  const el = h('div', { class: 'gs' }, mobileBtn, box, panel);

  let leadResults = [];
  let leadTotal = 0;
  let loading = false;
  let cursor = 0;
  let seq = 0;

  const text = () => input.value.trim();

  function entries() {
    const q = text().toLowerCase();
    if (!q) return [];
    const list = pages
      .filter((p) => p.label.toLowerCase().includes(q) || (p.trail || '').toLowerCase().includes(q))
      .slice(0, 5)
      .map((p) => ({ kind: 'page', ...p }));
    for (const l of leadResults) list.push({ kind: 'lead', href: `/app/leads/${l.id}`, lead: l });
    if (canLeads) list.push({ kind: 'all', href: `/app/leads?q=${encodeURIComponent(text())}` });
    return list;
  }

  function render() {
    const list = entries();
    const open = list.length > 0 && document.activeElement === input;
    panel.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) return;
    cursor = Math.min(cursor, list.length - 1);

    const row = (e, i, content) => h('a', {
      href: e.href, role: 'option', id: `gs-opt-${i}`, class: ['gs-item', i === cursor && 'is-active'],
      'aria-selected': String(i === cursor), dataset: { link: '' },
      onMousemove: () => { if (cursor !== i) { cursor = i; render(); } },
      onMousedown: (ev) => ev.preventDefault(), // keep focus so the click lands
      onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); close(); ctx.navigate(e.href); },
      onAuxclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); close(); ctx.navigate(e.href); },
    }, content);

    const out = [];
    const pageRows = list.map((e, i) => [e, i]).filter(([e]) => e.kind === 'page');
    if (pageRows.length) {
      out.push(h('div', { class: 'gs-section' }, 'Pages'));
      for (const [e, i] of pageRows) {
        out.push(row(e, i, [h('span', { class: 'gs-ico' }, icon(e.iconName, 15)),
          h('span', { class: 'gs-main' }, e.trail ? h('span', { class: 'gs-trail' }, `${e.trail} › `) : null, e.label)]));
      }
    }
    if (canLeads) {
      out.push(h('div', { class: 'gs-section' }, 'Leads', loading ? h('span', { class: 'gs-loading' }, 'Searching…') : null));
      const leadRows = list.map((e, i) => [e, i]).filter(([e]) => e.kind === 'lead');
      if (!leadRows.length && !loading) out.push(h('div', { class: 'gs-none' }, 'No leads match.'));
      if (canSearchUnassigned && text().length < 3) out.push(h('div', { class: 'gs-none' }, 'Type at least 3 characters to include leads awaiting a counselor.'));
      for (const [e, i] of leadRows) {
        const l = e.lead;
        out.push(row(e, i, [h('span', { class: 'gs-avatar' }, initials(l.fullName)),
          h('span', { class: 'gs-main' }, h('span', { class: 'gs-name' }, l.fullName), h('span', { class: 'gs-meta' }, `${l.code} · ${l.mobile}`)),
          l.access === 'readonly' ? h('span', { class: 'tag tag-warning gs-tag' }, 'Awaiting counselor · view only') : null]));
      }
      const allIdx = list.findIndex((e) => e.kind === 'all');
      out.push(row(list[allIdx], allIdx, [h('span', { class: 'gs-ico' }, icon('search', 15)),
        h('span', { class: 'gs-main' }, h('span', null, leadTotal > LEAD_PREVIEW ? `See all ${leadTotal} results for ` : 'Open results for ', h('strong', `“${text()}”`)))]));
    }
    mount(panel, out);
    input.setAttribute('aria-activedescendant', `gs-opt-${cursor}`);
  }

  const fetchLeads = debounce(async () => {
    const q = text();
    const mySeq = ++seq;
    if (!q || !canLeads) { leadResults = []; loading = false; render(); return; }
    try {
      const data = await http.get(`/api/leads?${new URLSearchParams({ q, page: 1 })}`);
      if (mySeq !== seq) return;
      leadResults = data.items.slice(0, LEAD_PREVIEW);
      leadTotal = data.total;
    } catch {
      if (mySeq === seq) leadResults = [];
    }
    if (mySeq === seq) { loading = false; render(); }
  }, 220);

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    box.classList.toggle('has-value', Boolean(input.value));
    cursor = 0;
    loading = canLeads && Boolean(text());
    leadResults = [];
    render();
    fetchLeads();
  });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(() => { panel.hidden = true; input.setAttribute('aria-expanded', 'false'); el.classList.remove('is-open-mobile'); }, 120));
  input.addEventListener('keydown', (e) => {
    const list = entries();
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, list.length - 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); render(); }
    if (e.key === 'Enter' && list[cursor]) { e.preventDefault(); const href = list[cursor].href; close(); ctx.navigate(href); }
    if (e.key === 'Escape') { close(); input.blur(); }
  });
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => { input.value = ''; input.dispatchEvent(new Event('input')); input.focus(); });

  // Phones: the box opens over the top bar from an icon.
  mobileBtn.addEventListener('click', () => { el.classList.add('is-open-mobile'); input.focus(); });

  // "/" or Ctrl+K focuses the search from anywhere.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      el.classList.add('is-open-mobile');
      input.focus();
      input.select();
    }
  });

  function close() {
    input.value = '';
    clearBtn.hidden = true;
    box.classList.remove('has-value');
    leadResults = [];
    panel.hidden = true;
    el.classList.remove('is-open-mobile');
    input.blur();
  }

  return { el };
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
