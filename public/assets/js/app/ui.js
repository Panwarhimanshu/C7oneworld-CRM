import { h, icon, fmt } from './dom.js';

export const STATUS_LABELS = {
  waiting: 'Waiting',
  with_counselor: 'With counselor',
  completed: 'Completed',
  left: 'Left without meeting',
};


export function statusPill(status) {
  return h('span', { class: `pill pill-${status}` }, STATUS_LABELS[status] || status);
}

export function toast(content, { kind = 'info', timeout = 6000 } = {}) {
  const el = h('div', { class: ['toast', kind === 'error' && 'is-error'], role: 'status' }, content);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

export function alertBox(kind, message) {
  return h('div', { class: `alert alert-${kind}`, role: kind === 'error' ? 'alert' : null }, icon(kind === 'error' || kind === 'warning' ? 'alert' : 'check'), h('div', message));
}

// Modal built on the native <dialog> element (focus trapping and Esc handled by the browser).
export function openModal({ title, description, body, actions }) {
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'modal-title' });
  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

  const foot = h('div', { class: 'modal-foot' });
  dialog.append(
    h('div', { class: 'modal-head' }, h('h2', { id: 'modal-title' }, title), description ? h('p', description) : null),
    h('div', { class: 'modal-body' }, body),
    foot,
  );
  for (const a of actions?.({ close }) || [h('button', { class: 'btn', type: 'button', onClick: close }, 'Close')]) foot.append(a);
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const { dialog } = openModal({
      title,
      body: h('p', message),
      actions: ({ close }) => [
        h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'),
        h('button', { class: ['btn', danger ? 'btn-danger' : 'btn-primary'], type: 'button', onClick: () => { ok = true; close(); } }, confirmLabel),
      ],
    });
    dialog.addEventListener('close', () => resolve(ok));
  });
}

export function field({ label, name, input, hint }) {
  input.id ||= `f-${name}`;
  input.name ||= name;
  return h('div', { class: 'field', dataset: { field: name } },
    h('label', { class: 'label', htmlFor: input.id }, label),
    input,
    hint ? h('p', { class: 'hint' }, hint) : null,
    h('p', { class: 'field-error', hidden: true }),
  );
}

export function showFieldErrors(form, fields = {}) {
  let placed = false;
  form.querySelectorAll('[data-field]').forEach((f) => {
    const msg = fields[f.dataset.field];
    f.classList.toggle('has-error', Boolean(msg));
    const p = f.querySelector('.field-error');
    if (p) { p.textContent = msg || ''; p.hidden = !msg; }
    if (msg) placed = true;
  });
  return placed;
}

export async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

export function secretBox(value) {
  const code = h('code', value);
  const copy = h('button', {
    class: 'btn btn-sm', type: 'button',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        copy.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    },
  }, 'Copy');
  return h('div', { class: 'secret-box' }, code, copy);
}

export function ownerChip(owner) {
  if (!owner) return h('span', { class: 'tag tag-warning' }, 'Unassigned');
  return h('span', { class: 'owner-chip' }, h('span', { class: 'avatar-xs', 'aria-hidden': 'true' }, fmt.initials(owner.fullName)), owner.fullName);
}

// Money is stored in paise; shown in rupees (Indian digit grouping).
const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const money = (paise) => (paise == null ? '—' : inrFmt.format(paise / 100));

export const PAYMENT_MODES = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other' };

// Sources offered for new leads, in display order (same list everywhere).
export const NEW_LEAD_SOURCES = ['walk_in', 'phone', 'referral', 'website', 'social', 'email', 'bulk_upload'];

export const SOURCE_LABELS = {
  walk_in: 'Walk-in Form',
  phone: 'Phone call',
  referral: 'Referral',
  website: 'Website',
  social: 'Social media',
  email: 'Email enquiry',
  other: 'Other',
  bulk_upload: 'Bulk Upload',
};

// Popover anchored to a trigger button. Closes on outside click, Escape, or close().
export function dropdown(trigger, { panelClass = '', align = 'right', render, onOpen }) {
  const panel = h('div', { class: ['dropdown-panel', `align-${align}`, panelClass], hidden: true });
  const wrap = h('div', { class: 'dropdown' }, trigger, panel);
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');

  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); trigger.focus(); } };

  function open() {
    panel.replaceChildren();
    const content = render({ close });
    for (const c of [content].flat()) if (c) panel.append(c);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    onOpen?.();
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc);
    document.removeEventListener('keydown', onKey);
  }
  trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
  return { el: wrap, open, close, isOpen: () => !panel.hidden, rerender: () => { if (!panel.hidden) open(); } };
}

export function menuItem(label, { iconNode, onClick, hint, danger } = {}) {
  return h('button', { class: ['menu-item', danger && 'is-danger'], type: 'button', role: 'menuitem', onClick },
    iconNode || null,
    h('span', { class: 'menu-item-text' }, h('span', label), hint ? h('span', { class: 'menu-item-hint' }, hint) : null),
  );
}
