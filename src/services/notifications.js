'use strict';

const { notFound } = require('../lib/errors');

const LIST_LIMIT = 30;

function createNotificationService({ db, events, access }) {
  const q = {
    insert: db.prepare(`INSERT INTO notifications (user_id, type, title, body, link, created_at)
      VALUES (@userId, @type, @title, @body, @link, @now)`),
    list: db.prepare(`SELECT id, type, title, body, link, created_at, read_at FROM notifications
      WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`),
    unread: db.prepare('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL').pluck(),
    markRead: db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL'),
    exists: db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?').pluck(),
    markAll: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
    activeUsers: db.prepare('SELECT id, role FROM users WHERE is_active = 1'),
  };

  function notify(userIds, { type, title, body = null, link = null }) {
    const now = Date.now();
    for (const userId of new Set(userIds)) {
      const id = Number(q.insert.run({ userId, type, title, body, link, now }).lastInsertRowid);
      events.publish('notification', { id, type, title, body, link, createdAt: now }, { userId });
    }
  }

  // Everyone currently holding a permission (Super Admins included), except the actor.
  function notifyHolders(permission, payload, { exceptUserId } = {}) {
    const ids = q.activeUsers.all()
      .filter((u) => u.id !== exceptUserId && access.effective(u.id, u.role).has(permission))
      .map((u) => u.id);
    notify(ids, payload);
  }

  function list(userId) {
    return {
      unread: q.unread.get(userId),
      items: q.list.all(userId).map((n) => ({
        id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, read: Boolean(n.read_at),
      })),
    };
  }

  function markRead(userId, id) {
    if (!q.exists.get(id, userId)) throw notFound('Notification not found.');
    q.markRead.run(Date.now(), id, userId);
  }

  function markAllRead(userId) {
    q.markAll.run(Date.now(), userId);
  }

  return { notify, notifyHolders, list, markRead, markAllRead };
}

module.exports = { createNotificationService };
