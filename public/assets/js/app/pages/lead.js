import { http } from '../../http.js';
import { h, icon, mount, fmt } from '../dom.js';
import { statusPill, alertBox, confirmModal, openModal, field, showFieldErrors, withBusy, toast, ownerChip, STATUS_LABELS, SOURCE_LABELS, money, PAYMENT_MODES } from '../ui.js';

const CHANNEL_LABELS = { sms: 'SMS', email: 'Email' };

export const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'working', label: 'Working' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'converted', label: 'Converted' },
];
export const LOST_STAGES = [
  { key: 'unqualified', label: 'Unqualified' },
  { key: 'lost_interest', label: 'Lost interest' },
  { key: 'lost_to_competitor', label: 'Lost to competitor' },
];
export const STAGE_LABELS = Object.fromEntries([...STAGES, ...LOST_STAGES].map((s) => [s.key, s.label]));

const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'visits', label: 'Visits' },
  { key: 'notes', label: 'Notes' },
  { key: 'activity', label: 'Activity' },
];

export function stageChip(stage) {
  const lost = LOST_STAGES.some((s) => s.key === stage);
  return h('span', { class: ['stage-chip', `stage-${lost ? 'lost' : stage}`] }, STAGE_LABELS[stage] || stage);
}

export function renderLead(container, ctx, leadIdParam) {
  const leadId = Number(leadIdParam);
  const state = { lead: null, counselors: [], noteDraft: '', stale: false, tab: 'details', target: null, editing: false };

  const back = ctx.can('walkins.view') && history.state?.from === 'walkins'
    ? { href: '/app/walk-ins', label: 'Walk-ins' }
    : { href: '/app/leads', label: ctx.can('leads.view_all') ? 'Leads' : 'My leads' };
  const crumbLink = () => h('a', { href: back.href, dataset: { link: '' } }, back.label);
  ctx.setHeader('Lead profile', { crumbs: [crumbLink(), icon('chevron', 12)] });

  async function load() {
    try {
      const [lead, counselors] = await Promise.all([
        http.get(`/api/leads/${leadId}`),
        ctx.can('walkins.manage') || ctx.can('leads.assign') ? http.get('/api/assignees').then((r) => r.items) : Promise.resolve([]),
      ]);
      state.lead = lead;
      state.counselors = counselors;
      state.stale = false;
      state.target = null;
      render();
    } catch (err) {
      ctx.setHeader(err.status === 404 ? 'Lead not found' : 'Lead profile');
      mount(container, alertBox('error', err.status === 404 ? 'This lead does not exist or is not assigned to you.' : err.message));
    }
  }

  function render() {
    const l = state.lead;
    ctx.setHeader('Lead profile', { crumbs: [crumbLink(), icon('chevron', 12), h('span', { class: 'mono' }, l.code)] });

    mount(container,
      state.stale ? h('div', { class: 'alert alert-info lp-stale' },
        h('div', 'This lead was updated by someone else. ', h('button', { class: 'btn-link', type: 'button', onClick: load }, 'Refresh'))) : null,
      l.access === 'readonly' ? h('div', { class: 'alert alert-info lp-readonly-note', role: 'note' },
        icon('lock', 15),
        h('div', null,
          h('strong', 'View only. '),
          'This lead is not assigned to you. You can read it and add notes. To change details or the stage, ask the front desk to assign it to you.')) : null,
      h('section', { class: 'card lp-summary' },
        header(l),
        facts(l),
        auditStrip(l),
      ),
      pipeline(l),
      tabs(l),
      h('div', { class: 'lp-panel' }, panel(l)),
    );
  }

  // ---------------------------------------------------------------- summary

  function header(l) {
    const dupes = l.possibleDuplicates.length;
    return h('div', { class: 'lp-head' },
      h('a', { class: 'btn btn-ghost btn-sm lp-back', href: back.href, dataset: { link: '' }, 'aria-label': `Back to ${back.label}` }, icon('chevron-left', 16)),
      h('div', { class: 'lp-avatar', 'aria-hidden': 'true' }, fmt.initials(l.fullName)),
      h('div', { class: 'lp-title' },
        h('div', { class: 'lp-name-row' },
          h('h2', l.fullName),
          dupes ? h('button', {
            class: 'tag tag-danger tag-btn', type: 'button', title: 'Show possible duplicates',
            onClick: () => { state.tab = 'details'; render(); document.getElementById('lp-duplicates')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
          }, `Duplicate (${dupes})`) : null,
        ),
        h('div', { class: 'lp-subrow' },
          stageChip(l.stage),
          h('span', { class: 'mono muted' }, l.code),
          isOnPremises(l) ? h('span', { class: 'tag tag-success' }, 'On premises') : null,
        ),
      ),
      h('div', { class: 'spacer' }),
      ctx.can('leads.assign') && l.access === 'full' && !state.editing
        ? h('button', { class: 'btn', type: 'button', onClick: () => openAssign(l) }, icon('users', 15), counselorOwner(l) ? 'Reassign lead' : 'Assign lead')
        : null,
      ctx.can('leads.edit') && l.access === 'full' && !state.editing ? h('button', { class: 'btn', type: 'button', onClick: startEdit }, icon('edit', 15), 'Edit lead') : null,
    );
  }

  function facts(l) {
    const fact = (label, value, extra) => h('div', { class: 'lp-fact' }, h('dt', label), h('dd', value, extra));
    return h('dl', { class: 'lp-facts' },
      fact('Email', l.email ? [h('span', { class: 'lp-copyable' }, l.email, copyBtn(l.email, 'email')), verifiedMark(l.emailVerifiedAt)] : h('span', { class: 'muted' }, 'Not provided')),
      fact('Mobile number', h('span', { class: 'lp-copyable' }, l.mobile, copyBtn(l.mobile, 'mobile number')), verifiedMark(l.mobileVerifiedAt)),
      fact('Assigned to', l.owner ? l.owner.fullName : h('span', { class: 'muted' }, 'Unassigned')),
      fact('Lead source', SOURCE_LABELS[l.source] || l.source),
      fact('Revisit count', String(Math.max(0, l.visits.length - 1))),
      fact('Lead ID', h('span', { class: 'mono' }, l.code)),
      fact('Verified via', l.visits[0] ? CHANNEL_LABELS[l.visits[0].verifiedChannel] : '—'),
      fact('Last visit', l.visits[0] ? fmt.dateTime(l.visits[0].checkedInAt) : '—'),
      fact('Visit status', l.visits[0] ? statusPill(l.visits[0].status) : '—'),
    );
  }

  // Record history footer: who created the lead, who touched it last, and conversion.
  function auditStrip(l) {
    const item = (iconName, label, value, sub, tone) => h('div', { class: ['lp-meta-item', tone && `is-${tone}`] },
      null,
      h('div', { class: 'lp-meta-text' },
        h('span', { class: 'lp-meta-label' }, label),
        h('strong', value),
        sub ? h('span', { class: 'lp-meta-sub' }, sub) : null,
      ),
    );
    const touched = Boolean(l.updatedBy);
    const converted = Boolean(l.convertedAt);
    return h('div', { class: 'lp-meta' },
      item('plus', 'Created', fmt.dateTime(l.createdAt), l.createdBy ? `by ${l.createdBy} · ${SOURCE_LABELS[l.source] || l.source}` : 'via Walk-in Form'),
      item('edit', 'Last updated', touched ? fmt.dateTime(l.updatedAt) : 'No changes yet', touched ? `by ${l.updatedBy}` : 'Only the visitor’s registration so far'),
      item('check', 'Converted', converted ? fmt.dateTime(l.convertedAt) : 'Not converted yet',
        converted ? 'Lead won' : `Current stage: ${STAGE_LABELS[l.stage]}`, converted ? 'won' : null),
    );
  }

  // ---------------------------------------------------------------- stage pipeline

  function pipeline(l) {
    const canEdit = ctx.can('leads.stage') && l.access === 'full' && l.stage !== 'converted';
    const lost = LOST_STAGES.find((s) => s.key === l.stage);
    const currentIdx = lost ? -1 : STAGES.findIndex((s) => s.key === l.stage);
    const next = lost ? null : STAGES[currentIdx + 1];
    const target = state.target && state.target !== l.stage ? STAGES.find((s) => s.key === state.target) : null;

    // When each stage was reached, from the activity history (New = creation date).
    const reachedAt = { new: l.createdAt };
    for (const a of [...l.activity].reverse()) {
      if (a.action === 'lead.stage_changed' && a.details?.to) reachedAt[a.details.to] = a.createdAt;
    }

    const steps = STAGES.map((s, i) => {
      const done = !lost && i < currentIdx;
      const current = !lost && i === currentIdx;
      const isTarget = target?.key === s.key;
      let sub = '';
      if (done) sub = reachedAt[s.key] ? fmt.dateTime(reachedAt[s.key]) : 'Completed';
      else if (current) sub = l.stage === 'converted' ? fmt.dateTime(l.convertedAt) : 'Current stage';
      else if (isTarget) sub = 'Move here';
      else if (!lost && i === currentIdx + 1) sub = 'Next';

      const inner = [
        h('span', { class: 'lp-dot', 'aria-hidden': 'true' }, done || (current && s.key === 'converted') ? icon('check', 14) : String(i + 1)),
        h('span', { class: 'lp-step-text' }, h('span', { class: 'lp-step-label' }, s.label), h('span', { class: 'lp-step-sub' }, sub || ' ')),
      ];
      return h('li', { class: ['lp-step', done && 'is-done', current && 'is-current', isTarget && 'is-target', lost && 'is-muted'] },
        canEdit
          ? h('button', {
            type: 'button', class: 'lp-step-btn',
            'aria-current': current ? 'step' : null,
            'aria-label': `${s.label}${current ? ' (current stage)' : done ? ' (completed)' : ''}`,
            onClick: () => { state.target = s.key === l.stage ? null : s.key; render(); },
          }, inner)
          : h('div', { class: 'lp-step-btn', 'aria-current': current ? 'step' : null }, inner));
    });

    let actions = null;
    if (canEdit) {
      const goTo = target || (lost ? STAGES[2] : next);
      const primary = h('button', { class: 'btn btn-primary lp-advance', type: 'button' },
        icon('check', 15),
        target ? `Move to ${target.label}` : lost ? 'Reopen as Working' : next.key === 'converted' ? 'Mark as Converted' : `Mark “${STAGES[currentIdx].label}” complete`);
      primary.addEventListener('click', async () => {
        if (goTo.key === 'converted' && !(await confirmModal({
          title: 'Mark this lead as converted?', message: 'Converted is the final stage and cannot be changed afterwards.', confirmLabel: 'Mark as converted',
        }))) return;
        withBusy(primary, 'Saving…', () => setStage(goTo.key));
      });

      const lostSelect = h('select', { class: 'select lp-lost', 'aria-label': 'Close as lost' },
        h('option', { value: '' }, lost ? 'Change lost reason…' : 'Close as lost…'),
        LOST_STAGES.filter((s) => s.key !== l.stage).map((s) => h('option', { value: s.key }, s.label)));
      lostSelect.addEventListener('change', async () => {
        const s = LOST_STAGES.find((x) => x.key === lostSelect.value);
        lostSelect.value = '';
        if (s && await confirmModal({ title: `Close lead as “${s.label}”?`, message: 'The lead leaves the active pipeline. It can be reopened later.', confirmLabel: 'Close lead', danger: true })) {
          setStage(s.key);
        }
      });
      actions = h('div', { class: 'lp-path-actions' }, lostSelect, primary);
    }

    return h('section', { class: ['card', 'lp-path', lost && 'is-lost'] },
      h('div', { class: 'lp-path-head' },
        h('span', { class: 'lp-path-title' }, 'Lead stage'),
        stageChip(l.stage),
        l.stageChangedAt ? h('span', { class: 'muted lp-path-when' }, `Updated ${fmt.ago(l.stageChangedAt)}`) : null,
      ),
      h('ol', { class: 'lp-steps', 'aria-label': 'Lead stage' }, steps),
      actions,
      lost ? h('p', { class: 'lp-lost-note' }, icon('alert', 14), `Closed as ${lost.label} ${fmt.dateTime(l.stageChangedAt)}.`) : null,
      l.stage === 'converted' ? h('p', { class: 'lp-won-note' }, icon('check', 14), `Converted ${fmt.dateTime(l.convertedAt)}.`) : null,
    );
  }

  async function setStage(stage) {
    try {
      await http.put(`/api/leads/${leadId}/stage`, { stage });
      toast(`Stage updated to ${STAGE_LABELS[stage]}.`);
      await load();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  // ---------------------------------------------------------------- tabs

  function tabs(l) {
    const counts = { visits: l.visits.length, notes: l.notes.length };
    return h('div', { class: 'lp-tabs', role: 'tablist' }, TABS.map((t) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.tab === t.key),
      class: state.tab === t.key ? 'is-active' : null,
      onClick: () => { state.tab = t.key; state.editing = false; render(); },
    }, t.label, counts[t.key] ? h('span', { class: 'count' }, String(counts[t.key])) : null)));
  }

  function panel(l) {
    switch (state.tab) {
      case 'visits': return visitsPanel(l);
      case 'notes': return notesPanel(l);
      case 'activity': return activityPanel(l);
      default: return detailsPanel(l);
    }
  }

  function section(title, body, { id, open = true } = {}) {
    return h('details', { class: 'lp-section', open, id },
      h('summary', h('span', title), icon('chevron', 14)),
      h('div', { class: 'lp-section-body' }, body),
    );
  }

  function grid(items) {
    return h('dl', { class: 'lp-grid' }, items.map(([label, value]) => h('div', null, h('dt', label), h('dd', value ?? '—'))));
  }

  function startEdit() {
    state.tab = 'details';
    state.editing = true;
    render();
    document.getElementById('le-fullName')?.focus();
  }

  function cancelEdit() {
    state.editing = false;
    render();
  }

  // Inline edit form: same sections as the view, editable fields swapped in.
  function editForm(l) {
    const name = h('input', { class: 'input', id: 'le-fullName', value: l.fullName, maxLength: 100, autocomplete: 'off' });
    const email = h('input', { class: 'input', id: 'le-email', type: 'email', value: l.email, maxLength: 254, autocomplete: 'off', placeholder: 'Not provided' });
    const fieldWrap = (label, key, input, hint) => h('div', { class: 'field', dataset: { field: key } },
      h('label', { class: 'label', htmlFor: input.id }, label), input,
      hint ? h('p', { class: 'hint' }, hint) : null, h('p', { class: 'field-error', hidden: true }));
    const readOnly = (label, value, hint) => h('div', { class: 'field' },
      h('span', { class: 'label' }, label), h('div', { class: 'lp-readonly' }, value), hint ? h('p', { class: 'hint' }, hint) : null);

    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes');
    const form = h('form', { class: 'lp-edit', novalidate: true },
      section('Lead details', h('div', { class: 'lp-edit-grid' },
        fieldWrap('Full name', 'fullName', name),
        readOnly('Lead ID', h('span', { class: 'mono' }, l.code)),
        readOnly('Lead source', SOURCE_LABELS[l.source] || l.source, 'Set when the lead was created and cannot be changed.'),
        readOnly('Stage', stageChip(l.stage), 'Change the stage with the pipeline above.'),
      )),
      section('Contact details', h('div', { class: 'lp-edit-grid' },
        readOnly('Mobile number', [l.mobile, ' ', verifiedMark(l.mobileVerifiedAt)], 'The mobile number cannot be changed here.'),
        fieldWrap('Email', 'email', email, l.emailVerifiedAt ? 'Changing the email marks it as not verified.' : null),
      )),
      h('div', { class: 'lp-edit-foot' },
        h('span', { class: 'muted' }, 'Changes are recorded in the lead’s activity.'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onClick: cancelEdit }, 'Cancel'),
        save,
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(save, 'Saving…', async () => {
        showFieldErrors(form, {});
        try {
          await http.patch(`/api/leads/${leadId}`, { fullName: name.value, email: email.value.trim() });
          state.editing = false;
          toast('Lead details updated.');
          await load();
        } catch (err) {
          if (!showFieldErrors(form, err.fields)) toast(err.message, { kind: 'error' });
        }
      });
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelEdit(); });
    return form;
  }

  function detailsPanel(l) {
    const current = l.visits[0] || null;
    const left = state.editing ? [editForm(l)] : [
      section('Lead details', grid([
        ['Full name', l.fullName],
        ['Lead ID', h('span', { class: 'mono' }, l.code)],
        ['Lead source', SOURCE_LABELS[l.source] || l.source],
        ['Created by', l.createdBy || 'Walk-in Form'],
        ['Stage', stageChip(l.stage)],
        ['Stage updated', l.stageChangedAt ? fmt.dateTime(l.stageChangedAt) : '—'],
        [l.source === 'walk_in' ? 'Walk-in time' : 'Created on', fmt.dateTime(l.createdAt)],
      ])),
      section('Contact details', grid([
        ['Mobile number', [l.mobile, ' ', verifiedMark(l.mobileVerifiedAt)]],
        ['Email', l.email ? [l.email, ' ', verifiedMark(l.emailVerifiedAt)] : 'Not provided'],
        ['Mobile verified on', l.mobileVerifiedAt ? fmt.dateTime(l.mobileVerifiedAt) : 'Not verified'],
        ['Email verified on', l.emailVerifiedAt ? fmt.dateTime(l.emailVerifiedAt) : 'Not verified'],
      ])),
      l.finance ? feesSection(l) : null,
      l.possibleDuplicates.length ? section('Possible duplicates', h('div', null,
        h('p', { class: 'muted' }, 'These leads share this mobile number or email address.'),
        h('ul', { class: 'lp-dupes' }, l.possibleDuplicates.map((d) => h('li', null,
          h('a', { href: `/app/leads/${d.id}`, dataset: { link: '' } }, d.fullName), ' ', h('span', { class: 'mono muted' }, d.code)))),
      ), { id: 'lp-duplicates' }) : null,
    ];
    // Side cards only appear for people who can act on them; the facts grid above
    // already shows owner and visit status to everyone else.
    const right = [
      ctx.can('leads.assign') ? ownerCard(l) : null,
      current && ctx.can('walkins.manage') ? visitCard(l, current) : null,
    ].filter(Boolean);
    if (!right.length) return h('div', { class: 'lp-details-main' }, left);
    return h('div', { class: 'lp-details' }, h('div', { class: 'lp-details-main' }, left), h('div', { class: 'lp-details-side' }, right));
  }

  // ---------------------------------------------------------------- fees & payments

  function feesSection(l) {
    const f = l.finance;
    const canRecord = ctx.can('payments.record') && l.access === 'full';
    const progress = f.agreed ? Math.min(Math.round((f.collected / f.agreed) * 100), 100) : 0;
    const head = h('div', { class: 'fee-summary' },
      h('div', { class: 'fee-fig' }, h('span', 'Agreed amount'), h('strong', f.agreed == null ? 'Not set' : money(f.agreed))),
      h('div', { class: 'fee-fig' }, h('span', 'Collected'), h('strong', { class: 'is-good' }, money(f.collected))),
      h('div', { class: 'fee-fig' }, h('span', 'Outstanding'), h('strong', { class: f.outstanding ? 'is-warn' : null }, f.outstanding == null ? '—' : money(f.outstanding))),
    );
    const bar = f.agreed ? h('div', { class: 'fee-progress', role: 'img', 'aria-label': `${progress}% collected` },
      h('span', { class: 'fee-progress-fill', style: { width: `${progress}%` } }), h('span', { class: 'fee-progress-label' }, `${progress}% collected`)) : null;
    const actions = canRecord ? h('div', { class: 'fee-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => editAgreed(l) }, icon('edit', 14), f.agreed == null ? 'Set agreed amount' : 'Change agreed amount'),
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => recordPayment(l) }, icon('plus', 14), 'Record payment'),
    ) : null;
    const list = f.payments.length
      ? h('div', { class: 'table-wrap fee-table' }, h('table', { class: 'data' },
        h('thead', h('tr', h('th', 'Date'), h('th', { class: 'num' }, 'Amount'), h('th', 'Mode'), h('th', 'Reference'), h('th', { class: 'hide-sm' }, 'Recorded by'))),
        h('tbody', f.payments.map((p) => h('tr', null,
          h('td', { class: 'nowrap' }, fmt.date(p.paidOn)),
          h('td', { class: 'num db-strong' }, money(p.amount)),
          h('td', null, PAYMENT_MODES[p.mode] || p.mode),
          h('td', null, p.reference || h('span', { class: 'muted' }, '—'), p.note ? h('span', { class: 'sub' }, p.note) : null),
          h('td', { class: 'hide-sm' }, p.recordedBy, h('span', { class: 'sub' }, fmt.dateTime(p.createdAt))),
        )))))
      : h('p', { class: 'muted fee-empty' }, 'No payments recorded yet');
    return section('Fees & payments', h('div', { class: 'fee' }, head, bar, actions, list,
      h('p', { class: 'hint' }, 'Payments cannot be edited or deleted. Record a correction as a note and contact a Super Admin.')));
  }

  function editAgreed(l) {
    const input = h('input', { class: 'input', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: l.finance.agreed == null ? '' : String(l.finance.agreed / 100) });
    const form = h('form', { novalidate: true }, field({ label: 'Agreed amount (₹)', name: 'amount', input, hint: 'The total fee agreed with the student. Leave empty to clear.' }));
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save');
    const { close } = openModal({ title: 'Agreed amount', body: form, actions: ({ close }) => [h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save] });
    input.focus();
    const submit = () => withBusy(save, 'Saving…', async () => {
      const raw = input.value.trim();
      try {
        await http.put(`/api/leads/${leadId}/agreed-amount`, { amount: raw === '' ? null : Number(raw) });
        close();
        toast('Agreed amount saved.');
        await load();
      } catch (err) {
        if (!showFieldErrors(form, err.fields)) toast(err.message, { kind: 'error' });
      }
    });
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  function recordPayment(l) {
    const today = new Date();
    const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const amount = h('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal',
      placeholder: l.finance.outstanding ? String(l.finance.outstanding / 100) : '' });
    const date = h('input', { class: 'input', type: 'date', value: isoToday, max: isoToday });
    const mode = h('select', { class: 'select' }, h('option', { value: '' }, 'Select mode…'), Object.entries(PAYMENT_MODES).map(([v, lbl]) => h('option', { value: v }, lbl)));
    const ref = h('input', { class: 'input', maxLength: 60, placeholder: 'Receipt / UTR / cheque no.' });
    const note = h('input', { class: 'input', maxLength: 500, placeholder: 'Optional' });
    const form = h('form', { novalidate: true, class: 'form-grid' },
      field({ label: 'Amount received (₹)', name: 'amount', input: amount, hint: l.finance.outstanding ? `Outstanding: ${money(l.finance.outstanding)}` : null }),
      field({ label: 'Payment date', name: 'paidOn', input: date }),
      field({ label: 'Mode', name: 'mode', input: mode }),
      field({ label: 'Reference', name: 'reference', input: ref }),
      h('div', { class: 'form-span' }, field({ label: 'Note', name: 'note', input: note })),
    );
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Record payment');
    const { close } = openModal({
      title: 'Record payment', description: `${l.fullName} · ${l.code}. Payments cannot be edited or deleted once saved.`, body: form,
      actions: ({ close }) => [h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save],
    });
    amount.focus();
    const submit = () => withBusy(save, 'Saving…', async () => {
      showFieldErrors(form, {});
      const errs = {};
      if (!(Number(amount.value) > 0)) errs.amount = 'Enter the amount received.';
      if (!date.value) errs.paidOn = 'Select the payment date.';
      if (!mode.value) errs.mode = 'Select the payment mode.';
      if (Object.keys(errs).length) { showFieldErrors(form, errs); return; }
      const [y, m, d] = date.value.split('-').map(Number);
      try {
        await http.post(`/api/leads/${leadId}/payments`, {
          amount: Number(amount.value), paidOn: new Date(y, m - 1, d).getTime(), mode: mode.value, reference: ref.value, note: note.value,
        });
        close();
        toast('Payment recorded.');
        await load();
      } catch (err) {
        if (!showFieldErrors(form, err.fields)) toast(err.message, { kind: 'error' });
      }
    });
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  function visitsPanel(l) {
    if (!l.visits.length) {
      return h('section', { class: 'card' }, h('div', { class: 'empty' }, h('strong', 'No office visits yet.'), 'Visits are recorded when this person registers on the Walk-in Form.'));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'table-wrap' },
        h('table', { class: 'data' },
          h('thead', h('tr', h('th', 'Walk-in time'), h('th', 'Status'), h('th', 'Counselor'), h('th', { class: 'hide-sm' }, 'Verified via'), h('th', { class: 'num' }, 'Wait'), h('th', { class: 'hide-sm' }, 'Closed'))),
          h('tbody', l.visits.map((v) => h('tr', null,
            h('td', { class: 'nowrap' }, fmt.dateTime(v.checkedInAt)),
            h('td', null, statusPill(v.status)),
            h('td', null, v.counselor?.fullName || h('span', { class: 'muted' }, '—')),
            h('td', { class: 'hide-sm' }, CHANNEL_LABELS[v.verifiedChannel]),
            h('td', { class: 'num' }, v.attendedAt ? fmt.duration(v.attendedAt - v.checkedInAt) : '—'),
            h('td', { class: 'hide-sm nowrap' }, v.closedAt ? fmt.dateTime(v.closedAt) : '—'),
          ))),
        ),
      ),
    );
  }

  function notesPanel(l) {
    let composer = null;
    if (ctx.can('leads.note')) {
      const ta = h('textarea', { class: 'textarea', maxLength: 2000, placeholder: 'Add a note about this lead…', 'aria-label': 'New note', value: state.noteDraft });
      const counter = h('span', { class: 'muted' }, `${state.noteDraft.length}/2000`);
      const add = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', disabled: !state.noteDraft.trim() }, 'Add note');
      ta.addEventListener('input', () => {
        state.noteDraft = ta.value;
        counter.textContent = `${ta.value.length}/2000`;
        add.disabled = !ta.value.trim();
      });
      composer = h('form', { class: 'note-form card-body' }, ta, h('div', { class: 'row' }, counter, add));
      composer.addEventListener('submit', async (e) => {
        e.preventDefault();
        await withBusy(add, 'Saving…', async () => {
          try {
            await http.post(`/api/leads/${leadId}/notes`, { body: ta.value });
            state.noteDraft = '';
            await load();
          } catch (err) {
            toast(err.message, { kind: 'error' });
          }
        });
      });
    }
    return h('section', { class: 'card' },
      composer,
      l.notes.length
        ? h('ul', { class: 'notes' }, l.notes.map((n) => h('li', null,
          h('div', { class: 'note-head' }, h('strong', n.author.fullName), h('span', fmt.dateTime(n.createdAt))),
          h('p', n.body))))
        : h('p', { class: 'card-body muted' }, 'No notes yet'),
    );
  }

  function activityPanel(l) {
    return h('section', { class: 'card' },
      l.activity.length
        ? h('ol', { class: 'timeline' }, l.activity.map((a) => h('li', null, describe(a), h('span', { class: 'when' }, fmt.dateTime(a.createdAt)))))
        : h('p', { class: 'card-body muted' }, 'No activity recorded'),
    );
  }

  // ---------------------------------------------------------------- side cards

  function assigneeOptions(selectedId, owner) {
    const roles = [...new Set(state.counselors.map((c) => c.roleName))];
    // Show the current owner even when they are not a counselor (e.g. Reception holding a walk-in).
    const holder = owner && !state.counselors.some((c) => c.id === owner.id)
      ? h('option', { value: String(owner.id), selected: selectedId === owner.id }, `${owner.fullName} (current, front desk)`) : null;
    return [holder, roles.map((r) => h('optgroup', { label: r },
      state.counselors.filter((c) => c.roleName === r).map((c) => h('option', { value: String(c.id), selected: selectedId === c.id }, c.fullName))))];
  }

  const counselorOwner = (l) => Boolean(l.owner && state.counselors.some((c) => c.id === l.owner.id));

  function openAssign(l) {
    const select = h('select', { class: 'select', id: 'assign-to' },
      h('option', { value: '' }, 'Select counselor…'),
      assigneeOptions(l.owner?.id, l.owner));
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Assign');
    const { close } = openModal({
      title: counselorOwner(l) ? 'Reassign lead' : 'Assign lead',
      description: `${l.fullName} · ${l.code}. ${l.owner ? `Currently with ${l.owner.fullName}.` : 'Not assigned yet.'} The new owner is notified and the lead appears in their My leads.`,
      body: field({ label: 'Assign to', name: 'assignee', input: select, hint: 'Only logins that can be assigned leads are listed.' }),
      actions: ({ close }) => [h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save],
    });
    select.focus();
    save.addEventListener('click', () => withBusy(save, 'Assigning…', async () => {
      if (!select.value || Number(select.value) === l.owner?.id) { select.focus(); toast('Choose a different counselor.', { kind: 'error' }); return; }
      try {
        await http.put(`/api/leads/${leadId}/assignment`, { assigneeId: Number(select.value) });
        close();
        toast('Lead assigned. It now appears in their My leads.');
        await load();
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    }));
  }

  // The lead owner decides who else can see this lead.
  function ownerCard(l) {
    let control = null;
    if (ctx.can('leads.assign')) {
      const select = h('select', { class: 'select', 'aria-label': 'Lead owner' },
        h('option', { value: '' }, 'Unassigned'),
        assigneeOptions(l.owner?.id, l.owner),
      );
      const save = h('button', { class: 'btn', type: 'button', disabled: true }, l.owner ? 'Reassign' : 'Assign');
      select.addEventListener('change', () => { save.disabled = select.value === String(l.owner?.id ?? ''); });
      save.addEventListener('click', () => withBusy(save, 'Saving…', async () => {
        try {
          await http.put(`/api/leads/${leadId}/assignment`, { assigneeId: select.value ? Number(select.value) : null });
          toast(select.value ? 'Lead assigned. It now appears in their Leads menu.' : 'Lead unassigned.');
          await load();
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      }));
      control = h('div', { class: 'owner-assign' }, select, save);
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Lead owner'), h('div', { class: 'spacer' }), ownerChip(l.owner)),
      h('div', { class: 'card-body' },
        h('p', { class: 'muted owner-note' }, l.owner
          ? `Visible to ${l.owner.fullName} since ${fmt.dateTime(l.assignedAt)}, and to the front desk.`
          : 'Visible only to the front desk and Super Admin until it is assigned.'),
        l.owner && !counselorOwner(l) ? h('p', { class: 'hint' }, 'Held by the front desk. Counselors can find it in search (view only) until it is assigned to one of them.') : null,
        control,
      ),
    );
  }

  function visitCard(l, v) {
    const isOpen = v.status === 'waiting' || v.status === 'with_counselor';
    const manage = ctx.can('walkins.manage') && isOpen;
    const waited = v.attendedAt ? v.attendedAt - v.checkedInAt : v.status === 'waiting' ? Date.now() - v.checkedInAt : null;
    const times = h('div', { class: 'visit-times' },
      h('div', h('span', 'Walk-in time'), h('strong', fmt.time(v.checkedInAt))),
      h('div', h('span', v.status === 'waiting' ? 'Waiting for' : 'Waited'), h('strong', fmt.duration(waited))),
    );

    let actions = null;
    if (manage) {
      const select = h('select', { class: 'select', id: 'counselor', 'aria-label': 'Counselor' },
        h('option', { value: '' }, state.counselors.length ? 'Select counselor…' : 'No logins can receive leads'),
        assigneeOptions(v.counselor?.id ?? l.owner?.id),
      );
      if (v.status === 'waiting') {
        const start = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start consultation');
        start.addEventListener('click', () => {
          if (!select.value) { select.focus(); toast('Select a counselor first.', { kind: 'error' }); return; }
          withBusy(start, 'Saving…', () => updateVisit(v.id, { status: 'with_counselor', counselorId: Number(select.value) }));
        });
        const left = h('button', { class: 'btn btn-danger', type: 'button', onClick: async () => {
          if (await confirmModal({ title: 'Mark as left?', message: `${l.fullName} will be removed from the waiting queue. This closes the visit.`, confirmLabel: 'Mark as left', danger: true })) {
            updateVisit(v.id, { status: 'left' });
          }
        } }, 'Left without meeting');
        actions = h('div', { class: 'visit-actions' },
          field({ label: 'Assign counselor', name: 'counselor', input: select }),
          h('div', { class: 'row' }, start),
          h('div', { class: 'row' }, left),
        );
      } else {
        select.addEventListener('change', () => {
          if (select.value) updateVisit(v.id, { counselorId: Number(select.value) });
        });
        const done = h('button', { class: 'btn btn-primary', type: 'button' }, 'Mark completed');
        done.addEventListener('click', () => withBusy(done, 'Saving…', () => updateVisit(v.id, { status: 'completed' })));
        const backBtn = h('button', { class: 'btn', type: 'button', onClick: () => updateVisit(v.id, { status: 'waiting' }) }, 'Return to queue');
        actions = h('div', { class: 'visit-actions' },
          field({ label: 'Counselor', name: 'counselor', input: select }),
          h('div', { class: 'row' }, done, backBtn),
        );
      }
    } else if (!isOpen) {
      actions = h('p', { class: 'muted' }, `Visit closed ${fmt.dateTime(v.closedAt)}.`);
    } else if (v.counselor) {
      actions = h('p', { class: 'muted' }, `With ${v.counselor.fullName}.`);
    }

    // Show what the visitor typed if it differs from the lead record.
    const diffs = [];
    if (v.submitted.fullName !== l.fullName) diffs.push(`Name: ${v.submitted.fullName}`);
    if (v.submitted.email.toLowerCase() !== l.email.toLowerCase()) diffs.push(`Email: ${v.submitted.email}`);
    if (v.submitted.mobile !== l.mobile) diffs.push(`Mobile: ${v.submitted.mobile}`);

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', isOpen ? 'Current visit' : 'Latest visit'), h('div', { class: 'spacer' }), statusPill(v.status)),
      h('div', { class: 'card-body' },
        h('p', { class: 'muted' }, `${fmt.date(v.checkedInAt)} · Verified via ${CHANNEL_LABELS[v.verifiedChannel]}`),
        times,
        actions,
        diffs.length ? h('div', { class: 'alert alert-info submitted-diff' },
          h('div', 'At this visit the visitor entered different details:', h('ul', diffs.map((d) => h('li', d))),
            ctx.can('leads.edit') ? 'Use Edit lead to update the record if correct.' : null)) : null,
      ),
    );
  }

  // ---------------------------------------------------------------- actions

  async function updateVisit(visitId, body) {
    try {
      await http.patch(`/api/visits/${visitId}`, body);
      await load();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  // Refresh when someone else changes this lead; never discard a note being typed.
  const off = ctx.feed.on((e) => {
    if (e.leadId !== leadId) return;
    if (state.editing || state.noteDraft.trim() || document.querySelector('dialog[open]')) {
      if (!state.stale) { state.stale = true; render(); }
    } else {
      load();
    }
  });

  load();
  return off;
}

// ---------------------------------------------------------------- helpers

function isOnPremises(l) {
  const v = l.visits[0];
  return Boolean(v && (v.status === 'waiting' || v.status === 'with_counselor'));
}

function verifiedMark(at) {
  return at
    ? h('span', { class: 'verified', title: `Verified ${fmt.dateTime(at)}` }, icon('check', 12), 'Verified')
    : h('span', { class: 'unverified' }, 'Not verified');
}

function copyBtn(value, label) {
  const btn = h('button', {
    class: 'lp-copy', type: 'button', title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
    onClick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(value);
        btn.classList.add('is-copied');
        toast(`Copied ${label}.`, { timeout: 2000 });
        setTimeout(() => btn.classList.remove('is-copied'), 1500);
      } catch {
        toast('Copy is not available in this browser.', { kind: 'error' });
      }
    },
  }, icon('copy', 14));
  return btn;
}

