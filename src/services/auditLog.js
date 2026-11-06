'use strict';

const PAGE_SIZE = 50;

function createAuditLogService({ db }) {
  const q = {
    page: db.prepare(`SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.created_at,
        u.full_name AS actor_name, l.lead_code, tu.full_name AS target_user
      FROM audit_log a
      LEFT JOIN users u  ON u.id = a.actor_id
      LEFT JOIN leads l  ON a.entity_type = 'lead' AND l.id = a.entity_id
      LEFT JOIN users tu ON a.entity_type = 'user' AND tu.id = a.entity_id
      WHERE (@action = '' OR a.action LIKE @action || '%')
      ORDER BY a.id DESC LIMIT @limit OFFSET @offset`),
    count: db.prepare(`SELECT COUNT(*) FROM audit_log WHERE (@action = '' OR action LIKE @action || '%')`).pluck(),
  };

  function list({ page, action }) {
    const total = q.count.get({ action });
    const items = q.page.all({ action, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }).map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entity_type,
      entityId: a.entity_id,
      entityLabel: a.lead_code || a.target_user || null,
      details: a.details ? JSON.parse(a.details) : null,
      ip: a.ip,
      createdAt: a.created_at,
      actorName: a.actor_name,
    }));
    return { items, page, pageSize: PAGE_SIZE, total };
  }

  return { list };
}

module.exports = { createAuditLogService };
