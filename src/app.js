'use strict';

const path = require('node:path');
const express = require('express');
const { AppError } = require('./lib/errors');
const { createAudit } = require('./lib/audit');
const { createEventHub } = require('./lib/events');
const { createMessaging } = require('./providers/messaging');
const { createRegistrationService } = require('./services/registration');
const { createAuthService } = require('./services/auth');
const { createUserService } = require('./services/users');
const { createLeadService } = require('./services/leads');
const { createAuditLogService } = require('./services/auditLog');
const { createAccessService } = require('./services/access');
const { createNotificationService } = require('./services/notifications');
const { createDashboardService } = require('./services/dashboard');
const { securityHeaders, requestGuards, noStore } = require('./middleware/security');
const { loadSession } = require('./middleware/auth');
const { apiRouter } = require('./routes/api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ config, db, logger = console, messaging }) {
  const audit = createAudit(db);
  const events = createEventHub();
  messaging ||= createMessaging(config, logger);

  const access = createAccessService({ db, audit });
  const auth = createAuthService({ db, config, audit, events, access });
  const notifications = createNotificationService({ db, events, access });
  const services = {
    auth,
    access,
    notifications,
    registration: createRegistrationService({ db, config, messaging, audit, events, notifications, logger }),
    users: createUserService({ db, audit, auth, access }),
    leads: createLeadService({ db, audit, events, access, notifications }),
    auditLog: createAuditLogService({ db }),
    dashboard: createDashboardService({ db, access }),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  app.use(securityHeaders(config));

  // ---- API
  app.use('/api/leads/import', requestGuards(config), express.json({ limit: '2.5mb', strict: true }));
  app.use(
    '/api',
    noStore,
    requestGuards(config),
    express.json({ limit: '10kb', strict: true }),
    loadSession(config, auth),
    apiRouter({ config, services, events }),
  );
  app.use('/api', (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));

  // ---- Pages
  const page = (file) => (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
  app.get('/', (req, res) => res.redirect(302, '/login'));
  app.get('/register', page('register.html'));
  app.get('/login', page('login.html'));
  app.get(['/app', '/app/*rest'], page('app.html'));

  app.use(
    '/assets',
    express.static(path.join(PUBLIC_DIR, 'assets'), {
      index: false,
      dotfiles: 'deny',
      fallthrough: false,
      maxAge: config.isProduction ? '1h' : 0,
    }),
  );
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/img/logo-48.png'));

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  // ---- Errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let body = { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' };

    if (err instanceof AppError) {
      status = err.status;
      body = { code: err.code, message: err.message, ...err.extra };
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      body = { code: 'BAD_JSON', message: 'The request body is not valid JSON.' };
    } else if (err.type === 'entity.too.large') {
      status = 413;
      body = { code: 'TOO_LARGE', message: 'The request is too large.' };
    } else if (err.status === 404 && err.expose) {
      status = 404;
      body = { code: 'NOT_FOUND', message: 'Not found.' };
    } else {
      logger.error(`[${req.method} ${req.originalUrl.split('?')[0]}]`, err);
    }

    if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: body });
    res.status(status).type('text/plain').send(status === 404 ? 'Not found' : 'Error');
  });

  return { app, events, services };
}

module.exports = { createApp };