function describe(a) {
  const d = a.details || {};
  const by = a.actorName ? h('span', { class: 'muted' }, ` — ${a.actorName}`) : null;
  switch (a.action) {
    case 'lead.created':
      return [h('strong', 'Registered as a walk-in'), ` (verified via ${CHANNEL_LABELS[d.verifiedVia] || d.verifiedVia})`];
    case 'lead.checked_in':
      return d.duplicateCheckIn
        ? ['Registered again while already waiting (same visit)']
        : [h('strong', 'Walked in for a new visit'), ` (verified via ${CHANNEL_LABELS[d.verifiedVia] || d.verifiedVia})`];
    case 'lead.updated':
      return ['Details updated: ', Object.entries(d).map(([k, v]) => {
        const label = { fullName: 'name', email: 'email', source: 'lead source' }[k] || k;
        const show = (x) => (k === 'source' ? SOURCE_LABELS[x] || x : x) || 'none';
        return `${label} ${show(v.from)} → ${show(v.to)}`;
      }).join(', '), by];
    case 'lead.stage_changed':
      return ['Stage changed: ', `${STAGE_LABELS[d.from] || d.from} → `, h('strong', STAGE_LABELS[d.to] || d.to), by];
    case 'lead.assigned':
      return d.to
        ? ['Assigned to ', h('strong', d.to), d.from ? ` (was ${d.from})` : '', by]
        : ['Unassigned', d.from ? ` (was ${d.from})` : '', by];
    case 'lead.agreed_amount':
      return ['Agreed amount ', d.from == null ? 'set to ' : `changed from ${money(d.from)} to `, h('strong', d.to == null ? 'not set' : money(d.to)), by];
    case 'lead.payment_recorded':
      return [h('strong', `Payment of ${money(d.amount)}`), ` recorded (${PAYMENT_MODES[d.mode] || d.mode}${d.reference ? ` · ${d.reference}` : ''})`, by];
    case 'lead.note_added':
      return ['Note added', by];
    case 'visit.updated': {
      const parts = [];
      if (d.status) parts.push(`${STATUS_LABELS[d.status.from]} → ${STATUS_LABELS[d.status.to]}`);
      if ('counselor' in d) parts.push(d.counselor ? `counselor: ${d.counselor}` : 'counselor removed');
      return ['Visit updated: ', parts.join(', ') || 'no changes', by];
    }
    default:
      return [a.action, by];
  }
}
