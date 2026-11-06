'use strict';

const { AppError, unauthorized } = require('../lib/errors');
const { hashPassword, verifyPassword, burnPasswordCheck, randomToken, sha256 } = require('../lib/crypto');

const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', 'qwertyuiopas', 'iloveyou1234',
  'administrator', 'welcome12345', 'letmein12345', 'changeme1234', 'passwordpassword', 'qwerty123456',
]);

function passwordProblem(password, { email, fullName }) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 128) return 'Password must be at most 128 characters.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'This password is too common. Choose something less predictable.';
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character.';
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Password must not contain your email address.';
  const first = String(fullName || '').split(' ')[0].toLowerCase();
  if (first.length >= 4 && lower.includes(first)) return 'Password must not contain your name.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 3) {
    return 'Use at least three of: lowercase, uppercase, numbers, symbols - or use 16+ characters.';
  }
  return null;
}

// Readable one-time password for new or reset accounts (no look-alike characters).
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = require('node:crypto').randomBytes(15);
  let out = '';
  for (let i = 0; i < 15; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 4 || i === 9) out += '-';
  }
  return out;
}

function createAuthService({ db, config, audit, events, access }) {
  const { idleMs, absoluteMs } = config.session;

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    recordFailure: db.prepare(`UPDATE users SET failed_attempts = failed_attempts + 1,
      locked_until = CASE WHEN failed_attempts + 1 >= @max THEN @lockUntil ELSE locked_until END
      WHERE id = @id`),
    recordSuccess: db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'),
    insertSession: db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    sessionWithUser: db.prepare(`SELECT s.token_hash, s.csrf_token, s.last_seen_at, s.expires_at,
        u.id, u.full_name, u.email, u.role, u.is_active, u.must_change_password, r.name AS role_name
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.key = u.role WHERE s.token_hash = ?`),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    sessionExists: db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1').pluck(),
    setPassword: db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?,
      failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`),
  };

  function createSession(userId, ip, userAgent) {
    const token = randomToken(32);
    const now = Date.now();
    q.insertSession.run(sha256(token), userId, randomToken(32), ip, String(userAgent || '').slice(0, 300), now, now, now + absoluteMs);
    return token;
  }

  async function login({ email, password }, ip, userAgent) {
    const user = q.userByEmail.get(email);
    const generic = new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');

    if (!user) {
      await burnPasswordCheck(password);
      audit({ action: 'auth.login_failed', details: { reason: 'unknown_account' }, ip });
      throw generic;
    }

    const now = Date.now();
    if (user.locked_until && user.locked_until > now) {
      await burnPasswordCheck(password);
      audit({ actorId: user.id, action: 'auth.login_blocked', entityType: 'user', entityId: user.id, ip });
      const minutes = Math.ceil((user.locked_until - now) / 60_000);
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} or contact your administrator.`);
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok || !user.is_active) {
      if (!ok) {
        q.recordFailure.run({ id: user.id, max: config.auth.maxFailedAttempts, lockUntil: now + config.auth.lockoutMinutes * 60_000 });
      }
      audit({ actorId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, details: { reason: ok ? 'inactive' : 'bad_password' }, ip });
      throw generic;
    }

    q.recordSuccess.run(now, user.id);
    const token = createSession(user.id, ip, userAgent);
    audit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip });
    return token;
  }

  // Resolves a raw cookie token into the session + user, enforcing idle and absolute expiry.
  function resolve(token) {
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const row = q.sessionWithUser.get(hash);
    if (!row) return null;
    const now = Date.now();
    if (now > row.expires_at || now - row.last_seen_at > idleMs || !row.is_active) {
      q.deleteSession.run(hash);
      return null;
    }
    if (now - row.last_seen_at > 60_000) q.touchSession.run(now, hash);
    return {
      tokenHash: hash,
      csrfToken: row.csrf_token,
      user: {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        role: row.role,
        roleName: row.role_name,
        mustChangePassword: Boolean(row.must_change_password),
        // Resolved on every request so role and permission changes apply immediately.
        permissions: access.effective(row.id, row.role),
      },
    };
  }

  function isSessionAlive(tokenHash) {
    return Boolean(q.sessionExists.get(tokenHash, Date.now()));
  }

  function logout(tokenHash, userId, ip) {
    q.deleteSession.run(tokenHash);
    audit({ actorId: userId, action: 'auth.logout', entityType: 'user', entityId: userId, ip });
  }

  async function changePassword(session, { currentPassword, newPassword }, ip) {
    const user = q.userById.get(session.user.id);
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Please correct the highlighted fields.', { fields: { currentPassword: 'Current password is incorrect.' } });
    }
    const problem = passwordProblem(newPassword, { email: user.email, fullName: user.full_name });
    if (problem) throw new AppError(422, 'VALIDATION_FAILED', 'Please correct the highlighted fields.', { fields: { newPassword: problem } });
    if (await verifyPassword(newPassword, user.password_hash)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Please correct the highlighted fields.', { fields: { newPassword: 'New password must be different from the current one.' } });
    }
    const hash = await hashPassword(newPassword);
    const now = Date.now();
    db.transaction(() => {
      q.setPassword.run(hash, 0, now, now, user.id);
      q.deleteOtherSessions.run(user.id, session.tokenHash);
    })();
    audit({ actorId: user.id, action: 'auth.password_changed', entityType: 'user', entityId: user.id, ip });
  }

  const roleOf = db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').pluck();
  function currentPermissions(userId) {
    const role = roleOf.get(userId);
    return role ? access.effective(userId, role) : new Set();
  }

  function revokeAllSessions(userId) {
    q.deleteUserSessions.run(userId);
    events.disconnectUser(userId);
  }

  return { login, resolve, logout, changePassword, revokeAllSessions, isSessionAlive, currentPermissions };
}

module.exports = { createAuthService, passwordProblem, temporaryPassword };
