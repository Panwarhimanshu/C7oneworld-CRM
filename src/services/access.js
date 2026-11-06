'use strict';

const { AppError, badRequest, conflict, notFound } = require('../lib/errors');
const { PERMISSIONS, BY_KEY, LOCKED_ROLE_PERMISSIONS, isKnown, dependencyProblem } = require('../permissions');

function createAccessService({ db, audit }) {
  const q = {
    role: db.prepare('SELECT * FROM roles WHERE key = ?'),
    roles: db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = r.key) AS user_count
      FROM roles r ORDER BY r.is_locked DESC, r.is_system DESC, r.name COLLATE NOCASE`),
    roleByName: db.prepare('SELECT key FROM roles WHERE name = ?').pluck(),
    rolePerms: db.prepare('SELECT permission FROM role_permissions WHERE role_key = ?').pluck(),
    insertRole: db.prepare(`INSERT INTO roles (key, name, description, is_system, is_locked, created_at, updated_at)
      VALUES (@key, @name, @description, 0, 0, @now, @now)`),
    updateRole: db.prepare('UPDATE roles SET name = @name, description = @description, updated_at = @now WHERE key = @key'),
    deleteRole: db.prepare('DELETE FROM roles WHERE key = ?'),
    clearRolePerms: db.prepare('DELETE FROM role_permissions WHERE role_key = ?'),
    addRolePerm: db.prepare('INSERT INTO role_permissions (role_key, permission) VALUES (?, ?)'),
    roleUsers: db.prepare('SELECT COUNT(*) FROM users WHERE role = ?').pluck(),
    overrides: db.prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?'),
    clearOverrides: db.prepare('DELETE FROM user_permissions WHERE user_id = ?'),
    addOverride: db.prepare('INSERT INTO user_permissions (user_id, permission, granted) VALUES (?, ?, ?)'),
    user: db.prepare('SELECT u.id, u.full_name, u.role, r.is_locked FROM users u JOIN roles r ON r.key = u.role WHERE u.id = ?'),
    overrideCounts: db.prepare('SELECT user_id, COUNT(*) AS n FROM user_permissions GROUP BY user_id'),
  };

  function rolePermissions(roleKey) {
    const role = q.role.get(roleKey);
    if (!role) return new Set();
    return new Set(role.is_locked ? LOCKED_ROLE_PERMISSIONS : q.rolePerms.all(roleKey).filter(isKnown));
  }

  // Effective permissions = role permissions, adjusted by this login's overrides.
  function effective(userId, roleKey) {
    const role = q.role.get(roleKey);
    if (!role) return new Set();
    if (role.is_locked) return new Set(LOCKED_ROLE_PERMISSIONS);
    const set = rolePermissions(roleKey);
    for (const o of q.overrides.all(userId)) {
      if (!isKnown(o.permission) || BY_KEY.get(o.permission).restricted) continue;
      if (o.granted) set.add(o.permission);
      else set.delete(o.permission);
    }
    return set;
  }

  function catalog() {
    return PERMISSIONS.map(({ key, group, label, description, menu, requires, requiresAny, restricted }) => ({
      key, group, label, description, menu: menu || null, requires: requires || [], requiresAny: requiresAny || [], restricted: Boolean(restricted),
    }));
  }

  function listRoles() {
    return q.roles.all().map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: Boolean(r.is_system),
      isLocked: Boolean(r.is_locked),
      userCount: r.user_count,
      permissions: [...rolePermissions(r.key)],
    }));
  }

  function validateSet(set, { allowRestricted = false } = {}) {
    for (const key of set) {
      if (!isKnown(key)) throw badRequest(`Unknown permission “${key}”.`);
      if (!allowRestricted && BY_KEY.get(key).restricted) throw badRequest(`“${BY_KEY.get(key).label}” is reserved for Super Admin.`);
    }
    const problem = dependencyProblem(set);
    if (problem) throw new AppError(422, 'PERMISSION_DEPENDENCY', problem);
  }

  function slugFor(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'role';
    let key = base;
    for (let i = 2; q.role.get(key); i++) key = `${base}_${i}`;
    return key;
  }

  function createRole({ name, description, copyFrom }, actor, ip) {
    if (q.roleByName.get(name)) throw conflict('A role with this name already exists.', 'ROLE_EXISTS');
    const key = slugFor(name);
    let perms = [];
    if (copyFrom) {
      const src = q.role.get(copyFrom);
      if (!src) throw badRequest('The role to copy from does not exist.');
      perms = [...rolePermissions(copyFrom)].filter((p) => !BY_KEY.get(p).restricted);
    }
    db.transaction(() => {
      q.insertRole.run({ key, name, description: description || '', now: Date.now() });
      for (const p of perms) q.addRolePerm.run(key, p);
    })();
    audit({ actorId: actor.id, action: 'role.created', entityType: 'role', details: { role: name, copiedFrom: copyFrom || null }, ip });
    return listRoles().find((r) => r.key === key);
  }

  function editableRole(key) {
    const role = q.role.get(key);
    if (!role) throw notFound('Role not found.');
    if (role.is_locked) throw badRequest('Super Admin always has full access and cannot be changed.');
    return role;
  }

  function updateRole(key, { name, description }, actor, ip) {
    const role = editableRole(key);
    const nextName = name ?? role.name;
    const existing = q.roleByName.get(nextName);
    if (existing && existing !== key) throw conflict('A role with this name already exists.', 'ROLE_EXISTS');
    q.updateRole.run({ key, name: nextName, description: description ?? role.description, now: Date.now() });
    audit({ actorId: actor.id, action: 'role.updated', entityType: 'role', details: { role: nextName }, ip });
  }

  function setRolePermissions(key, permissions, actor, ip) {
    const role = editableRole(key);
    const next = new Set(permissions);
    validateSet(next);
    const before = rolePermissions(key);
    db.transaction(() => {
      q.clearRolePerms.run(key);
      for (const p of next) q.addRolePerm.run(key, p);
    })();
    const added = [...next].filter((p) => !before.has(p));
    const removed = [...before].filter((p) => !next.has(p));
    if (added.length || removed.length) {
      audit({ actorId: actor.id, action: 'role.permissions_changed', entityType: 'role', details: { role: role.name, added, removed }, ip });
    }
  }

  function deleteRole(key, actor, ip) {
    const role = q.role.get(key);
    if (!role) throw notFound('Role not found.');
    if (role.is_system) throw badRequest('Built-in roles cannot be deleted.');
    if (q.roleUsers.get(key) > 0) throw conflict('Move the logins in this role to another role before deleting it.', 'ROLE_IN_USE');
    q.deleteRole.run(key);
    audit({ actorId: actor.id, action: 'role.deleted', entityType: 'role', details: { role: role.name }, ip });
  }

  function userAccess(userId) {
    const u = q.user.get(userId);
    if (!u) throw notFound('Login not found.');
    const overrides = {};
    for (const o of q.overrides.all(userId)) overrides[o.permission] = Boolean(o.granted);
    return {
      roleKey: u.role,
      isLocked: Boolean(u.is_locked),
      rolePermissions: [...rolePermissions(u.role)],
      overrides,
      effective: [...effective(userId, u.role)],
    };
  }

  function setUserOverrides(userId, overrides, actor, ip) {
    const u = q.user.get(userId);
    if (!u) throw notFound('Login not found.');
    if (u.is_locked) throw badRequest('Super Admin logins always have full access.');
    const base = rolePermissions(u.role);
    const rows = [];
    const result = new Set(base);
    for (const [perm, granted] of Object.entries(overrides)) {
      if (!isKnown(perm)) throw badRequest(`Unknown permission “${perm}”.`);
      if (BY_KEY.get(perm).restricted) throw badRequest(`“${BY_KEY.get(perm).label}” is reserved for Super Admin.`);
      if (granted === base.has(perm)) continue; // same as role default: no override needed
      rows.push([perm, granted ? 1 : 0]);
      if (granted) result.add(perm);
      else result.delete(perm);
    }
    validateSet(result);
    db.transaction(() => {
      q.clearOverrides.run(userId);
      for (const [perm, granted] of rows) q.addOverride.run(userId, perm, granted);
    })();
    audit({
      actorId: actor.id, action: 'user.permissions_changed', entityType: 'user', entityId: userId,
      details: { granted: rows.filter((r) => r[1]).map((r) => r[0]), removed: rows.filter((r) => !r[1]).map((r) => r[0]) }, ip,
    });
  }

  function overrideCounts() {
    return new Map(q.overrideCounts.all().map((r) => [r.user_id, r.n]));
  }

  // Logins currently holding a permission (used for "assign to" lists).
  const holders = db.prepare(`SELECT u.id, u.full_name, u.email, r.name AS role_name FROM users u JOIN roles r ON r.key = u.role
    WHERE u.is_active = 1 AND r.is_locked = 0 AND (
      (EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_key = u.role AND rp.permission = @p)
        AND NOT EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission = @p AND up.granted = 0))
      OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission = @p AND up.granted = 1))
    ORDER BY r.name COLLATE NOCASE, u.full_name COLLATE NOCASE`);

  function usersWith(permission) {
    return holders.all({ p: permission }).map((u) => ({ id: u.id, fullName: u.full_name, email: u.email, roleName: u.role_name }));
  }

  function roleExists(key) {
    return Boolean(q.role.get(key));
  }

  return {
    effective, catalog, listRoles, createRole, updateRole, setRolePermissions, deleteRole,
    userAccess, setUserOverrides, overrideCounts, usersWith, roleExists,
  };
}

module.exports = { createAccessService };
