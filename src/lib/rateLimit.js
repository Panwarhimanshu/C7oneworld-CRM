'use strict';

const { tooMany } = require('./errors');

// Fixed-window in-memory limiter. Adequate for a single-instance deployment; swap the
// store for Redis if the app is ever scaled horizontally.
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Please wait a moment and try again.' }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return function limiter(req, res, next) {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return next(tooMany(message, { retryAfter }));
    }
    next();
  };
}

module.exports = { rateLimit };
