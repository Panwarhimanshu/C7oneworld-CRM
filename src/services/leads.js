'use strict';

const { AppError, badRequest, notFound, forbidden } = require('../lib/errors');
const { toE164 } = require('../lib/phone');
const { parseCsv } = require('../lib/csv');
const { schemas } = require('../lib/validate');

const TRANSITIONS = {
  waiting: ['with_counselor', 'left'],
  with_counselor: ['completed', 'waiting'],
  completed: [],
  left: [],
};

const PAGE_SIZE = 25;
const IMPORT_MAX_ROWS = 2000;

// Accepted CSV headers (case/spacing-insensitive) for bulk upload.
const IMPORT_COLUMNS = {
  fullName: ['full name', 'fullname', 'name', 'lead name'],
  countryCode: ['country code', 'countrycode', 'code', 'isd'],
  mobile: ['mobile', 'mobile number', 'phone', 'phone number', 'contact'],
  email: ['email', 'email address', 'e-mail'],
  source: ['source', 'lead source'],
  assignee: ['assign to', 'assign to (login email)', 'assigned to', 'owner', 'counselor', 'counselor email'],
  note: ['note', 'notes', 'remark', 'remarks', 'comment'],
};
const SOURCE_ALIASES = {
  phone: 'phone', 'phone call': 'phone', call: 'phone',
  walk_in: 'walk_in', 'walk-in': 'walk_in', walkin: 'walk_in', 'walk-in form': 'walk_in',
  referral: 'referral', website: 'website', web: 'website',
  social: 'social', 'social media': 'social',
  email: 'email', 'email enquiry': 'email',
  bulk_upload: 'bulk_upload', 'bulk upload': 'bulk_upload',
};

// Pipeline: open stages advance in order; a lead can be closed as converted or lost.
const OPEN_STAGES = ['new', 'contacted', 'working', 'qualified'];
const LOST_STAGES = ['unqualified', 'lost_interest', 'lost_to_competitor'];
const STAGE_FILTERS = {
  open: OPEN_STAGES,
  lost: LOST_STAGES,
};

function visitRow(v) {
  return {
    id: v.id,
    leadId: v.lead_id,
    status: v.status,
    counselor: v.counselor_id ? { id: v.counselor_id, fullName: v.counselor_name } : null,
    submitted: { fullName: v.submitted_name, email: v.submitted_email, mobile: v.submitted_mobile },
    verifiedChannel: v.verified_channel,
    checkedInAt: v.checked_in_at,
    attendedAt: v.attended_at,
    closedAt: v.closed_at,
  };
}

const escapeLike = (s) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

// Minimum search length before unassigned leads are included for assigned-only logins,
// so nobody can list every unassigned lead with a one-letter search.
const UNASSIGNED_SEARCH_MIN = 3;

// Lead transparency:
//   'full'     - "View all leads", or the lead is assigned to this login
//   'readonly' - lead awaiting a counselor (no owner, or held by the front desk), found
//                via search: view + notes, no field changes
//   null       - not visible; reported as "not found" so its existence is not revealed
// counselorIds: logins that can be assigned leads ("Can be assigned leads").
function accessLevel(actor, lead, counselorIds) {
  if (actor.permissions.has('leads.view_all')) return 'full';
  if (actor.permissions.has('leads.view_assigned') && lead.assigned_to === actor.id) return 'full';
  const awaitingCounselor = lead.assigned_to == null || !counselorIds.has(lead.assigned_to);
  if (actor.permissions.has('leads.search_unassigned') && awaitingCounselor) return 'readonly';
  return null;
}

