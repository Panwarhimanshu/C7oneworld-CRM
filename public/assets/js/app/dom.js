// Safe DOM construction. All text goes through text nodes; innerHTML is never used.

const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'required', 'type', 'name', 'id', 'htmlFor', 'maxLength', 'placeholder', 'rows', 'colSpan', 'title', 'tabIndex', 'autocomplete']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [key, val] of Object.entries(props || {})) {
    if (val == null || val === false && !PROPS.has(key)) continue;
    if (key === 'class') el.className = Array.isArray(val) ? val.filter(Boolean).join(' ') : val;
    // Styles go through CSSOM (allowed by the CSP); style attributes would be blocked.
    else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
    else if (key === 'dataset') Object.assign(el.dataset, val);
    else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (PROPS.has(key)) el[key] = val;
    else if (key === 'href' && /^\s*javascript:/i.test(String(val))) continue;
    else el.setAttribute(key, val === true ? '' : String(val));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function mount(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  walkin: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3 2.9-5.5 6.5-5.5s6.5 2.5 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .8 3.5 2.6 3.5 5.2',
  audit: 'M8 3h8l4 4v14H4V3h4zM15 3v5h5M8 12h8M8 16h8M8 8h3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  check: 'M5 12.5l4.2 4.2L19 7',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.8L2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chevron: 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  bell: 'M6 10a6 6 0 1 1 12 0c0 4 1.5 6 2 7H4c.5-1 2-3 2-7zM10 20.5a2 2 0 0 0 4 0',
  'chevron-down': 'M6 9l6 6 6-6',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  money: 'M6 4h12M6 9h12M6 4c5 0 7 2 7 5s-2 5-7 5l8 6',
  dashboard: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  download: 'M12 4v12M7 11l5 5 5-5M4 16v4h16v-4',
  leads: 'M4 5h16v4H4zM4 11h16v4H4zM4 17h10v2H4z',
  shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || '');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------- formatting

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export const fmt = {
  time: (ms) => (ms ? timeFmt.format(ms) : '—'),
  date: (ms) => (ms ? dateFmt.format(ms) : '—'),
  dateTime: (ms) => (ms ? dateTimeFmt.format(ms) : '—'),
  duration(ms) {
    if (ms == null || ms < 0) return '—';
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return '< 1 min';
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    return `${h}h ${String(mins % 60).padStart(2, '0')}m`;
  },
  ago(ms) {
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    return dateFmt.format(ms);
  },
  initials(name) {
    const parts = String(name || '').trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  },
};

export function localDayRange(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  const to = new Date(y, m - 1, d + 1).getTime();
  return { from, to };
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
