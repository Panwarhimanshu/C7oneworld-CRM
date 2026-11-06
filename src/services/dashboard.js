'use strict';

const { badRequest } = require('../lib/errors');

const OPEN_STAGES = ['new', 'contacted', 'working', 'qualified'];
const LOST_STAGES = ['unqualified', 'lost_interest', 'lost_to_competitor'];
const MAX_RANGE_MS = 366 * 86_400_000;

// Lead metrics for the dashboard. Scope follows lead transparency:
//   assigned-only logins -> leads assigned to them (counted by assignment date)
//   "View all leads"     -> every lead (by creation date), or one owner / unassigned
function createDashboardService({ db, access }) {
  // "Awaiting counselor": no owner, or held by a login that is not a counselor (front desk).
  const AWAITING = `(l.assigned_to IS NULL OR l.assigned_to NOT IN (SELECT value FROM json_each(@counselors)))`;
  const counselorsJson = () => JSON.stringify(access.usersWith('leads.receive').map((u) => u.id));

  function scopeFor(actor, owner) {
    if (!actor.permissions.has('leads.view_all')) return { where: 'l.assigned_to = @ownerId', ownerId: actor.id, basis: 'assigned', label: 'assigned to you' };
    if (owner === 'unassigned') return { where: AWAITING, ownerId: null, basis: 'created', label: 'unassigned' };
    if (owner === 'me') return { where: 'l.assigned_to = @ownerId', ownerId: actor.id, basis: 'assigned', label: 'assigned to you' };
    if (/^\d+$/.test(owner)) return { where: 'l.assigned_to = @ownerId', ownerId: Number(owner), basis: 'assigned', label: 'owner' };
    return { where: '1 = 1', ownerId: null, basis: 'created', label: 'all' };
  }

  // Money figures, in paise. Scope is the same lead filter as the lead metrics.
  function finance(scopeWhere, params, { from, to, lmFrom, lmTo }) {
    const paidByLead = '(SELECT lead_id, SUM(amount) AS paid FROM payments GROUP BY lead_id)';
    const collected = db.prepare(`SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN leads l ON l.id = p.lead_id
      WHERE ${scopeWhere} AND p.paid_on >= @from AND p.paid_on < @to`).pluck();
    const window = (f, t) => ({ ...params, from: f, to: t });
    const agreedInPeriod = db.prepare(`SELECT COALESCE(SUM(l.agreed_amount), 0) FROM leads l
      WHERE ${scopeWhere} AND l.agreed_set_at >= @from AND l.agreed_set_at < @to`).pluck().get(window(from, to));
    const totals = db.prepare(`SELECT COALESCE(SUM(l.agreed_amount), 0) AS agreed, COALESCE(SUM(pb.paid), 0) AS paid,
        COALESCE(SUM(MAX(l.agreed_amount - COALESCE(pb.paid, 0), 0)), 0) AS outstanding,
        COUNT(*) AS deals
      FROM leads l LEFT JOIN ${paidByLead} pb ON pb.lead_id = l.id
      WHERE ${scopeWhere} AND l.agreed_amount IS NOT NULL`).get(params);
    return {
      collected: collected.get(window(from, to)),
      collectedPrevious: collected.get(window(from - (to - from), from)),
      collectedLastMonth: lmFrom != null && lmTo > lmFrom ? collected.get(window(lmFrom, lmTo)) : null,
      agreedInPeriod,
      outstanding: totals.outstanding,
      totalAgreed: totals.agreed,
      totalCollectedOnDeals: totals.paid,
      openDeals: totals.deals,
    };
  }

  // Office revenue breakdowns (Super Admin): per counselor and per lead source.
  function breakdown(groupCol, leadsTimeCol, params) {
    const paidByLead = '(SELECT lead_id, SUM(amount) AS paid FROM payments GROUP BY lead_id)';
    return db.prepare(`
      WITH la AS (SELECT ${groupCol} AS k, COUNT(*) AS leads, SUM(stage = 'converted') AS converted
                  FROM leads l WHERE ${leadsTimeCol} >= @from AND ${leadsTimeCol} < @to GROUP BY k),
           ag AS (SELECT ${groupCol} AS k, SUM(agreed_amount) AS agreed
                  FROM leads l WHERE agreed_set_at >= @from AND agreed_set_at < @to GROUP BY k),
           co AS (SELECT ${groupCol} AS k, SUM(p.amount) AS collected
                  FROM payments p JOIN leads l ON l.id = p.lead_id WHERE p.paid_on >= @from AND p.paid_on < @to GROUP BY k),
           os AS (SELECT ${groupCol} AS k, SUM(MAX(l.agreed_amount - COALESCE(pb.paid, 0), 0)) AS outstanding
                  FROM leads l LEFT JOIN ${paidByLead} pb ON pb.lead_id = l.id WHERE l.agreed_amount IS NOT NULL GROUP BY k),
           keys AS (SELECT k FROM la UNION SELECT k FROM ag UNION SELECT k FROM co UNION SELECT k FROM os)
      SELECT keys.k AS k, COALESCE(la.leads, 0) AS leads, COALESCE(la.converted, 0) AS converted,
             COALESCE(ag.agreed, 0) AS agreed, COALESCE(co.collected, 0) AS collected, COALESCE(os.outstanding, 0) AS outstanding
      FROM keys LEFT JOIN la ON la.k IS keys.k LEFT JOIN ag ON ag.k IS keys.k
                LEFT JOIN co ON co.k IS keys.k LEFT JOIN os ON os.k IS keys.k
      ORDER BY collected DESC, leads DESC`).all(params);
  }

  function summary({ from, to, owner, tz, lmFrom, lmTo }, actor) {
    if (to <= from || to - from > MAX_RANGE_MS) throw badRequest('Choose a period of up to one year.');
    const scope = scopeFor(actor, owner);
    const timeCol = scope.basis === 'assigned' ? 'l.assigned_at' : 'l.created_at';
    const base = `FROM leads l WHERE ${scope.where} AND ${timeCol} >= @from AND ${timeCol} < @to`;
    const counselors = counselorsJson();
    const params = { from, to, ownerId: scope.ownerId, counselors };
    const prevParams = { from: from - (to - from), to: from, ownerId: scope.ownerId, counselors };

    const count = db.prepare(`SELECT COUNT(*) ${base}`).pluck();
    const total = count.get(params);
    const previous = count.get(prevParams);

    const byStage = Object.fromEntries(db.prepare(`SELECT l.stage, COUNT(*) AS n ${base} GROUP BY l.stage`).all(params).map((r) => [r.stage, r.n]));
    const sum = (keys) => keys.reduce((a, k) => a + (byStage[k] || 0), 0);

    const bySource = db.prepare(`SELECT l.source, COUNT(*) AS n ${base} GROUP BY l.source ORDER BY n DESC`).all(params)
      .map((r) => ({ source: r.source, count: r.n }));

    // Day buckets in the viewer's local time (tz = minutes east of UTC).
    const offsetMs = tz * 60_000;
    const daily = db.prepare(`SELECT date((${timeCol} + @offsetMs) / 1000, 'unixepoch') AS day, COUNT(*) AS n ${base} GROUP BY day ORDER BY day`)
      .all({ ...params, offsetMs }).map((r) => ({ day: r.day, count: r.n }));

    const result = {
      scope: { basis: scope.basis, label: scope.label },
      period: { from, to },
      leads: { total, previous },
      outcomes: { converted: byStage.converted || 0, open: sum(OPEN_STAGES), lost: sum(LOST_STAGES) },
      byStage,
      bySource,
      daily,
    };

    // Office-wide extras.
    if (actor.permissions.has('leads.view_all') && scope.label === 'all') {
      result.byOwner = db.prepare(`SELECT u.id, u.full_name, COUNT(l.id) AS leads,
          SUM(CASE WHEN l.stage = 'converted' THEN 1 ELSE 0 END) AS converted,
          SUM(CASE WHEN l.stage IN ('new','contacted','working','qualified') THEN 1 ELSE 0 END) AS open
        FROM leads l JOIN users u ON u.id = l.assigned_to
        WHERE l.created_at >= @from AND l.created_at < @to
        GROUP BY u.id ORDER BY leads DESC, u.full_name LIMIT 50`).all(params)
        .map((r) => ({ id: r.id, fullName: r.full_name, leads: r.leads, converted: r.converted, open: r.open }));
      result.unassigned = db.prepare(`SELECT COUNT(*) FROM leads l WHERE ${AWAITING} AND l.created_at >= @from AND l.created_at < @to`).pluck().get(params);
    }
    // Money: a counselor sees their own; the office-wide view needs "Office revenue dashboard".
    const ownFigures = !actor.permissions.has('leads.view_all') || scope.ownerId === actor.id;
    if (ownFigures || actor.permissions.has('reports.revenue')) {
      result.finance = finance(scope.where, params, { from, to, lmFrom, lmTo });
    }
    if (actor.permissions.has('reports.revenue') && scope.label === 'all') {
      const names = new Map(db.prepare('SELECT id, full_name FROM users').all().map((u) => [u.id, u.full_name]));
      result.byCounselor = breakdown('l.assigned_to', 'l.assigned_at', params).map((r) => ({
        id: r.k, fullName: r.k == null ? 'Unassigned' : names.get(r.k) || 'Unknown',
        leads: r.leads, converted: r.converted, agreed: r.agreed, collected: r.collected, outstanding: r.outstanding,
      }));
      result.bySourceRevenue = breakdown('l.source', 'l.created_at', params).map((r) => ({
        source: r.k, leads: r.leads, converted: r.converted, agreed: r.agreed, collected: r.collected, outstanding: r.outstanding,
      }));
    }

    if (actor.permissions.has('walkins.view') && scope.label === 'all') {
      const visits = db.prepare('SELECT COUNT(*) FROM visits WHERE checked_in_at >= @from AND checked_in_at < @to').pluck();
      result.walkins = { total: visits.get(params), previous: visits.get(prevParams) };
    }
    return result;
  }

  return { summary };
}

module.exports = { createDashboardService };