function createLeadService({ db, audit, events, access, notifications }) {
  const q = {
    walkins: db.prepare(`SELECT v.*, c.id AS counselor_id, c.full_name AS counselor_name,
        l.lead_code, l.full_name AS lead_name, l.email AS lead_email, l.mobile AS lead_mobile,
        (SELECT COUNT(*) FROM visits pv WHERE pv.lead_id = l.id AND pv.id < v.id) AS previous_visits
      FROM visits v
      JOIN leads l ON l.id = v.lead_id
      LEFT JOIN users c ON c.id = v.assigned_counselor_id
      WHERE ((v.checked_in_at >= @from AND v.checked_in_at < @to)
             OR (@includeOpen = 1 AND v.status IN ('waiting','with_counselor')))
        AND (@status = 'all' OR v.status = @status)
        AND (@q = '' OR l.full_name LIKE @like ESCAPE '\\' OR l.email LIKE @like ESCAPE '\\'
             OR l.mobile LIKE @like ESCAPE '\\' OR l.lead_code LIKE @like ESCAPE '\\')
      ORDER BY CASE v.status WHEN 'waiting' THEN 0 WHEN 'with_counselor' THEN 1 ELSE 2 END, v.checked_in_at DESC
      LIMIT 500`),
    walkinCounts: db.prepare(`SELECT status, COUNT(*) AS n FROM visits
      WHERE (checked_in_at >= @from AND checked_in_at < @to)
         OR (@includeOpen = 1 AND status IN ('waiting','with_counselor'))
      GROUP BY status`),
    lead: db.prepare(`SELECT l.*, o.full_name AS owner_name, ub.full_name AS updated_by_name, cb.full_name AS created_by_name
      FROM leads l LEFT JOIN users o ON o.id = l.assigned_to LEFT JOIN users ub ON ub.id = l.updated_by
      LEFT JOIN users cb ON cb.id = l.created_by WHERE l.id = ?`),
    insertLead: db.prepare(`INSERT INTO leads (lead_code, full_name, email, mobile, source, created_by, assigned_to, assigned_at, created_at, updated_at)
      VALUES (@tmpCode, @fullName, @email, @mobile, @source, @createdBy, @assignedTo, @assignedAt, @now, @now)`),
    setLeadCode: db.prepare('UPDATE leads SET lead_code = ? WHERE id = ?'),
    setStage: db.prepare(`UPDATE leads SET stage = @stage, stage_changed_at = @now, converted_at = @convertedAt,
      updated_at = @now, updated_by = @by WHERE id = @id`),
    visitsForLead: db.prepare(`SELECT v.*, c.id AS counselor_id, c.full_name AS counselor_name
      FROM visits v LEFT JOIN users c ON c.id = v.assigned_counselor_id
      WHERE v.lead_id = ? ORDER BY v.checked_in_at DESC`),
    notes: db.prepare(`SELECT n.id, n.body, n.created_at, u.id AS author_id, u.full_name AS author_name
      FROM lead_notes n JOIN users u ON u.id = n.author_id WHERE n.lead_id = ? ORDER BY n.created_at DESC`),
    activity: db.prepare(`SELECT a.id, a.action, a.details, a.created_at, u.full_name AS actor_name
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity_type = 'lead' AND a.entity_id = ? AND a.action <> 'lead.viewed'
      ORDER BY a.created_at DESC LIMIT 100`),
    existingByMobile: db.prepare('SELECT lead_code FROM leads WHERE mobile = ? LIMIT 1').pluck(),
    existingByEmail: db.prepare(`SELECT lead_code FROM leads WHERE email = ? AND email <> '' LIMIT 1`).pluck(),
    possibleDuplicates: db.prepare(`SELECT id, lead_code, full_name FROM leads
      WHERE id <> @id AND (mobile = @mobile OR (@email <> '' AND email = @email)) ORDER BY id LIMIT 10`),
    updateLead: db.prepare(`UPDATE leads SET full_name = @fullName, email = @email,
      email_verified_at = @emailVerifiedAt, updated_at = @now, updated_by = @by WHERE id = @id`),
    assign: db.prepare('UPDATE leads SET assigned_to = @to, assigned_at = @at, updated_at = @at, updated_by = @by WHERE id = @id'),
    insertNote: db.prepare('INSERT INTO lead_notes (lead_id, author_id, body, created_at) VALUES (?, ?, ?, ?)'),
    payments: db.prepare(`SELECT p.*, u.full_name AS recorded_by_name FROM payments p JOIN users u ON u.id = p.recorded_by
      WHERE p.lead_id = ? ORDER BY p.paid_on DESC, p.id DESC`),
    paidTotal: db.prepare('SELECT COALESCE(SUM(amount), 0) FROM payments WHERE lead_id = ?').pluck(),
    setAgreed: db.prepare('UPDATE leads SET agreed_amount = @amount, agreed_set_at = @now, agreed_set_by = @by, updated_at = @now, updated_by = @by WHERE id = @id'),
    insertPayment: db.prepare(`INSERT INTO payments (lead_id, amount, paid_on, mode, reference, note, recorded_by, created_at)
      VALUES (@leadId, @amount, @paidOn, @mode, @reference, @note, @by, @now)`),
    touchLead: db.prepare('UPDATE leads SET updated_at = @now, updated_by = @by WHERE id = @id'),
    visit: db.prepare('SELECT * FROM visits WHERE id = ?'),
    updateVisit: db.prepare(`UPDATE visits SET status = @status, assigned_counselor_id = @counselorId,
      attended_at = @attendedAt, closed_at = @closedAt, updated_at = @now WHERE id = @id`),
  };

  // ---------------------------------------------------------------- lead list

  // "Awaiting counselor": no owner, or owned by someone who is not a counselor (front desk).
  const AWAITING = `(l.assigned_to IS NULL OR l.assigned_to NOT IN (SELECT value FROM json_each(@counselors)))`;
  const counselorIds = () => new Set(access.usersWith('leads.receive').map((u) => u.id));
  const LIST_WHERE = `
    WHERE (@scopeAll = 1 OR l.assigned_to = @me OR (@withUnassigned = 1 AND ${AWAITING}))
      AND (@owner = 'all' OR (@owner = 'unassigned' AND ${AWAITING}) OR (@owner = 'user' AND l.assigned_to = @ownerId))
      AND (@status = 'all' OR (@status = 'none' AND lv.id IS NULL) OR lv.status = @status)
      AND (@stages IS NULL OR l.stage IN (SELECT value FROM json_each(@stages)))
      AND (@q = '' OR l.full_name LIKE @like ESCAPE '\\' OR l.email LIKE @like ESCAPE '\\'
           OR l.mobile LIKE @like ESCAPE '\\' OR l.lead_code LIKE @like ESCAPE '\\')`;
  const LIST_FROM = `
    FROM leads l
    LEFT JOIN users o ON o.id = l.assigned_to
    LEFT JOIN visits lv ON lv.id = (SELECT id FROM visits WHERE lead_id = l.id ORDER BY checked_in_at DESC LIMIT 1)`;
  const listQ = db.prepare(`SELECT l.id, l.lead_code, l.full_name, l.email, l.mobile, l.source, l.created_at, l.stage,
      l.assigned_to, l.assigned_at, o.full_name AS owner_name, lv.status AS last_status, lv.checked_in_at AS last_visit_at,
      (SELECT COUNT(*) FROM visits WHERE lead_id = l.id) AS visit_count
    ${LIST_FROM} ${LIST_WHERE}
    ORDER BY COALESCE(lv.checked_in_at, l.created_at) DESC, l.id DESC LIMIT @limit OFFSET @offset`);
  const countQ = db.prepare(`SELECT COUNT(*) ${LIST_FROM} ${LIST_WHERE}`).pluck();

  function listLeads({ q: search, owner, status, stage, page }, actor) {
    const scopeAll = actor.permissions.has('leads.view_all') ? 1 : 0;
    let ownerMode = 'all';
    let ownerId = null;
    if (scopeAll) {
      if (owner === 'unassigned') ownerMode = 'unassigned';
      else if (owner === 'me') { ownerMode = 'user'; ownerId = actor.id; }
      else if (/^\d+$/.test(owner)) { ownerMode = 'user'; ownerId = Number(owner); }
    }
    const stages = stage === 'all' ? null : JSON.stringify(STAGE_FILTERS[stage] || [stage]);
    // Assigned-only logins may also find unassigned leads, but only by searching.
    const withUnassigned = !scopeAll && actor.permissions.has('leads.search_unassigned') && search.length >= UNASSIGNED_SEARCH_MIN ? 1 : 0;
    const counselors = counselorIds();
    const params = { scopeAll, withUnassigned, me: actor.id, owner: ownerMode, ownerId, status, stages, q: search, like: escapeLike(search), counselors: JSON.stringify([...counselors]) };
    const total = countQ.get(params);
    const items = listQ.all({ ...params, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }).map((r) => ({
      id: r.id,
      code: r.lead_code,
      fullName: r.full_name,
      email: r.email,
      mobile: r.mobile,
      source: r.source,
      stage: r.stage,
      createdAt: r.created_at,
      owner: r.assigned_to ? { id: r.assigned_to, fullName: r.owner_name } : null,
      assignedAt: r.assigned_at,
      lastVisit: r.last_status ? { status: r.last_status, checkedInAt: r.last_visit_at } : null,
      visitCount: r.visit_count,
      access: accessLevel(actor, r, counselors),
    }));
    return { items, total, page, pageSize: PAGE_SIZE, scope: scopeAll ? 'all' : 'assigned' };
  }

  // ---------------------------------------------------------------- walk-ins

  function walkins({ from, to, status, q: search }) {
    if (to <= from || to - from > 31 * 86_400_000) throw badRequest('Choose a date range of up to 31 days.');
    // When viewing the current day, visits still open from earlier days stay on the
    // desk's list so nobody waiting is lost at midnight.
    const includeOpen = to > Date.now() ? 1 : 0;
    const rows = q.walkins.all({ from, to, status, q: search, like: escapeLike(search), includeOpen });
    const counts = { waiting: 0, with_counselor: 0, completed: 0, left: 0 };
    for (const r of q.walkinCounts.all({ from, to, includeOpen })) counts[r.status] = r.n;
    return {
      counts,
      items: rows.map((r) => ({
        ...visitRow(r),
        lead: { id: r.lead_id, code: r.lead_code, fullName: r.lead_name, email: r.lead_email, mobile: r.lead_mobile },
        isReturning: r.previous_visits > 0,
      })),
    };
  }

  // ---------------------------------------------------------------- single lead

  // need: 'view' (read, add notes) or 'edit' (change fields or stage).
  function visibleLead(id, actor, need = 'view') {
    const l = q.lead.get(id);
    const level = l ? accessLevel(actor, l, counselorIds()) : null;
    if (!level) throw notFound('Lead not found.');
    if (need === 'edit' && level !== 'full') {
      throw forbidden('This lead is not assigned to you. You can view it and add notes, but only the assigned counselor can change it.');
    }
    l.access = level;
    return l;
  }

  function getLead(id, actor, ip) {
    const l = visibleLead(id, actor);
    audit({ actorId: actor.id, action: 'lead.viewed', entityType: 'lead', entityId: id, ip });
    return {
      id: l.id,
      code: l.lead_code,
      fullName: l.full_name,
      email: l.email,
      mobile: l.mobile,
      mobileVerifiedAt: l.mobile_verified_at,
      emailVerifiedAt: l.email_verified_at,
      source: l.source,
      stage: l.stage,
      stageChangedAt: l.stage_changed_at,
      convertedAt: l.converted_at,
      createdAt: l.created_at,
      createdBy: l.created_by_name || null,
      updatedAt: l.updated_at,
      updatedBy: l.updated_by_name || null,
      owner: l.assigned_to ? { id: l.assigned_to, fullName: l.owner_name } : null,
      assignedAt: l.assigned_at,
      visits: q.visitsForLead.all(id).map(visitRow),
      notes: q.notes.all(id).map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at, author: { id: n.author_id, fullName: n.author_name } })),
      activity: q.activity.all(id).map((a) => ({
        id: a.id, action: a.action, details: a.details ? JSON.parse(a.details) : null, createdAt: a.created_at, actorName: a.actor_name,
      })),
      // Other leads are only disclosed to logins that can see every lead.
      access: l.access,
      finance: financeFor(l),
      possibleDuplicates: actor.permissions.has('leads.view_all')
        ? q.possibleDuplicates.all({ id, mobile: l.mobile, email: l.email }).map((d) => ({ id: d.id, code: d.lead_code, fullName: d.full_name }))
        : [],
    };
  }

  // ---------------------------------------------------------------- fees & payments (amounts in paise)

  function financeFor(l) {
    const collected = q.paidTotal.get(l.id);
    return {
      agreed: l.agreed_amount,
      agreedSetAt: l.agreed_set_at,
      collected,
      outstanding: l.agreed_amount == null ? null : Math.max(l.agreed_amount - collected, 0),
      payments: q.payments.all(l.id).map((p) => ({
        id: p.id, amount: p.amount, paidOn: p.paid_on, mode: p.mode, reference: p.reference, note: p.note,
        recordedBy: p.recorded_by_name, createdAt: p.created_at,
      })),
    };
  }

  function setAgreedAmount(id, rupees, actor, ip) {
    const l = visibleLead(id, actor, 'edit');
    const amount = rupees == null ? null : Math.round(rupees * 100);
    if (amount === l.agreed_amount) return;
    q.setAgreed.run({ id, amount, now: Date.now(), by: actor.id });
    audit({ actorId: actor.id, action: 'lead.agreed_amount', entityType: 'lead', entityId: id, details: { from: l.agreed_amount, to: amount }, ip });
  }

  function recordPayment(id, input, actor, ip) {
    const l = visibleLead(id, actor, 'edit');
    const now = Date.now();
    if (input.paidOn > now + 86_400_000) throw badRequest('The payment date cannot be in the future.');
    if (input.paidOn < Date.UTC(2000, 0, 1)) throw badRequest('Enter a valid payment date.');
    const amount = Math.round(input.amount * 100);
    const paymentId = db.transaction(() => {
      const pid = Number(q.insertPayment.run({ leadId: id, amount, paidOn: input.paidOn, mode: input.mode, reference: input.reference, note: input.note, by: actor.id, now }).lastInsertRowid);
      q.touchLead.run({ id, now, by: actor.id });
      audit({ actorId: actor.id, action: 'lead.payment_recorded', entityType: 'lead', entityId: id, details: { paymentId: pid, amount, mode: input.mode, reference: input.reference || null }, ip });
      return pid;
    })();
    events.publish('walkin', { leadId: id }, { permission: 'leads.view_all' });
    return { id: paymentId, outstanding: l.agreed_amount == null ? null : Math.max(l.agreed_amount - q.paidTotal.get(id), 0) };
  }

  function updateLead(id, input, actor, ip) {
    const l = visibleLead(id, actor, 'edit');
    const fullName = input.fullName ?? l.full_name;
    const email = input.email ?? l.email;
    const emailChanged = email !== l.email;
    const changes = {};
    if (fullName !== l.full_name) changes.fullName = { from: l.full_name, to: fullName };
    if (emailChanged) changes.email = { from: l.email, to: email };
    if (!Object.keys(changes).length) return;

    q.updateLead.run({ id, fullName, email, emailVerifiedAt: emailChanged ? null : l.email_verified_at, now: Date.now(), by: actor.id });
    audit({ actorId: actor.id, action: 'lead.updated', entityType: 'lead', entityId: id, details: changes, ip });
    events.publish('walkin', { leadId: id }, { permission: 'walkins.view' });
  }

  function addNote(id, body, actor, ip) {
    visibleLead(id, actor);
    const noteId = Number(q.insertNote.run(id, actor.id, body, Date.now()).lastInsertRowid);
    audit({ actorId: actor.id, action: 'lead.note_added', entityType: 'lead', entityId: id, details: { noteId }, ip });
  }

  // ---------------------------------------------------------------- assignment

  function assignee(userId) {
    const match = access.usersWith('leads.receive').find((u) => u.id === userId);
    if (!match) throw badRequest('Select an active login that can be assigned leads.');
    return match;
  }

  // Records an ownership change and tells the people affected.
  function setOwner(lead, toUser, actor, ip) {
    const fromId = lead.assigned_to ?? null;
    if (fromId === (toUser?.id ?? null)) return false;
    q.assign.run({ id: lead.id, to: toUser?.id ?? null, at: Date.now(), by: actor.id });
    audit({
      actorId: actor.id, action: 'lead.assigned', entityType: 'lead', entityId: lead.id,
      details: { from: lead.owner_name || null, to: toUser?.fullName || null }, ip,
    });
    if (toUser && toUser.id !== actor.id) {
      notifications.notify([toUser.id], {
        type: 'lead.assigned', title: 'Lead assigned to you',
        body: `${lead.full_name} (${lead.lead_code}) was assigned to you by ${actor.fullName}.`, link: `/app/leads/${lead.id}`,
      });
    }
    // The previous owner loses access, so the message carries no link.
    if (fromId && fromId !== actor.id) {
      notifications.notify([fromId], {
        type: 'lead.reassigned', title: 'Lead moved off your list',
        body: `${lead.full_name} (${lead.lead_code}) is now ${toUser ? `with ${toUser.fullName}` : 'unassigned'}.`,
      });
    }
    return true;
  }

  // Quick Create: a lead entered by staff (phone call, referral...). Logins that can
  // only see their own leads become the owner automatically so the lead stays visible.
  function createLead(input, actor, ip) {
    const mobile = toE164(input.countryCode, input.mobile);
    if (!mobile) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Please correct the highlighted fields.', { fields: { mobile: 'Enter a valid mobile number.' } });
    }
    let owner = null;
    if (input.assigneeId != null) {
      if (!actor.permissions.has('leads.assign')) throw badRequest('You cannot assign leads to other people.');
      owner = assignee(input.assigneeId);
    } else if (!actor.permissions.has('leads.view_all')) {
      owner = { id: actor.id, fullName: actor.fullName };
    }

    const now = Date.now();
    const leadId = db.transaction(() => {
      const id = Number(q.insertLead.run({
        tmpCode: `tmp-${now}-${actor.id}`, fullName: input.fullName, email: input.email, mobile, source: input.source,
        createdBy: actor.id, assignedTo: owner?.id ?? null, assignedAt: owner ? now : null, now,
      }).lastInsertRowid);
      q.setLeadCode.run(`LD${String(id).padStart(6, '0')}`, id);
      if (input.note) q.insertNote.run(id, actor.id, input.note, now);
      audit({ actorId: actor.id, action: 'lead.created', entityType: 'lead', entityId: id, details: { source: input.source, manual: true }, ip });
      if (owner) {
        audit({ actorId: actor.id, action: 'lead.assigned', entityType: 'lead', entityId: id, details: { from: null, to: owner.fullName }, ip });
      }
      return id;
    })();

    if (owner && owner.id !== actor.id) {
      notifications.notify([owner.id], {
        type: 'lead.assigned', title: 'Lead assigned to you',
        body: `${input.fullName} (LD${String(leadId).padStart(6, '0')}) was assigned to you by ${actor.fullName}.`, link: `/app/leads/${leadId}`,
      });
    }
    events.publish('walkin', { leadId }, { permission: 'leads.view_all' });
    return { id: leadId };
  }

  function assignLead(id, assigneeId, actor, ip) {
    const l = visibleLead(id, actor, 'edit');
    const to = assigneeId == null ? null : assignee(assigneeId);
    if (setOwner(l, to, actor, ip)) events.publish('walkin', { leadId: id }, { permission: 'walkins.view' });
  }

  // Converted is final. Lost leads can be reopened into an open stage.
  function setStage(id, stage, actor, ip) {
    const l = visibleLead(id, actor, 'edit');
    if (l.stage === stage) return;
    if (l.stage === 'converted') throw badRequest('This lead is already converted and cannot change stage.');
    const now = Date.now();
    q.setStage.run({ id, stage, now, convertedAt: stage === 'converted' ? now : null, by: actor.id });
    audit({ actorId: actor.id, action: 'lead.stage_changed', entityType: 'lead', entityId: id, details: { from: l.stage, to: stage }, ip });
    events.publish('walkin', { leadId: id }, { permission: 'walkins.view' });
  }

  // Bulk upload (Super Admin). dryRun validates and reports; otherwise valid rows are
  // created in one transaction - all of them or none.
  function importLeads({ csv, defaultSource, defaultAssigneeId, skipDuplicates, dryRun }, actor, ip) {
    const table = parseCsv(csv);
    if (table.length < 2) throw badRequest('The file has no lead rows. Keep the header row and add one lead per line.');
    const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
    const col = {};
    for (const [key, names] of Object.entries(IMPORT_COLUMNS)) {
      const idx = header.findIndex((h) => names.includes(h));
      if (idx !== -1) col[key] = idx;
    }
    if (col.fullName === undefined || col.mobile === undefined) {
      throw badRequest('The file needs "Full name" and "Mobile" columns. Download the template to see the expected format.');
    }
    const dataRows = table.slice(1);
    if (dataRows.length > IMPORT_MAX_ROWS) throw badRequest(`A file can hold at most ${IMPORT_MAX_ROWS} leads. Split it into smaller files.`);

    const receivers = access.usersWith('leads.receive');
    const byEmail = new Map(receivers.map((u) => [u.email.toLowerCase(), u]));
    const defaultOwner = defaultAssigneeId != null ? receivers.find((u) => u.id === defaultAssigneeId) : null;
    if (defaultAssigneeId != null && !defaultOwner) throw badRequest('The default assignee cannot receive leads.');

    const seenMobiles = new Map();
    const seenEmails = new Map();
    const results = dataRows.map((cells, i) => {
      const line = i + 2; // spreadsheet row number (header is row 1)
      const get = (key) => (col[key] === undefined ? '' : String(cells[col[key]] ?? '').trim());
      const errors = [];

      let source = defaultSource;
      if (get('source')) {
        source = SOURCE_ALIASES[get('source').toLowerCase()];
        if (!source) errors.push(`Unknown source "${get('source')}"`);
      }
      let owner = defaultOwner;
      if (get('assignee')) {
        owner = byEmail.get(get('assignee').toLowerCase()) || null;
        if (!owner) errors.push(`"${get('assignee')}" is not an active login that can receive leads`);
      }

      const input = {
        fullName: get('fullName'), email: get('email'), countryCode: get('countryCode') || '91',
        mobile: get('mobile'), source: source || defaultSource, note: get('note'),
      };
      let parsed = null;
      const check = schemas.leadImportRow.safeParse(input);
      if (check.success) parsed = check.data;
      else for (const issue of check.error.issues) errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);

      const mobile = parsed ? toE164(parsed.countryCode, parsed.mobile) : null;
      if (parsed && !mobile) errors.push('mobile: Enter a valid mobile number.');

      let duplicateOf = null;
      if (!errors.length) {
        duplicateOf = q.existingByMobile.get(mobile)
          || (parsed.email && q.existingByEmail.get(parsed.email))
          || (seenMobiles.has(mobile) && `row ${seenMobiles.get(mobile)} of this file`)
          || (parsed.email && seenEmails.has(parsed.email) && `row ${seenEmails.get(parsed.email)} of this file`)
          || null;
        if (!seenMobiles.has(mobile)) seenMobiles.set(mobile, line);
        if (parsed.email && !seenEmails.has(parsed.email)) seenEmails.set(parsed.email, line);
      }

      return {
        line,
        status: errors.length ? 'error' : duplicateOf ? 'duplicate' : 'ready',
        errors,
        duplicateOf,
        lead: parsed && mobile ? { ...parsed, mobile, owner } : null,
        display: { fullName: input.fullName, mobile: mobile || input.mobile, email: input.email, source, owner: owner?.fullName || null },
      };
    });

    const toCreate = results.filter((r) => r.status === 'ready' || (r.status === 'duplicate' && !skipDuplicates));
    const summary = {
      total: results.length,
      ready: results.filter((r) => r.status === 'ready').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      errors: results.filter((r) => r.status === 'error').length,
      willCreate: toCreate.length,
    };
    const rows = results.map(({ line, status, errors, duplicateOf, display }) => ({ line, status, errors, duplicateOf, ...display }));
    if (dryRun) return { dryRun: true, summary, rows };

    if (!toCreate.length) throw badRequest('There are no rows to import. Fix the errors in the file and upload it again.');
    const now = Date.now();
    const perOwner = new Map();
    db.transaction(() => {
      for (const r of toCreate) {
        const l = r.lead;
        const id = Number(q.insertLead.run({
          tmpCode: `tmp-${now}-${r.line}`, fullName: l.fullName, email: l.email, mobile: l.mobile, source: l.source,
          createdBy: actor.id, assignedTo: l.owner?.id ?? null, assignedAt: l.owner ? now : null, now,
        }).lastInsertRowid);
        q.setLeadCode.run(`LD${String(id).padStart(6, '0')}`, id);
        if (l.note) q.insertNote.run(id, actor.id, l.note, now);
        audit({ actorId: actor.id, action: 'lead.created', entityType: 'lead', entityId: id, details: { source: l.source, imported: true }, ip });
        if (l.owner) {
          audit({ actorId: actor.id, action: 'lead.assigned', entityType: 'lead', entityId: id, details: { from: null, to: l.owner.fullName }, ip });
          if (l.owner.id !== actor.id) perOwner.set(l.owner.id, (perOwner.get(l.owner.id) || 0) + 1);
        }
      }
      audit({ actorId: actor.id, action: 'leads.imported', details: { created: toCreate.length, duplicatesSkipped: skipDuplicates ? summary.duplicates : 0, rowsWithErrors: summary.errors }, ip });
    })();

    for (const [ownerId, n] of perOwner) {
      notifications.notify([ownerId], {
        type: 'lead.assigned', title: `${n} lead${n === 1 ? '' : 's'} assigned to you`,
        body: `${actor.fullName} uploaded ${n} lead${n === 1 ? '' : 's'} and assigned ${n === 1 ? 'it' : 'them'} to you.`, link: '/app/leads?owner=me',
      });
    }
    events.publish('walkin', { imported: toCreate.length }, { permission: 'leads.view_all' });
    return { dryRun: false, summary: { ...summary, created: toCreate.length }, rows };
  }

  function assignees() {
    return access.usersWith('leads.receive');
  }

  // ---------------------------------------------------------------- visits

  function updateVisit(id, input, actor, ip) {
    const v = q.visit.get(id);
    if (!v) throw notFound('Visit not found.');

    const status = input.status ?? v.status;
    let counselorId = input.counselorId === undefined ? v.assigned_counselor_id : input.counselorId;

    if (status !== v.status && !TRANSITIONS[v.status].includes(status)) {
      throw badRequest(`A visit that is "${v.status.replace('_', ' ')}" cannot be moved to "${status.replace('_', ' ')}".`);
    }
    if (status === v.status && (v.status === 'completed' || v.status === 'left')) {
      throw badRequest('This visit is already closed.');
    }
    let counselor = null;
    if (counselorId != null) {
      counselor = counselorId === v.assigned_counselor_id && input.counselorId === undefined
        ? { id: counselorId, fullName: null }
        : assignee(counselorId);
    }
    if (status === 'with_counselor' && !counselor) throw badRequest('Assign a counselor before starting the consultation.');
    if (status === 'waiting' && input.status === 'waiting') counselorId = null;

    const now = Date.now();
    db.transaction(() => {
      q.updateVisit.run({
        id,
        status,
        counselorId,
        attendedAt: status === 'with_counselor' && v.status !== 'with_counselor' ? now : v.attended_at,
        closedAt: status === 'completed' || status === 'left' ? now : null,
        now,
      });

      const details = { visitId: id };
      if (status !== v.status) details.status = { from: v.status, to: status };
      if (counselorId !== v.assigned_counselor_id) details.counselor = counselor?.fullName ?? null;
      audit({ actorId: actor.id, action: 'visit.updated', entityType: 'lead', entityId: v.lead_id, details, ip });

      // The counselor handling the visit becomes the lead owner, so the lead appears
      // in their Leads menu - and only then.
      if (counselorId != null && counselorId !== v.assigned_counselor_id) {
        setOwner(q.lead.get(v.lead_id), counselor, actor, ip);
      }
    })();
    events.publish('walkin', { visitId: id, leadId: v.lead_id }, { permission: 'walkins.view' });
  }

  return { walkins, listLeads, getLead, createLead, importLeads, updateLead, addNote, assignLead, setStage, setAgreedAmount, recordPayment, assignees, updateVisit };
}

module.exports = { createLeadService };
