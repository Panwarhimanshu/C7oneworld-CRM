'use strict';

const { badRequest, conflict, notFound } = require('../lib/errors');
const { hashPassword } = require('../lib/crypto');
const { temporaryPassword } = require('./auth');

function toPublic(u, overrideCount = 0) {
  return {
    id: u.id,
    fullName: u.full_name,
    email: u.email,
    role: u.role,
    roleName: u.role_name,
    isActive: Boolean(u.is_active),
    mustChangePassword: Boolean(u.must_change_password),
    isLocked: Boolean(u.locked_until && u.locked_until > Date.now()),
    customPermissions: overrideCount,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

const SELECT_USER = 'SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.key = u.role';

function createUserService({ db, audit, auth, access }) {
  const q = {
    list: db.prepare(`${SELECT_USER} ORDER BY u.is_active DESC, u.full_name COLLATE NOCASE`),
    byId: db.prepare(`${SELECT_USER} WHERE u.id = ?`),
    byEmail: db.prepare('SELECT id FROM users WHERE email = ?').pluck(),
    insert: db.prepare(`INSERT INTO users (full_name, email, role, password_hash, must_change_password, created_by, created_at, updated_at)
      VALUES (@fullName, @email, @role, @hash, 1, @createdBy, @now, @now)`),
    update: db.prepare('UPDATE users SET full_name = @fullName, role = @role, is_active = @isActive, updated_at = @now WHERE id = @id'),
    clearOverrides: db.prepare('DELETE FROM user_permissions WHERE user_id = ?'),
    resetPassword: db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0,
      locked_until = NULL, updated_at = ? WHERE id = ?`),
    activeSuperAdmins: db.prepare(`SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND is_active = 1`).pluck(),
  };

  function list() {
    const counts = access.overrideCounts();
    return q.list.all().map((u) => toPublic(u, counts.get(u.id) || 0));
  }

  async function create(input, actor, ip) {
    if (!access.roleExists(input.role)) throw badRequest('Select a valid role.');
    if (q.byEmail.get(input.email)) throw conflict('A login with this email address already exists.', 'EMAIL_TAKEN');
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    const id = Number(q.insert.run({ ...input, hash, createdBy: actor.id, now: Date.now() }).lastInsertRowid);
    audit({ actorId: actor.id, action: 'user.created', entityType: 'user', entityId: id, details: { role: input.role }, ip });
    return { user: toPublic(q.byId.get(id)), temporaryPassword: password };
  }

  function update(id, input, actor, ip) {
    const user = q.byId.get(id);
    if (!user) throw notFound('Login not found.');

    const next = {
      fullName: input.fullName ?? user.full_name,
      role: input.role ?? user.role,
      isActive: input.isActive === undefined ? user.is_active : input.isActive ? 1 : 0,
    };
    if (!access.roleExists(next.role)) throw badRequest('Select a valid role.');

    if (id === actor.id && (next.role !== user.role || !next.isActive)) {
      throw badRequest('You cannot change your own role or deactivate your own login.');
    }
    const losesSuperAdmin = user.role === 'super_admin' && user.is_active && (next.role !== 'super_admin' || !next.isActive);
    if (losesSuperAdmin && q.activeSuperAdmins.get() <= 1) {
      throw badRequest('At least one active Super Admin is required.');
    }

    db.transaction(() => {
      q.update.run({ ...next, id, now: Date.now() });
      // Per-login adjustments belong to the old role; start clean in the new one.
      if (next.role !== user.role) q.clearOverrides.run(id);
    })();

    const changes = {};
    if (next.fullName !== user.full_name) changes.fullName = { from: user.full_name, to: next.fullName };
    if (next.role !== user.role) changes.role = { from: user.role, to: next.role };
    if (next.isActive !== user.is_active) changes.isActive = { from: Boolean(user.is_active), to: Boolean(next.isActive) };
    if (Object.keys(changes).length) {
      audit({ actorId: actor.id, action: 'user.updated', entityType: 'user', entityId: id, details: changes, ip });
    }
    if (changes.role || changes.isActive) auth.revokeAllSessions(id);
    return toPublic(q.byId.get(id));
  }

  async function resetPassword(id, actor, ip) {
    const user = q.byId.get(id);
    if (!user) throw notFound('Login not found.');
    if (id === actor.id) throw badRequest('Use My Account to change your own password.');
    const password = temporaryPassword();
    q.resetPassword.run(await hashPassword(password), Date.now(), id);
    auth.revokeAllSessions(id);
    audit({ actorId: actor.id, action: 'user.password_reset', entityType: 'user', entityId: id, ip });
    return { temporaryPassword: password };
  }

  return { list, create, update, resetPassword };
}

module.exports = { createUserService };
