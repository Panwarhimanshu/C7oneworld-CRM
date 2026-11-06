import { http } from '../../http.js';
import { h, mount, fmt } from '../dom.js';
import { alertBox, SOURCE_LABELS, money } from '../ui.js';
import { STAGES, LOST_STAGES, STAGE_LABELS } from './lead.js';

const PERIODS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['90d', 'Last 90 days'],
  ['custom', 'Custom'],
];
const DAY = 86_400_000;
const saved = { period: 'month', owner: 'all', customFrom: '', customTo: '' };

// ---------------------------------------------------------------- time helpers (local time)
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function rangeFor(period, customFrom, customTo) {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  switch (period) {
    case 'today': return [today, tomorrow];
    case 'week': return [addDays(today, -((today.getDay() + 6) % 7)), tomorrow];
    case 'last_month': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 1)];
    case '90d': return [addDays(today, -89), tomorrow];
    case 'custom': {
      const f = customFrom ? parseIso(customFrom) : new Date(today.getFullYear(), today.getMonth(), 1);
      const t = customTo ? addDays(parseIso(customTo), 1) : tomorrow;
      return [f, t > f ? t : addDays(f, 1)];
    }
    default: return [new Date(today.getFullYear(), today.getMonth(), 1), tomorrow];
  }
}

