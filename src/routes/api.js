'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { schemas, parse } = require('../lib/validate');
const { rateLimit } = require('../lib/rateLimit');
const { requireAuth, requirePermission, sessionCookieOptions } = require('../middleware/auth');

function apiRouter({ config, services, events }) {
  const { registration, auth, users, leads, auditLog, access, notifications, dashboard } = services;
  const router = express.Router();

  // ---------------------------------------------------------------- Public registration
  const kioskLimiter = rateLimit({ windowMs: 15 * 60_000, max: 60 });
  const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 });

  router.get('/registration/options', (req, res) => {
    res.json(registration.formOptions());
  });

  router.post('/registration', kioskLimiter, async (req, res) => {
    const input = parse(schemas.registrationStart, req.body);
    if (input.company) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unable to process this request.' } });
    res.status(201).json(await registration.start(input, req.ip));
  });

  router.post('/registration/resend', kioskLimiter, async (req, res) => {
    const { requestId } = parse(schemas.registrationRef, req.body);
    res.json(await registration.resend(requestId, req.ip));
  });

  router.post('/registration/verify', verifyLimiter, (req, res) => {
    const { requestId, code } = parse(schemas.registrationVerify, req.body);
    res.json(registration.verify(requestId, code, req.ip));
  });

  // ---------------------------------------------------------------- Staff authentication
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 20,
    message: 'Too many sign-in attempts from this network. Please wait 15 minutes.',
  });

  router.post('/auth/login', loginLimiter, async (req, res) => {
    const input = parse(schemas.login, req.body);
    const token = await auth.login(input, req.ip, req.get('user-agent'));
    res.cookie(config.session.cookieName, token, sessionCookieOptions(config));
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    const { permissions, ...user } = req.user;
    res.json({
      user: { ...user, roleLabel: user.roleName },
      permissions: [...permissions],
      csrfToken: req.session.csrfToken,
      app: {
        name: config.appName,
        org: config.orgName,
        idleMinutes: config.session.idleMs / 60_000,
        registerUrl: `${config.publicBaseUrl}/register`,
      },
    });
  });

  router.post('/auth/logout', requireAuth, (req, res) => {
    auth.logout(req.session.tokenHash, req.user.id, req.ip);
    res.clearCookie(config.session.cookieName, { path: '/' });
    res.status(204).end();
  });

  router.post('/auth/change-password', requireAuth, async (req, res) => {
    await auth.changePassword(req.session, parse(schemas.changePassword, req.body), req.ip);
    res.status(204).end();
  });

  // Everything below requires a signed-in staff member.
  router.use(requireAuth);

  // ---------------------------------------------------------------- Live events + notifications
  router.get('/events', (req, res) => {
    const { tokenHash } = req.session;
    const { id: userId } = req.user;
    events.subscribe(req, res, {
      userId,
      // Ends the stream when the session ends; permissions are re-checked per event.
      isAlive: () => auth.isSessionAlive(tokenHash),
      can: (permission) => auth.currentPermissions(userId).has(permission),
    });
  });

  router.get('/notifications', (req, res) => {
    res.json(notifications.list(req.user.id));
  });

  router.post('/notifications/read-all', (req, res) => {
    notifications.markAllRead(req.user.id);
    res.status(204).end();
  });

  router.post('/notifications/:id/read', (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    notifications.markRead(req.user.id, id);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- Walk-ins (front desk)
  router.get('/walkins', requirePermission('walkins.view'), (req, res) => {
    res.json(leads.walkins(parse(schemas.walkinQuery, req.query)));
  });


  router.get('/walkins/qr.svg', requirePermission('walkins.view'), async (req, res) => {
    const svg = await QRCode.toString(`${config.publicBaseUrl}/register`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  });

  router.patch('/visits/:id', requirePermission('walkins.manage'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    leads.updateVisit(id, parse(schemas.visitUpdate, req.body), req.user, req.ip);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- Leads
  const LEADS = ['leads.view_all', 'leads.view_assigned'];

  router.get('/dashboard', requirePermission(...LEADS), (req, res) => {
    res.json(dashboard.summary(parse(schemas.dashboardQuery, req.query), req.user));
  });

  router.get('/assignees', requirePermission('leads.assign', 'walkins.manage'), (req, res) => {
    res.json({ items: leads.assignees() });
  });

  router.get('/leads', requirePermission(...LEADS), (req, res) => {
    res.json(leads.listLeads(parse(schemas.leadsQuery, req.query), req.user));
  });

  router.post('/leads/import', requirePermission('leads.import'), (req, res) => {
    res.json(leads.importLeads(parse(schemas.leadImport, req.body), req.user, req.ip));
  });

  router.post('/leads', requirePermission('leads.create'), (req, res) => {
    res.status(201).json(leads.createLead(parse(schemas.leadCreate, req.body), req.user, req.ip));
  });

  router.get('/leads/:id', requirePermission(...LEADS), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    res.json(leads.getLead(id, req.user, req.ip));
  });

  router.patch('/leads/:id', requirePermission('leads.edit'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    leads.updateLead(id, parse(schemas.leadUpdate, req.body), req.user, req.ip);
    res.status(204).end();
  });

  router.put('/leads/:id/assignment', requirePermission('leads.assign'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    const { assigneeId } = parse(schemas.leadAssign, req.body);
    leads.assignLead(id, assigneeId, req.user, req.ip);
    res.status(204).end();
  });

  router.put('/leads/:id/stage', requirePermission('leads.stage'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    const { stage } = parse(schemas.leadStage, req.body);
    leads.setStage(id, stage, req.user, req.ip);
    res.status(204).end();
  });

  router.put('/leads/:id/agreed-amount', requirePermission('payments.record'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    const { amount } = parse(schemas.agreedAmount, req.body);
    leads.setAgreedAmount(id, amount, req.user, req.ip);
    res.status(204).end();
  });

  router.post('/leads/:id/payments', requirePermission('payments.record'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    res.status(201).json(leads.recordPayment(id, parse(schemas.paymentCreate, req.body), req.user, req.ip));
  });

  router.post('/leads/:id/notes', requirePermission('leads.note'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    const { body } = parse(schemas.noteCreate, req.body);
    leads.addNote(id, body, req.user, req.ip);
    res.status(201).end();
  });

  // ---------------------------------------------------------------- Logins
  router.get('/users', requirePermission('users.manage'), (req, res) => {
    res.json({
      items: users.list(),
      roles: access.listRoles().map(({ key, name, isLocked }) => ({ key, name, isLocked })),
    });
  });

  router.post('/users', requirePermission('users.manage'), async (req, res) => {
    res.status(201).json(await users.create(parse(schemas.userCreate, req.body), req.user, req.ip));
  });

  router.patch('/users/:id', requirePermission('users.manage'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    res.json(users.update(id, parse(schemas.userUpdate, req.body), req.user, req.ip));
  });

  router.post('/users/:id/reset-password', requirePermission('users.manage'), async (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    res.json(await users.resetPassword(id, req.user, req.ip));
  });

  router.get('/users/:id/permissions', requirePermission('users.manage'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    res.json({ ...access.userAccess(id), catalog: access.catalog() });
  });

  router.put('/users/:id/permissions', requirePermission('users.manage'), (req, res) => {
    const { id } = parse(schemas.idParam, req.params);
    const { overrides } = parse(schemas.userPermissions, req.body);
    access.setUserOverrides(id, overrides, req.user, req.ip);
    events.disconnectUser(id);
    res.json(access.userAccess(id));
  });

  // ---------------------------------------------------------------- Roles & permissions
  router.get('/roles', requirePermission('roles.manage'), (req, res) => {
    res.json({ roles: access.listRoles(), catalog: access.catalog() });
  });

  router.post('/roles', requirePermission('roles.manage'), (req, res) => {
    res.status(201).json(access.createRole(parse(schemas.roleCreate, req.body), req.user, req.ip));
  });

  router.patch('/roles/:key', requirePermission('roles.manage'), (req, res) => {
    const { key } = parse(schemas.roleParam, req.params);
    access.updateRole(key, parse(schemas.roleUpdate, req.body), req.user, req.ip);
    res.status(204).end();
  });

  router.put('/roles/:key/permissions', requirePermission('roles.manage'), (req, res) => {
    const { key } = parse(schemas.roleParam, req.params);
    const { permissions } = parse(schemas.rolePermissions, req.body);
    access.setRolePermissions(key, permissions, req.user, req.ip);
    res.status(204).end();
  });

  router.delete('/roles/:key', requirePermission('roles.manage'), (req, res) => {
    const { key } = parse(schemas.roleParam, req.params);
    access.deleteRole(key, req.user, req.ip);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- Audit
  router.get('/audit', requirePermission('audit.view'), (req, res) => {
    res.json(auditLog.list(parse(schemas.auditQuery, req.query)));
  });

  return router;
}

module.exports = { apiRouter };
