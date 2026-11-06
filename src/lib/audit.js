'use strict';

function createAudit(db) {
  const insert = db.prepare(`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip, created_at)
                             VALUES (@actorId, @action, @entityType, @entityId, @details, @ip, @createdAt)`);
  return function audit({ actorId = null, action, entityType = null, entityId = null, details = null, ip = null }) {
    insert.run({
      actorId,
      action,
      entityType,
      entityId,
      details: details ? JSON.stringify(details) : null,
      ip,
      createdAt: Date.now(),
    });
  };
}

module.exports = { createAudit };
