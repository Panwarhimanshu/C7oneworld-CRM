'use strict';

const { AppError, unauthorized, forbidden } = require('../lib/errors');
const { safeEqualString } = require('../lib/crypto');

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: config.session.absoluteMs,
  };
}

function loadSession(config, auth) {
  return (req, res, next) => {
    const token = readCookie(req, config.session.cookieName);
    req.session = token ? auth.resolve(token) : null;
    req.user = req.session?.user ?? null;
    if (token && !req.session) res.clearCookie(config.session.cookieName, { path: '/' });
    next();
  };
}

// Paths a user who must change their password can still reach.
const PASSWORD_CHANGE_ALLOWLIST = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password']);

function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(req.originalUrl.split('?')[0])) {
    return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please set a new password before continuing.'));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const sent = req.get('x-csrf-token');
    if (!sent || !safeEqualString(sent, req.session.csrfToken)) {
      return next(new AppError(403, 'CSRF_FAILED', 'Your session could not be verified. Please reload the page.'));
    }
  }
  next();
}

// Passes when the user holds at least one of the given permissions.
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!permissions.some((p) => req.user?.permissions.has(p))) return next(forbidden());
    next();
  };
}

module.exports = { loadSession, requireAuth, requirePermission, sessionCookieOptions, readCookie };
