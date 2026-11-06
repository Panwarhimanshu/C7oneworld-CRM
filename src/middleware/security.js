'use strict';

const helmet = require('helmet');
const { AppError } = require('../lib/errors');

function securityHeaders(config) {
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          manifestSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    }),
    (req, res, next) => {
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
      next();
    },
  ];
}

// Rejects cross-site state-changing requests and anything that is not JSON.
function requestGuards(config) {
  const allowedOrigin = new URL(config.publicBaseUrl).origin;
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    const sameHost = origin && origin === `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== allowedOrigin && !sameHost) {
      return next(new AppError(403, 'BAD_ORIGIN', 'Request blocked: cross-site requests are not allowed.'));
    }
    if (site && site !== 'same-origin' && site !== 'none') {
      return next(new AppError(403, 'BAD_ORIGIN', 'Request blocked: cross-site requests are not allowed.'));
    }
    if (req.get('content-length') !== '0' && req.headers['content-type'] && !req.is('application/json')) {
      return next(new AppError(415, 'UNSUPPORTED_MEDIA', 'Requests must be sent as JSON.'));
    }
    next();
  };
}

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

module.exports = { securityHeaders, requestGuards, noStore };