// ---------------------------------------------------------------- formatting
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const moneyShort = (paise) => {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(r >= 1e8 ? 0 : 2)} Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(r >= 1e6 ? 1 : 2)} L`;
  return inr.format(r);
};
const num = new Intl.NumberFormat('en-IN');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
const dateRangeLabel = (f, t) => {
  const last = addDays(t, -1);
  const opts = { day: 'numeric', month: 'short', year: f.getFullYear() === last.getFullYear() ? undefined : 'numeric' };
  const a = f.toLocaleDateString(undefined, opts);
  const b = last.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return iso(f) === iso(last) ? b : `${a} – ${b}`;
};

export function renderDashboard(container, ctx) {
  const seeAll = ctx.can('leads.view_all');
  const state = { ...saved, assignees: [], data: null };
  ctx.setHeader('Dashboard');

  const tooltip = h('div', { class: 'db-tooltip', role: 'tooltip', hidden: true });
  const host = h('div', { class: 'db' });
  const controls = h('div', { class: 'db-controls' });
  mount(container, controls, host, tooltip);

  // ---------------------------------------------------------------- controls
  function renderControls() {
    const seg = h('div', { class: 'db-periods', role: 'group', 'aria-label': 'Period' },
      PERIODS.map(([k, label]) => h('button', {
        type: 'button', class: state.period === k ? 'is-active' : null, 'aria-pressed': String(state.period === k),
        onClick: () => { state.period = k; renderControls(); load(); },
      }, label)));

    let custom = null;
    if (state.period === 'custom') {
      const [f, t] = rangeFor('custom', state.customFrom, state.customTo);
      const from = h('input', { class: 'input', type: 'date', value: state.customFrom || iso(f), max: iso(new Date()), 'aria-label': 'From date' });
      const to = h('input', { class: 'input', type: 'date', value: state.customTo || iso(addDays(t, -1)), max: iso(new Date()), 'aria-label': 'To date' });
      const apply = () => { state.customFrom = from.value; state.customTo = to.value; load(); };
      from.addEventListener('change', apply);
      to.addEventListener('change', apply);
      custom = h('div', { class: 'db-custom' }, from, h('span', { class: 'muted' }, 'to'), to);
    }

    let ownerSel = null;
    if (seeAll) {
      ownerSel = h('select', { class: 'select db-owner', 'aria-label': 'Show figures for' },
        h('option', { value: 'all' }, 'Whole office'),
        h('option', { value: 'unassigned' }, 'Awaiting counselor'),
        state.assignees.length ? h('optgroup', { label: 'Counselor' }, state.assignees.map((a) => h('option', { value: String(a.id) }, a.fullName))) : null);
      ownerSel.value = state.owner;
      ownerSel.addEventListener('change', () => { state.owner = ownerSel.value; load(); });
    }
    mount(controls, seg, custom, h('div', { class: 'spacer' }), ownerSel);
  }

  // ---------------------------------------------------------------- data
  let seq = 0;
  async function load() {
    Object.assign(saved, { period: state.period, owner: state.owner, customFrom: state.customFrom, customTo: state.customTo });
    const [f, t] = rangeFor(state.period, state.customFrom, state.customTo);
    const today = startOfDay(new Date());
    const lmFrom = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lmTo = new Date(today.getFullYear(), today.getMonth(), 1);
    const params = new URLSearchParams({
      from: f.getTime(), to: t.getTime(), owner: state.owner, tz: -new Date().getTimezoneOffset(),
      lmFrom: lmFrom.getTime(), lmTo: lmTo.getTime(),
    });
    const mySeq = ++seq;
    host.classList.add('is-loading');
    try {
      const data = await http.get(`/api/dashboard?${params}`);
      if (mySeq !== seq) return;
      render(data, f, t);
    } catch (err) {
      if (mySeq === seq) mount(host, alertBox('error', err.message));
    } finally {
      if (mySeq === seq) host.classList.remove('is-loading');
    }
  }

  // ---------------------------------------------------------------- render
  function render(d, from, to) {
    const L = d.leads.total;
    const leadsLabel = d.scope.basis === 'assigned' ? (d.scope.label === 'assigned to you' ? 'Leads assigned to you' : 'Leads assigned') : 'New leads';
    const scopeText = !seeAll ? 'Your leads'
      : state.owner === 'all' ? 'Whole office'
        : state.owner === 'unassigned' ? 'Leads awaiting a counselor'
          : state.owner === 'me' ? 'Your leads'
            : (state.assignees.find((a) => String(a.id) === state.owner)?.fullName || 'Counselor');

    const sections = [
      h('div', { class: 'db-intro' },
        h('h2', periodTitle(state.period, from, to)),
        h('p', { class: 'muted' }, `${scopeText} · ${dateRangeLabel(from, to)}`)),

      h('section', { class: 'db-section' },
        h('h3', { class: 'db-h' }, 'Leads'),
        h('div', { class: 'db-tiles' },
          tile(leadsLabel, num.format(L), delta(L, d.leads.previous, 'vs previous period')),
          tile('Converted', num.format(d.outcomes.converted), sub(`${pct(d.outcomes.converted, L)} of these leads`)),
          tile('In pipeline', num.format(d.outcomes.open), sub(`${pct(d.outcomes.open, L)} of these leads`)),
          tile('Lost', num.format(d.outcomes.lost), sub(`${pct(d.outcomes.lost, L)} of these leads`)),
          d.walkins ? tile('Walk-ins', num.format(d.walkins.total), delta(d.walkins.total, d.walkins.previous, 'vs previous period')) : null,
          d.unassigned != null ? tile('Awaiting counselor', num.format(d.unassigned), sub('Not yet with a counselor')) : null,
        ),
        h('div', { class: 'db-main' },
          card(d.scope.basis === 'assigned' ? 'Leads assigned' : 'New leads', lineChart(d.daily, from, to), 'db-chart-card'),
          h('div', { class: 'db-side' },
            card('By source', hbars(d.bySource.map((s) => ({ label: SOURCE_LABELS[s.source] || s.source, value: s.count })), L)),
            card('By stage', hbars([...STAGES, ...LOST_STAGES].map((s) => ({ label: s.label, value: d.byStage[s.key] || 0 })).filter((r) => r.value || STAGES.some((s) => s.label === r.label)), L)),
          ),
        ),
      ),
    ];

    if (d.finance) sections.push(revenueSection(d));
    if (d.byCounselor) sections.push(table('By counselor', 'Counselor', d.byCounselor.map((r) => ({ ...r, label: r.fullName })), 'Leads assigned, agreed and collected in the period · outstanding as of today'));
    if (d.bySourceRevenue) sections.push(table('By lead source', 'Lead source', d.bySourceRevenue.map((r) => ({ ...r, label: SOURCE_LABELS[r.source] || r.source })), 'New leads in the period by source'));
    if (!d.byCounselor && d.byOwner) sections.push(ownerLeadsTable(d.byOwner));

    mount(host, sections);
  }

  function revenueSection(d) {
    const f = d.finance;
    return h('section', { class: 'db-section' },
      h('h3', { class: 'db-h' }, 'Revenue'),
      h('div', { class: 'db-tiles' },
        tile('Amount collected', money(f.collected), delta(f.collected, f.collectedPrevious, 'vs previous period', true), 'is-primary'),
        tile('Previous month', f.collectedLastMonth == null ? '—' : money(f.collectedLastMonth), sub('Last calendar month')),
        tile('Agreed amount', money(f.agreedInPeriod), sub('Agreed in this period')),
        tile('Outstanding', money(f.outstanding), sub(`On ${num.format(f.openDeals)} deal${f.openDeals === 1 ? '' : 's'}, as of today`), f.outstanding ? 'is-warn' : null),
        tile('Collection rate', pct(f.totalCollectedOnDeals, f.totalAgreed), sub(`${moneyShort(f.totalCollectedOnDeals)} of ${moneyShort(f.totalAgreed)} agreed`)),
      ),
    );
  }

  // ---------------------------------------------------------------- building blocks
  // Stat tiles are numbers: label, figure, and what it compares to.
  function tile(label, value, foot, tone) {
    return h('div', { class: ['db-tile', tone] },
      h('span', { class: 'db-tile-label' }, label),
      h('strong', { class: 'db-value' }, value),
      foot);
  }

  const sub = (text) => h('span', { class: 'db-sub' }, text);

  function delta(now, prev, suffix, isMoney = false) {
    if (!prev && !now) return sub('No activity in either period');
    if (!prev) return sub('None in the previous period');
    const change = Math.round(((now - prev) / prev) * 100);
    const up = change > 0;
    const prevText = isMoney ? moneyShort(prev) : num.format(prev);
    return h('span', { class: ['db-delta', change === 0 ? 'is-flat' : up ? 'is-up' : 'is-down'] },
      change === 0 ? '■' : up ? '▲' : '▼', ` ${Math.abs(change)}% `, h('span', { class: 'db-sub' }, `${suffix} (${prevText})`));
  }

  function card(title, body, extra) {
    return h('section', { class: ['card', 'db-card', extra] }, h('div', { class: 'card-head' }, h('h2', title)), h('div', { class: 'card-body' }, body));
  }

  // Horizontal bars: one hue, value + share labelled directly.
  function hbars(rows, total) {
    if (!total) return h('p', { class: 'db-empty' }, 'No leads in this period');
    const max = Math.max(...rows.map((r) => r.value), 1);
    return h('div', { class: 'db-hbars' }, rows.map((r) => h('div', {
      class: 'db-hbar', tabindex: '0', 'aria-label': `${r.label}: ${r.value} (${pct(r.value, total)})`,
      onMouseenter: (e) => showTip(e.currentTarget, `${r.label}`, `${num.format(r.value)} leads · ${pct(r.value, total)}`),
      onMouseleave: hideTip, onFocus: (e) => showTip(e.currentTarget, r.label, `${num.format(r.value)} leads · ${pct(r.value, total)}`), onBlur: hideTip,
    },
      h('span', { class: 'db-hbar-label' }, r.label),
      h('span', { class: 'db-hbar-track' }, h('span', { class: 'db-hbar-fill', style: { width: `${Math.max((r.value / max) * 100, r.value ? 2 : 0)}%` } })),
      h('span', { class: 'db-hbar-value' }, num.format(r.value), h('span', { class: 'muted' }, ` · ${pct(r.value, total)}`)),
    )));
  }

  // Main chart: leads over time as a line (per day, or per week for long periods).
  // Gold marks today, the product's "where you are now" signature.
  function lineChart(daily, from, to) {
    const counts = new Map(daily.map((r) => [r.day, r.count]));
    const days = [];
    for (let d = new Date(from); d < to; d = addDays(d, 1)) days.push(d);
    const weekly = days.length > 62;
    const buckets = [];
    for (const d of days) {
      const start = weekly ? addDays(d, -((d.getDay() + 6) % 7)) : d;
      const key = iso(start);
      const last = buckets[buckets.length - 1];
      if (last && last.key === key) last.value += counts.get(iso(d)) || 0;
      else buckets.push({ key, date: start, value: counts.get(iso(d)) || 0 });
    }
    const total = buckets.reduce((a, b) => a + b.value, 0);
    if (!total) return h('p', { class: 'db-empty' }, 'No leads in this period');

    const W = 720;
    const H = 240;
    const pad = { l: 36, r: 16, t: 16, b: 28 };
    const max = Math.max(...buckets.map((b) => b.value));
    const top = Math.max(4, Math.ceil(max / 4) * 4);
    const n = buckets.length;
    const x = (i) => (n === 1 ? (pad.l + W - pad.r) / 2 : pad.l + (i * (W - pad.l - pad.r)) / (n - 1));
    const y = (v) => H - pad.b - (v / top) * (H - pad.t - pad.b);
    const todayKey = iso(weekly ? addDays(startOfDay(new Date()), -((new Date().getDay() + 6) % 7)) : startOfDay(new Date()));
    const fmtDay = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'db-line', role: 'img', 'aria-label': `${total} leads, ${weekly ? 'per week' : 'per day'}` });
    for (const t of [0, top / 2, top]) {
      svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'db-grid' }));
      svg.append(el('text', { x: pad.l - 8, y: y(t) + 4, class: 'db-axis', 'text-anchor': 'end' }, num.format(t)));
    }
    const pts = buckets.map((b, i) => [x(i), y(b.value)]);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    if (n > 1) {
      svg.append(el('path', { d: `${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`, class: 'db-area' }));
      svg.append(el('path', { d: line, class: 'db-stroke' }));
    }
    const every = Math.max(1, Math.ceil(n / 8));
    buckets.forEach((b, i) => {
      if (i % every === 0 || i === n - 1) {
        svg.append(el('text', { x: x(i), y: H - 8, class: 'db-axis', 'text-anchor': i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle' }, fmtDay(b.date)));
      }
      if (b.key === todayKey) {
        svg.append(el('circle', { cx: x(i), cy: y(b.value), r: 5, class: 'db-today' }));
      }
    });
    if (n === 1) svg.append(el('circle', { cx: x(0), cy: y(buckets[0].value), r: 5, class: 'db-today' }));

    // Hover: crosshair + point, with an invisible column per bucket as the target.
    const cross = el('line', { y1: pad.t, y2: H - pad.b, class: 'db-cross', visibility: 'hidden' });
    const dot = el('circle', { r: 4, class: 'db-dot', visibility: 'hidden' });
    svg.append(cross, dot);
    const slot = n === 1 ? W - pad.l - pad.r : (W - pad.l - pad.r) / (n - 1);
    buckets.forEach((b, i) => {
      const label = weekly ? `Week of ${fmtDay(b.date)}` : b.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      const hit = el('rect', { x: x(i) - slot / 2, y: pad.t, width: slot, height: H - pad.t - pad.b, class: 'db-hit', tabindex: '0', 'aria-label': `${label}: ${b.value}` });
      const on = () => {
        for (const [k, v] of [['x1', x(i)], ['x2', x(i)]]) cross.setAttribute(k, v);
        dot.setAttribute('cx', x(i));
        dot.setAttribute('cy', y(b.value));
        cross.setAttribute('visibility', 'visible');
        dot.setAttribute('visibility', 'visible');
        showTip(dot, label, `${num.format(b.value)} lead${b.value === 1 ? '' : 's'}`);
      };
      const off = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
      hit.addEventListener('mouseenter', on);
      hit.addEventListener('focus', on);
      hit.addEventListener('mouseleave', off);
      hit.addEventListener('blur', off);
      svg.append(hit);
    });

    return h('div', { class: 'db-line-wrap' }, svg,
      h('p', { class: 'db-caption' }, weekly ? 'Per week' : 'Per day', h('span', { class: 'db-key' }, 'Today')));
  }

  function table(title, firstCol, rows, note) {
    const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const body = rows.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'data db-table' },
        h('thead', h('tr', h('th', firstCol), h('th', { class: 'num' }, 'Leads'), h('th', { class: 'num' }, 'Converted'), h('th', { class: 'num' }, 'Conversion'),
          h('th', { class: 'num' }, 'Agreed'), h('th', { class: 'num' }, 'Collected'), h('th', { class: 'num' }, 'Outstanding'))),
        h('tbody', rows.map((r) => h('tr', null,
          h('td', { class: 'primary' }, r.label),
          h('td', { class: 'num' }, num.format(r.leads)),
          h('td', { class: 'num' }, num.format(r.converted)),
          h('td', { class: 'num' }, pctBar(r.converted, r.leads)),
          h('td', { class: 'num' }, money(r.agreed)),
          h('td', { class: 'num db-strong' }, money(r.collected)),
          h('td', { class: ['num', r.outstanding ? 'db-warn' : null] }, money(r.outstanding)),
        ))),
        h('tfoot', h('tr', h('td', 'Total'), h('td', { class: 'num' }, num.format(sum('leads'))), h('td', { class: 'num' }, num.format(sum('converted'))),
          h('td', { class: 'num' }, pct(sum('converted'), sum('leads'))), h('td', { class: 'num' }, money(sum('agreed'))),
          h('td', { class: 'num' }, money(sum('collected'))), h('td', { class: 'num' }, money(sum('outstanding'))))),
      ))
      : h('p', { class: 'card-body db-empty' }, 'No activity in this period');
    return h('section', { class: 'card db-card db-section' },
      h('div', { class: 'card-head' }, h('h2', title)),
      note ? h('p', { class: 'db-note muted' }, note) : null,
      body);
  }

  function ownerLeadsTable(rows) {
    return h('section', { class: 'card db-card db-section' },
      h('div', { class: 'card-head' }, h('h2', 'By counselor')),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data db-table' },
        h('thead', h('tr', h('th', 'Counselor'), h('th', { class: 'num' }, 'Leads'), h('th', { class: 'num' }, 'Converted'), h('th', { class: 'num' }, 'Conversion'), h('th', { class: 'num' }, 'In pipeline'))),
        h('tbody', rows.map((r) => h('tr', null, h('td', { class: 'primary' }, r.fullName), h('td', { class: 'num' }, num.format(r.leads)),
          h('td', { class: 'num' }, num.format(r.converted)), h('td', { class: 'num' }, pctBar(r.converted, r.leads)), h('td', { class: 'num' }, num.format(r.open))))),
      )) : h('p', { class: 'card-body db-empty' }, 'No assigned leads in this period'));
  }

  function pctBar(part, whole) {
    const p = whole ? Math.round((part / whole) * 100) : 0;
    return h('span', { class: 'db-pct' }, h('span', { class: 'db-pct-track' }, h('span', { class: 'db-pct-fill', style: { width: `${p}%` } })), whole ? `${p}%` : '—');
  }

  // ---------------------------------------------------------------- tooltip
  function showTip(target, title, value) {
    mount(tooltip, h('strong', title), h('span', value));
    tooltip.hidden = false;
    const r = target.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    tooltip.style.left = `${r.left - box.left + r.width / 2}px`;
    tooltip.style.top = `${r.top - box.top - 8}px`;
  }
  function hideTip() { tooltip.hidden = true; }

  renderControls();
  if (seeAll && (ctx.can('leads.assign') || ctx.can('walkins.manage'))) {
    http.get('/api/assignees').then((r) => { state.assignees = r.items; renderControls(); }).catch(() => {});
  }
  load();
  const off = ctx.feed.on(() => load());
  return off;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

// The page title names the period, e.g. "November 2026" or "This week".
function periodTitle(period, from, to) {
  const month = (d) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  switch (period) {
    case 'today': return 'Today';
    case 'week': return 'This week';
    case 'month': case 'last_month': return month(from);
    case '90d': return 'Last 90 days';
    default: return dateRangeLabel(from, to);
  }
}
