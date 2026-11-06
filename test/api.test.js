'use strict';

process.env.C7_SKIP_ENV_FILE = '1';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/lib/crypto');

config.appSecret = 'ab'.repeat(32);
config.otp.channels = ['sms', 'email'];
// The suite registers many visitors from one IP; the real per-IP cap is tested separately.
config.otp.maxPerIpPerHour = 1000;

const sent = [];
const messaging = {
  sms: async (to, code) => { sent.push({ to, code }); },
  email: async (to, code) => { sent.push({ to, code }); },
};
const silent = { log() {}, warn() {}, error() {} };

let server;
let base;
let db;

before(async () => {
  db = openDatabase(':memory:');
  const { app } = createApp({ config, db, logger: silent, messaging });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;

  const now = Date.now();
  const insert = db.prepare(`INSERT INTO users (full_name, email, role, password_hash, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run('Asha Admin', 'admin@test.local', 'super_admin', await hashPassword('Adm1n-Passw0rd!'), 0, now, now);
  insert.run('Riya Reception', 'reception@test.local', 'reception', await hashPassword('Rec3ption-Passw0rd!'), 0, now, now);
  insert.run('Chetan Counselor', 'counselor@test.local', 'counselor', await hashPassword('C0unselor-Passw0rd!'), 0, now, now);
  insert.run('New Starter', 'new@test.local', 'reception', await hashPassword('Temp0rary-Passw0rd!'), 1, now, now);
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});

// ---------------------------------------------------------------- helpers

async function call(method, path, { body, cookie, csrf, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

// Reuses a still-valid session so the suite stays under the real sign-in rate limit.
const sessions = new Map();
async function login(email, password) {
  const cached = sessions.get(email);
  if (cached) {
    const me = await call('GET', '/api/auth/me', { cookie: cached.cookie });
    if (me.status === 200 && !me.json.user.mustChangePassword) return { cookie: cached.cookie, csrf: me.json.csrfToken, me: me.json };
  }
  const s = await freshLogin(email, password);
  sessions.set(email, s);
  return s;
}

async function freshLogin(email, password) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 204, `login failed: ${JSON.stringify(res.json)}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const me = await call('GET', '/api/auth/me', { cookie });
  return { cookie, csrf: me.json?.csrfToken, me: me.json };
}

let mobileSeq = 9000000000;
function visitor(overrides = {}) {
  mobileSeq += 1;
  return { fullName: 'Priya Sharma', email: `priya${mobileSeq}@example.com`, countryCode: '91', mobile: String(mobileSeq), channel: 'sms', ...overrides };
}

const lastCode = () => sent[sent.length - 1].code;
const wrong = (code) => (code === '000000' ? '111111' : '000000');
const today = () => ({ from: Date.now() - 3_600_000, to: Date.now() + 3_600_000 });

// ---------------------------------------------------------------- registration

test('registration: valid OTP creates a lead and a waiting walk-in', async () => {
  const v = visitor();
  const start = await call('POST', '/api/registration', { body: v });
  assert.equal(start.status, 201);
  assert.match(start.json.requestId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(start.json.destination, `+91******${v.mobile.slice(-4)}`);
  assert.equal(sent.at(-1).to, `+91${v.mobile}`);
  assert.equal(JSON.stringify(start.json).includes(lastCode()), false, 'OTP must never be returned to the client');

  const ok = await call('POST', '/api/registration/verify', { body: { requestId: start.json.requestId, code: lastCode() } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.firstName, 'Priya');

  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const { from, to } = today();
  const list = await call('GET', `/api/walkins?from=${from}&to=${to}&status=all&q=${v.mobile}`, { cookie: rec.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].status, 'waiting');
  assert.match(list.json.items[0].lead.code, /^LD\d{6}$/);

  const lead = await call('GET', `/api/leads/${list.json.items[0].lead.id}`, { cookie: rec.cookie });
  assert.equal(lead.status, 200);
  assert.ok(lead.json.mobileVerifiedAt);
  assert.equal(lead.json.emailVerifiedAt, null);
});

test('registration: wrong OTP reports attempts left, then locks after the limit', async () => {
  const start = await call('POST', '/api/registration', { body: visitor() });
  const { requestId } = start.json;
  const code = lastCode();

  const first = await call('POST', '/api/registration/verify', { body: { requestId, code: wrong(code) } });
  assert.equal(first.status, 400);
  assert.equal(first.json.error.code, 'OTP_INVALID');
  assert.equal(first.json.error.attemptsRemaining, config.otp.maxAttempts - 1);

  for (let i = 1; i < config.otp.maxAttempts - 1; i++) {
    await call('POST', '/api/registration/verify', { body: { requestId, code: wrong(code) } });
  }
  const last = await call('POST', '/api/registration/verify', { body: { requestId, code: wrong(code) } });
  assert.equal(last.json.error.code, 'OTP_LOCKED');

  const late = await call('POST', '/api/registration/verify', { body: { requestId, code } });
  assert.equal(late.json.error.code, 'SESSION_ENDED', 'correct code must not work after lock-out');
});

test('registration: resend enforces cooldown and invalidates the old code', async () => {
  const start = await call('POST', '/api/registration', { body: visitor() });
  const { requestId } = start.json;
  const oldCode = lastCode();

  const tooSoon = await call('POST', '/api/registration/resend', { body: { requestId } });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.json.error.code, 'RESEND_COOLDOWN');

  db.prepare('UPDATE otp_requests SET last_sent_at = last_sent_at - 60000 WHERE id = ?').run(requestId);
  const resent = await call('POST', '/api/registration/resend', { body: { requestId } });
  assert.equal(resent.status, 200);
  const newCode = lastCode();

  if (newCode !== oldCode) {
    const stale = await call('POST', '/api/registration/verify', { body: { requestId, code: oldCode } });
    assert.equal(stale.json.error.code, 'OTP_INVALID');
  }
  const ok = await call('POST', '/api/registration/verify', { body: { requestId, code: newCode } });
  assert.equal(ok.status, 200);
});

test('registration: expired OTP is rejected', async () => {
  const start = await call('POST', '/api/registration', { body: visitor() });
  db.prepare('UPDATE otp_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1, start.json.requestId);
  const res = await call('POST', '/api/registration/verify', { body: { requestId: start.json.requestId, code: lastCode() } });
  assert.equal(res.json.error.code, 'OTP_EXPIRED');
});

test('registration: returning visitor reuses the lead and does not duplicate an open visit', async () => {
  const v = visitor();
  for (let i = 0; i < 2; i++) {
    const s = await call('POST', '/api/registration', { body: { ...v, fullName: i ? 'Priya S' : v.fullName } });
    const r = await call('POST', '/api/registration/verify', { body: { requestId: s.json.requestId, code: lastCode() } });
    assert.equal(r.status, 200);
  }
  const leads = db.prepare('SELECT id, full_name FROM leads WHERE mobile = ?').all(`+91${v.mobile}`);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].full_name, 'Priya Sharma', 'public form must not overwrite existing lead details');
  assert.equal(db.prepare('SELECT COUNT(*) FROM visits WHERE lead_id = ?').pluck().get(leads[0].id), 1);
});

test('registration: email channel verifies email, not mobile', async () => {
  const v = visitor({ channel: 'email' });
  const s = await call('POST', '/api/registration', { body: v });
  assert.equal(s.json.channel, 'email');
  assert.equal(sent.at(-1).to, v.email);
  await call('POST', '/api/registration/verify', { body: { requestId: s.json.requestId, code: lastCode() } });
  const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get(v.email);
  assert.ok(lead.email_verified_at);
  assert.equal(lead.mobile_verified_at, null);
});

test('registration: validation rejects bad input and unknown fields', async () => {
  const bad = await call('POST', '/api/registration', { body: { ...visitor(), mobile: '12345', email: 'nope' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.fields.email);

  const badMobile = await call('POST', '/api/registration', { body: visitor({ mobile: '1234567890' }) });
  assert.equal(badMobile.status, 422);
  assert.ok(badMobile.json.error.fields.mobile);

  const extra = await call('POST', '/api/registration', { body: { ...visitor(), role: 'super_admin' } });
  assert.equal(extra.status, 422);

  const xss = await call('POST', '/api/registration', { body: visitor({ fullName: '<script>alert(1)</script>' }) });
  assert.equal(xss.status, 422);

  const honeypot = await call('POST', '/api/registration', { body: { ...visitor(), company: 'bot' } });
  assert.notEqual(honeypot.status, 201);
});

test('registration: per-number daily cap stops SMS pumping', async () => {
  const v = visitor();
  const dest = `+91${v.mobile}`;
  const now = Date.now();
  const ins = db.prepare('INSERT INTO otp_sends (request_id, destination, ip, sent_at) VALUES (?, ?, ?, ?)');
  const s = await call('POST', '/api/registration', { body: v });
  for (let i = 1; i < config.otp.maxPerDestinationPerDay; i++) ins.run(s.json.requestId, dest, '10.0.0.9', now);
  const blocked = await call('POST', '/api/registration', { body: v });
  assert.equal(blocked.status, 429);
});

// ---------------------------------------------------------------- authentication & authorisation

test('auth: protected endpoints require a session', async () => {
  const { from, to } = today();
  assert.equal((await call('GET', `/api/walkins?from=${from}&to=${to}`)).status, 401);
  assert.equal((await call('GET', '/api/users')).status, 401);
  assert.equal((await call('GET', '/api/events')).status, 401);
});

test('auth: wrong password is generic; account locks after repeated failures', async () => {
  const unknown = await call('POST', '/api/auth/login', { body: { email: 'ghost@test.local', password: 'whatever-123' } });
  const wrongPw = await call('POST', '/api/auth/login', { body: { email: 'counselor@test.local', password: 'nope-nope-nope' } });
  assert.equal(unknown.status, 401);
  assert.equal(wrongPw.status, 401);
  assert.equal(unknown.json.error.message, wrongPw.json.error.message, 'must not reveal which accounts exist');

  for (let i = 1; i < config.auth.maxFailedAttempts; i++) {
    await call('POST', '/api/auth/login', { body: { email: 'counselor@test.local', password: 'nope-nope-nope' } });
  }
  const locked = await call('POST', '/api/auth/login', { body: { email: 'counselor@test.local', password: 'C0unselor-Passw0rd!' } });
  assert.equal(locked.status, 423);
  db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE email = 'counselor@test.local'`).run();
});

test('auth: session cookie is HttpOnly and SameSite=Strict', async () => {
  const res = await call('POST', '/api/auth/login', { body: { email: 'admin@test.local', password: 'Adm1n-Passw0rd!' } });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('auth: state-changing requests need the CSRF token', async () => {
  const s = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const noToken = await call('POST', '/api/users', { cookie: s.cookie, body: { fullName: 'X Y', email: 'x@test.local', role: 'reception' } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.json.error.code, 'CSRF_FAILED');

  const badToken = await call('POST', '/api/users', { cookie: s.cookie, csrf: 'forged', body: { fullName: 'X Y', email: 'x@test.local', role: 'reception' } });
  assert.equal(badToken.status, 403);
});

test('auth: cross-origin requests are rejected', async () => {
  const res = await call('POST', '/api/auth/login', {
    body: { email: 'admin@test.local', password: 'Adm1n-Passw0rd!' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'BAD_ORIGIN');
});

test('auth: temporary password must be changed before anything else', async () => {
  const s = await login('new@test.local', 'Temp0rary-Passw0rd!');
  assert.equal(s.me.user.mustChangePassword, true);
  const { from, to } = today();
  const blocked = await call('GET', `/api/walkins?from=${from}&to=${to}`, { cookie: s.cookie });
  assert.equal(blocked.json.error.code, 'PASSWORD_CHANGE_REQUIRED');

  const weak = await call('POST', '/api/auth/change-password', { cookie: s.cookie, csrf: s.csrf, body: { currentPassword: 'Temp0rary-Passw0rd!', newPassword: 'short' } });
  assert.equal(weak.status, 422);

  const ok = await call('POST', '/api/auth/change-password', { cookie: s.cookie, csrf: s.csrf, body: { currentPassword: 'Temp0rary-Passw0rd!', newPassword: 'Brand-New-Secret-42' } });
  assert.equal(ok.status, 204);
  assert.equal((await call('GET', `/api/walkins?from=${from}&to=${to}`, { cookie: s.cookie })).status, 200);
});

test('rbac: reception cannot manage users or read the audit log; counselor cannot change visits', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  assert.equal((await call('GET', '/api/users', { cookie: rec.cookie })).status, 403);
  assert.equal((await call('GET', '/api/audit', { cookie: rec.cookie })).status, 403);

  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const visitId = db.prepare('SELECT id FROM visits LIMIT 1').pluck().get();
  const res = await call('PATCH', `/api/visits/${visitId}`, { cookie: coun.cookie, csrf: coun.csrf, body: { status: 'left' } });
  assert.equal(res.status, 403);
});

test('visits: workflow enforces counselor assignment and valid transitions', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const counselorId = db.prepare(`SELECT id FROM users WHERE role = 'counselor'`).pluck().get();
  const visitId = db.prepare(`SELECT id FROM visits WHERE status = 'waiting' LIMIT 1`).pluck().get();
  const patch = (body) => call('PATCH', `/api/visits/${visitId}`, { cookie: rec.cookie, csrf: rec.csrf, body });

  assert.equal((await patch({ status: 'with_counselor' })).status, 400, 'needs a counselor');
  assert.equal((await patch({ status: 'completed' })).status, 400, 'cannot skip consultation');
  assert.equal((await patch({ status: 'with_counselor', counselorId })).status, 204);
  assert.equal((await patch({ status: 'completed' })).status, 204);
  assert.equal((await patch({ status: 'waiting' })).status, 400, 'closed visits stay closed');
});

test('users: super admin creates a user who receives a one-time password', async () => {
  const s = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const res = await call('POST', '/api/users', { cookie: s.cookie, csrf: s.csrf, body: { fullName: 'Meera Counselor', email: 'meera@test.local', role: 'counselor' } });
  assert.equal(res.status, 201);
  assert.match(res.json.temporaryPassword, /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
  assert.equal(res.json.user.mustChangePassword, true);
  assert.equal(JSON.stringify(res.json.user).includes('hash'), false);

  const self = await call('PATCH', `/api/users/${s.me.user.id}`, { cookie: s.cookie, csrf: s.csrf, body: { isActive: false } });
  assert.equal(self.status, 400, 'admins cannot deactivate themselves');
});

test('users: deactivating a user ends their sessions immediately', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const id = coun.me.user.id;
  await call('PATCH', `/api/users/${id}`, { cookie: admin.cookie, csrf: admin.csrf, body: { isActive: false } });
  assert.equal((await call('GET', '/api/auth/me', { cookie: coun.cookie })).status, 401);
  await call('PATCH', `/api/users/${id}`, { cookie: admin.cookie, csrf: admin.csrf, body: { isActive: true } });
});

test('leads: notes are stored as plain text and search handles SQL wildcards safely', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const leadId = db.prepare('SELECT id FROM leads LIMIT 1').pluck().get();
  const payload = '<img src=x onerror=alert(1)>';
  assert.equal((await call('POST', `/api/leads/${leadId}/notes`, { cookie: rec.cookie, csrf: rec.csrf, body: { body: payload } })).status, 201);
  const lead = await call('GET', `/api/leads/${leadId}`, { cookie: rec.cookie });
  assert.equal(lead.json.notes[0].body, payload, 'stored verbatim; the UI renders it as text');

  const { from, to } = today();
  const injection = await call('GET', `/api/walkins?from=${from}&to=${to}&q=${encodeURIComponent("%' OR 1=1 --")}`, { cookie: rec.cookie });
  assert.equal(injection.status, 200);
  assert.equal(injection.json.items.length, 0);
});

test('headers: CSP and hardening headers are present', async () => {
  const res = await fetch(`${base}/register`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  const api = await fetch(`${base}/api/registration/options`);
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('walk-ins: visits still open from an earlier day stay on today\'s list', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const leadId = db.prepare('SELECT id FROM leads LIMIT 1').pluck().get();
  const yesterday = Date.now() - 20 * 3_600_000;
  const visitId = Number(db.prepare(`INSERT INTO visits (lead_id, status, submitted_name, submitted_email, submitted_mobile, verified_channel, checked_in_at, updated_at)
    VALUES (?, 'waiting', 'Carry Over', 'c@example.com', '+919000000001', 'sms', ?, ?)`).run(leadId, yesterday, yesterday).lastInsertRowid);

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const from = Math.max(start.getTime(), yesterday + 1);
  const list = await call('GET', `/api/walkins?from=${from}&to=${from + 86_400_000}&status=waiting`, { cookie: rec.cookie });
  assert.ok(list.json.items.some((v) => v.id === visitId));

  const past = await call('GET', `/api/walkins?from=${from - 3 * 86_400_000}&to=${from - 2 * 86_400_000}`, { cookie: rec.cookie });
  assert.equal(past.json.items.some((v) => v.id === visitId), false, 'historical dates show only that day');
});

// ---------------------------------------------------------------- lead transparency

async function registerLead(overrides = {}) {
  const v = visitor(overrides);
  const s = await call('POST', '/api/registration', { body: v });
  await call('POST', '/api/registration/verify', { body: { requestId: s.json.requestId, code: lastCode() } });
  return db.prepare('SELECT id FROM leads WHERE mobile = ?').pluck().get(`+91${v.mobile}`);
}

test('transparency: counselors and coaching admins have no walk-ins menu', async () => {
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const { from, to } = today();
  assert.equal((await call('GET', `/api/walkins?from=${from}&to=${to}`, { cookie: coun.cookie })).status, 403);
  assert.ok(!coun.me.permissions.includes('walkins.view'));
  assert.ok(coun.me.permissions.includes('leads.view_assigned'));
});

test('transparency: until assigned, a new lead is fully visible only to reception and super admin', async () => {
  const leadId = await registerLead();
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');

  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: rec.cookie })).status, 200);
  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: admin.cookie })).status, 200);
  const readOnly = await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie });
  assert.equal(readOnly.json.access, 'readonly', 'counselors may only view an unassigned lead');
  const list = await call('GET', '/api/leads', { cookie: coun.cookie });
  assert.equal(list.json.items.some((l) => l.id === leadId), false);
  assert.equal(list.json.scope, 'assigned');
  assert.equal((await call('PATCH', `/api/leads/${leadId}`, { cookie: coun.cookie, csrf: coun.csrf, body: { fullName: 'Not Allowed' } })).status, 403);

  // Reception assigns: the counselor now sees it.
  const counselorId = coun.me.user.id;
  assert.equal((await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: counselorId } })).status, 204);
  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).status, 200);
  assert.ok((await call('GET', '/api/leads', { cookie: coun.cookie })).json.items.some((l) => l.id === leadId));

  // Reassigned to someone else: no longer visible.
  const meera = db.prepare(`SELECT id FROM users WHERE email = 'meera@test.local'`).pluck().get();
  await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: meera } });
  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).status, 404);
});

test('transparency: assigning a walk-in visit to a counselor makes them the lead owner', async () => {
  const leadId = await registerLead();
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const visitId = db.prepare('SELECT id FROM visits WHERE lead_id = ?').pluck().get(leadId);
  const res = await call('PATCH', `/api/visits/${visitId}`, { cookie: rec.cookie, csrf: rec.csrf, body: { status: 'with_counselor', counselorId: coun.me.user.id } });
  assert.equal(res.status, 204);
  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).json.owner.id, coun.me.user.id);
});

test('transparency: counselors cannot assign leads, and only eligible logins can receive them', async () => {
  const leadId = await registerLead();
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  assert.equal((await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: coun.cookie, csrf: coun.csrf, body: { assigneeId: coun.me.user.id } })).status, 403);
  // A reception login cannot be an assignee (it lacks "can be assigned leads").
  assert.equal((await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: rec.me.user.id } })).status, 400);
});

// ---------------------------------------------------------------- roles & permissions

test('roles: super admin creates a role, maps permissions, and logins get exactly that access', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const created = await call('POST', '/api/roles', { cookie: admin.cookie, csrf: admin.csrf, body: { name: 'IELTS Department', copyFrom: 'counselor' } });
  assert.equal(created.status, 201);
  const key = created.json.key;
  const counselorRole = (await call('GET', '/api/roles', { cookie: admin.cookie })).json.roles.find((r) => r.key === 'counselor');
  assert.deepEqual(created.json.permissions.sort(), counselorRole.permissions.sort(), 'copied exactly from Counselor');

  const u = await call('POST', '/api/users', { cookie: admin.cookie, csrf: admin.csrf, body: { fullName: 'Ira Trainer', email: 'ira@test.local', role: key } });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword('Ira-Trainer-Pass-1'), u.json.user.id);
  const ira = await login('ira@test.local', 'Ira-Trainer-Pass-1');
  assert.equal(ira.me.user.roleLabel, 'IELTS Department');
  assert.equal((await call('GET', '/api/leads', { cookie: ira.cookie })).json.scope, 'assigned');

  // Granting "view all leads" to the role takes effect on the next request.
  const put = await call('PUT', `/api/roles/${key}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { permissions: ['leads.view_all', 'leads.note', 'leads.receive'] } });
  assert.equal(put.status, 204);
  assert.equal((await call('GET', '/api/leads', { cookie: ira.cookie })).json.scope, 'all');

  assert.equal((await call('DELETE', `/api/roles/${key}`, { cookie: admin.cookie, csrf: admin.csrf })).status, 409, 'roles in use cannot be deleted');
});

test('roles: dependencies, Super Admin lock and admin-only permissions are enforced', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const put = (role, permissions) => call('PUT', `/api/roles/${role}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { permissions } });
  assert.equal((await put('counselor', ['walkins.manage'])).status, 422, 'missing dependency');
  assert.equal((await put('reception', ['users.manage'])).status, 400, 'admin menus are reserved for Super Admin');
  assert.equal((await put('super_admin', [])).status, 400, 'Super Admin is locked');
  assert.equal((await put('counselor', ['leads.delete_everything'])).status, 400, 'unknown permission');
  assert.equal((await call('DELETE', '/api/roles/reception', { cookie: admin.cookie, csrf: admin.csrf })).status, 400, 'built-in roles stay');

  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  assert.equal((await call('GET', '/api/roles', { cookie: rec.cookie })).status, 403);
});

test('roles: per-login overrides add or remove access for one person only', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const id = coun.me.user.id;
  const put = (overrides) => call('PUT', `/api/users/${id}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { overrides } });

  const grant = await put({ 'leads.view_all': true });
  assert.equal(grant.status, 200);
  assert.ok(grant.json.effective.includes('leads.view_all'));
  assert.equal((await call('GET', '/api/leads', { cookie: coun.cookie })).json.scope, 'all');

  assert.equal((await put({ 'audit.view': true })).status, 400, 'admin menus cannot be granted per login');

  await put({});
  assert.equal((await call('GET', '/api/leads', { cookie: coun.cookie })).json.scope, 'assigned');
});

// ---------------------------------------------------------------- lead stage

test('stage: the owner moves a lead through the pipeline; converted is final', async () => {
  const leadId = await registerLead();
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const stage = (s, who) => call('PUT', `/api/leads/${leadId}/stage`, { cookie: who.cookie, csrf: who.csrf, body: { stage: s } });

  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: rec.cookie })).json.stage, 'new');
  assert.equal((await stage('contacted', coun)).status, 403, 'not assigned to this counselor yet: view only');

  await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });
  assert.equal((await stage('contacted', coun)).status, 204);
  assert.equal((await stage('lost_interest', coun)).status, 204);
  assert.equal((await stage('working', coun)).status, 204, 'lost leads can be reopened');
  assert.equal((await stage('converted', coun)).status, 204);

  const lead = (await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).json;
  assert.equal(lead.stage, 'converted');
  assert.ok(lead.convertedAt);
  assert.equal(lead.updatedBy, 'Chetan Counselor');
  assert.equal((await stage('working', rec)).status, 400, 'converted is final');
  assert.equal((await stage('bogus', rec)).status, 422);

  const converted = await call('GET', '/api/leads?stage=converted', { cookie: rec.cookie });
  assert.ok(converted.json.items.some((l) => l.id === leadId && l.stage === 'converted'));
  const open = await call('GET', '/api/leads?stage=open', { cookie: rec.cookie });
  assert.equal(open.json.items.some((l) => l.id === leadId), false);
});

// ---------------------------------------------------------------- quick create + notifications

test('quick create: reception adds a phone lead and assigns it; the counselor is notified', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  await call('POST', '/api/notifications/read-all', { cookie: coun.cookie, csrf: coun.csrf });

  const res = await call('POST', '/api/leads', { cookie: rec.cookie, csrf: rec.csrf, body: {
    fullName: 'Kiran Rao', email: '', countryCode: '91', mobile: '9000011111', source: 'phone', assigneeId: coun.me.user.id, note: 'Called about IELTS batches.',
  } });
  assert.equal(res.status, 201);
  const lead = (await call('GET', `/api/leads/${res.json.id}`, { cookie: coun.cookie })).json;
  assert.equal(lead.source, 'phone');
  assert.equal(lead.createdBy, 'Riya Reception');
  assert.equal(lead.owner.id, coun.me.user.id);
  assert.equal(lead.notes.length, 1);
  assert.equal(lead.email, '');

  const n = (await call('GET', '/api/notifications', { cookie: coun.cookie })).json;
  assert.equal(n.unread, 1);
  assert.equal(n.items[0].type, 'lead.assigned');
  assert.equal(n.items[0].link, `/app/leads/${res.json.id}`);

  assert.equal((await call('POST', `/api/notifications/${n.items[0].id}/read`, { cookie: coun.cookie, csrf: coun.csrf })).status, 204);
  assert.equal((await call('GET', '/api/notifications', { cookie: coun.cookie })).json.unread, 0);
  // Cannot touch someone else's notification.
  assert.equal((await call('POST', `/api/notifications/${n.items[0].id}/read`, { cookie: rec.cookie, csrf: rec.csrf })).status, 404);
});

test('quick create: counselors need the permission, and their leads stay visible to them', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const body = { fullName: 'Lata Shah', countryCode: '91', mobile: '9000022222', source: 'referral' };
  assert.equal((await call('POST', '/api/leads', { cookie: coun.cookie, csrf: coun.csrf, body })).status, 403);

  await call('PUT', `/api/users/${coun.me.user.id}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { overrides: { 'leads.create': true } } });
  const created = await call('POST', '/api/leads', { cookie: coun.cookie, csrf: coun.csrf, body });
  assert.equal(created.status, 201);
  assert.equal((await call('GET', `/api/leads/${created.json.id}`, { cookie: coun.cookie })).json.owner.id, coun.me.user.id, 'auto-owned so it is visible');
  const other = db.prepare(`SELECT id FROM users WHERE email = 'meera@test.local'`).pluck().get();
  assert.equal((await call('POST', '/api/leads', { cookie: coun.cookie, csrf: coun.csrf, body: { ...body, mobile: '9000033333', assigneeId: other } })).status, 400);
  await call('PUT', `/api/users/${coun.me.user.id}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { overrides: {} } });
});

test('notifications: front desk is told about new walk-ins; previous owner is told when a lead moves', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  await call('POST', '/api/notifications/read-all', { cookie: rec.cookie, csrf: rec.csrf });
  const leadId = await registerLead({ fullName: 'Walk In Person' });
  const recN = (await call('GET', '/api/notifications', { cookie: rec.cookie })).json;
  assert.ok(recN.items.some((x) => x.type === 'walkin.new' && x.body.includes('Walk In Person')));
  const counN = (await call('GET', '/api/notifications', { cookie: coun.cookie })).json;
  assert.equal(counN.items.some((x) => x.type === 'walkin.new' && x.body.includes('Walk In Person')), false, 'counselors are not told about unassigned walk-ins');

  await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });
  const meera = db.prepare(`SELECT id FROM users WHERE email = 'meera@test.local'`).pluck().get();
  await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: meera } });
  const moved = (await call('GET', '/api/notifications', { cookie: coun.cookie })).json.items[0];
  assert.equal(moved.type, 'lead.reassigned');
  assert.equal(moved.link, null, 'no link to a lead they can no longer open');
});

test('edit: counselors can edit their own leads only; nobody can change the lead source', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  assert.ok(coun.me.permissions.includes('leads.edit'));
  const mine = await registerLead();
  const notMine = await registerLead();
  await call('PUT', `/api/leads/${mine}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });

  const ok = await call('PATCH', `/api/leads/${mine}`, { cookie: coun.cookie, csrf: coun.csrf, body: { fullName: 'Priya S Sharma' } });
  assert.equal(ok.status, 204);
  const lead = (await call('GET', `/api/leads/${mine}`, { cookie: coun.cookie })).json;
  assert.equal(lead.fullName, 'Priya S Sharma');
  assert.equal(lead.source, 'walk_in');

  // Lead source is locked for every role, Super Admin included.
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  for (const who of [coun, rec, admin]) {
    const res = await call('PATCH', `/api/leads/${mine}`, { cookie: who.cookie, csrf: who.csrf, body: { source: 'referral' } });
    assert.equal(res.status, 422);
  }
  assert.equal((await call('GET', `/api/leads/${mine}`, { cookie: coun.cookie })).json.source, 'walk_in');

  const denied = await call('PATCH', `/api/leads/${notMine}`, { cookie: coun.cookie, csrf: coun.csrf, body: { fullName: 'Hacked Name' } });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));
  assert.equal((await call('PATCH', `/api/leads/${mine}`, { cookie: coun.cookie, csrf: coun.csrf, body: { mobile: '+919999999999' } })).status, 422, 'mobile is not editable');
});

test('registration: per-IP hourly cap blocks bulk OTP requests from one device', async () => {
  const saved = config.otp.maxPerIpPerHour;
  config.otp.maxPerIpPerHour = 1;
  try {
    const res = await call('POST', '/api/registration', { body: visitor() });
    assert.equal(res.status, 429);
    assert.match(res.json.error.message, /this device/);
  } finally {
    config.otp.maxPerIpPerHour = saved;
  }
});

test('deletion: no role can delete a lead, and the database refuses it too', async () => {
  const leadId = db.prepare('SELECT id FROM leads LIMIT 1').pluck().get();
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  for (const who of [admin, rec]) {
    const res = await call('DELETE', `/api/leads/${leadId}`, { cookie: who.cookie, csrf: who.csrf });
    assert.equal(res.status, 404, 'there is no delete endpoint');
  }
  assert.ok(!admin.me.permissions.some((p) => p.includes('delete')), 'no delete permission exists');

  assert.throws(() => db.prepare('DELETE FROM leads WHERE id = ?').run(leadId), /Leads cannot be deleted/);
  assert.throws(() => db.prepare('DELETE FROM visits').run(), /Visits cannot be deleted/);
  assert.throws(() => db.prepare('DELETE FROM lead_notes').run(), /Lead notes cannot be deleted/);
  assert.ok(db.prepare('SELECT 1 FROM leads WHERE id = ?').get(leadId), 'lead still there');
});

// ---------------------------------------------------------------- search: unassigned leads, view-only

test('search: counselors find unassigned leads (3+ chars) view-only; others\' leads stay hidden', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  assert.ok(coun.me.permissions.includes('leads.search_unassigned'));

  const unassigned = await registerLead({ fullName: 'Zubin Unassigned' });
  const othersLead = await registerLead({ fullName: 'Zubin Othersowned' });
  const meera = db.prepare(`SELECT id FROM users WHERE email = 'meera@test.local'`).pluck().get();
  await call('PUT', `/api/leads/${othersLead}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: meera } });

  const short = (await call('GET', '/api/leads?q=zu', { cookie: coun.cookie })).json;
  assert.equal(short.items.some((l) => l.id === unassigned), false, 'needs 3+ characters');
  assert.equal((await call('GET', '/api/leads', { cookie: coun.cookie })).json.items.some((l) => l.id === unassigned), false, 'not in My leads without a search');

  const found = (await call('GET', '/api/leads?q=zubin', { cookie: coun.cookie })).json;
  const hit = found.items.find((l) => l.id === unassigned);
  assert.ok(hit, 'unassigned lead is found');
  assert.equal(hit.access, 'readonly');
  assert.equal(found.items.some((l) => l.id === othersLead), false, 'another counselor\'s lead stays hidden');

  // View-only: can open and add notes, cannot edit, change stage or assign.
  const lead = await call('GET', `/api/leads/${unassigned}`, { cookie: coun.cookie });
  assert.equal(lead.status, 200);
  assert.equal(lead.json.access, 'readonly');
  assert.equal((await call('POST', `/api/leads/${unassigned}/notes`, { cookie: coun.cookie, csrf: coun.csrf, body: { body: 'Spoke at the desk, interested in PTE.' } })).status, 201);
  assert.equal((await call('PATCH', `/api/leads/${unassigned}`, { cookie: coun.cookie, csrf: coun.csrf, body: { fullName: 'Changed Name' } })).status, 403);
  assert.equal((await call('PUT', `/api/leads/${unassigned}/stage`, { cookie: coun.cookie, csrf: coun.csrf, body: { stage: 'contacted' } })).status, 403);
  assert.equal((await call('GET', `/api/leads/${othersLead}`, { cookie: coun.cookie })).status, 404);

  // Once assigned to this counselor, full editing unlocks.
  await call('PUT', `/api/leads/${unassigned}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });
  assert.equal((await call('GET', `/api/leads/${unassigned}`, { cookie: coun.cookie })).json.access, 'full');
  assert.equal((await call('PATCH', `/api/leads/${unassigned}`, { cookie: coun.cookie, csrf: coun.csrf, body: { fullName: 'Zubin Now Mine' } })).status, 204);

  // Assigned to someone else: gone from view again.
  await call('PUT', `/api/leads/${unassigned}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: meera } });
  assert.equal((await call('GET', `/api/leads/${unassigned}`, { cookie: coun.cookie })).status, 404);
});

test('search: without the permission, unassigned leads are not searchable', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const leadId = await registerLead({ fullName: 'Quentin Hidden' });
  await call('PUT', `/api/users/${coun.me.user.id}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { overrides: { 'leads.search_unassigned': false } } });
  assert.equal((await call('GET', '/api/leads?q=quentin', { cookie: coun.cookie })).json.items.some((l) => l.id === leadId), false);
  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).status, 404);
  await call('PUT', `/api/users/${coun.me.user.id}/permissions`, { cookie: admin.cookie, csrf: admin.csrf, body: { overrides: {} } });
});

// ---------------------------------------------------------------- bulk upload

test('bulk upload: Super Admin only; preview reports errors and duplicates; import creates valid rows', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  assert.ok(admin.me.permissions.includes('leads.import'));
  assert.ok(!rec.me.permissions.includes('leads.import'));

  const existing = db.prepare('SELECT mobile FROM leads WHERE mobile LIKE ? LIMIT 1').pluck().get('+91%').slice(3);
  const csv = [
    '\uFEFFFull name,Mobile,Email,Source,Assign to (login email),Note',
    'Asha Verma,9300000001,asha@example.com,Referral,counselor@test.local,"Wants evening batch, IELTS"',
    'Bala Krishnan,9300000002,,Phone call,,',
    'Bad Number,12345,,,,',
    'Dup Of Existing,' + existing + ',,,,',
    'Dup In File,9300000001,,,,',
    'Wrong Source,9300000003,,Billboard,,',
    'Unknown Owner,9300000004,,,nobody@test.local,',
  ].join('\r\n');
  const body = { csv, skipDuplicates: true };

  assert.equal((await call('POST', '/api/leads/import', { cookie: rec.cookie, csrf: rec.csrf, body })).status, 403);

  const before = db.prepare('SELECT COUNT(*) FROM leads').pluck().get();
  const preview = await call('POST', '/api/leads/import', { cookie: admin.cookie, csrf: admin.csrf, body });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.summary, { total: 7, ready: 2, duplicates: 2, errors: 3, willCreate: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) FROM leads').pluck().get(), before, 'preview creates nothing');
  const byName = Object.fromEntries(preview.json.rows.map((r) => [r.fullName, r]));
  assert.equal(byName['Bad Number'].status, 'error');
  assert.equal(byName['Dup In File'].duplicateOf, 'row 2 of this file');
  assert.match(byName['Wrong Source'].errors[0], /Unknown source/);
  assert.match(byName['Unknown Owner'].errors[0], /not an active login/);
  assert.equal(byName['Asha Verma'].owner, 'Chetan Counselor');

  await call('POST', '/api/notifications/read-all', { cookie: coun.cookie, csrf: coun.csrf });
  const done = await call('POST', '/api/leads/import', { cookie: admin.cookie, csrf: admin.csrf, body: { ...body, dryRun: false } });
  assert.equal(done.status, 200);
  assert.equal(done.json.summary.created, 2);
  assert.equal(db.prepare('SELECT COUNT(*) FROM leads').pluck().get(), before + 2);

  const asha = db.prepare(`SELECT * FROM leads WHERE mobile = '+919300000001'`).get();
  assert.equal(asha.source, 'referral');
  assert.equal(asha.assigned_to, coun.me.user.id);
  assert.equal(db.prepare('SELECT body FROM lead_notes WHERE lead_id = ?').pluck().get(asha.id), 'Wants evening batch, IELTS');
  const bala = db.prepare(`SELECT * FROM leads WHERE mobile = '+919300000002'`).get();
  assert.equal(bala.source, 'phone', 'a Source column value is kept');
  assert.equal(bala.assigned_to, null);

  // Rows without a source get "Bulk Upload"; other defaults are refused; Quick Create cannot use it.
  const plain = await call('POST', '/api/leads/import', { cookie: admin.cookie, csrf: admin.csrf, body: { csv: 'Full name,Mobile\nPlain Row,9300000009', dryRun: false } });
  assert.equal(plain.status, 200);
  assert.equal(db.prepare(`SELECT source FROM leads WHERE mobile = '+919300000009'`).pluck().get(), 'bulk_upload');
  // Both screens share one source list: Bulk Upload is allowed, "Other" is not offered for new leads.
  assert.equal((await call('POST', '/api/leads/import', { cookie: admin.cookie, csrf: admin.csrf, body: { csv, defaultSource: 'referral' } })).status, 200);
  assert.equal((await call('POST', '/api/leads/import', { cookie: admin.cookie, csrf: admin.csrf, body: { csv, defaultSource: 'other' } })).status, 422);
  assert.equal((await call('POST', '/api/leads', { cookie: admin.cookie, csrf: admin.csrf, body: { fullName: 'Quick Person', countryCode: '91', mobile: '9300000010', source: 'bulk_upload' } })).status, 201);
  assert.equal((await call('POST', '/api/leads', { cookie: admin.cookie, csrf: admin.csrf, body: { fullName: 'Other Person', countryCode: '91', mobile: '9300000011', source: 'other' } })).status, 422);

  const n = (await call('GET', '/api/notifications', { cookie: coun.cookie })).json;
  assert.equal(n.items[0].title, '1 lead assigned to you');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'leads.imported'`).get());
});

test('bulk upload: rejects files without the required columns or with too many rows', async () => {
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const post = (csv) => call('POST', '/api/leads/import', { cookie: admin.cookie, csrf: admin.csrf, body: { csv } });
  assert.equal((await post('Name,Email\nA B,a@b.co')).status, 400);
  assert.equal((await post('Full name,Mobile')).status, 400);
  const big = ['Full name,Mobile', ...Array.from({ length: 2001 }, (_, i) => `Person ${i},${9400000000 + i}`)].join('\n');
  const tooMany = await post(big);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error.message, /at most 2000/);
});

// ---------------------------------------------------------------- dashboard

test('dashboard: counselors see only their assigned leads; office view sees everything', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  const range = `from=${Date.now() - 86_400_000}&to=${Date.now() + 60_000}`;

  const mine = await registerLead({ fullName: 'Dash Mine' });
  await call('PUT', `/api/leads/${mine}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });
  await call('PUT', `/api/leads/${mine}/stage`, { cookie: coun.cookie, csrf: coun.csrf, body: { stage: 'converted' } });

  const assignedToCounselor = db.prepare('SELECT COUNT(*) FROM leads WHERE assigned_to = ? AND assigned_at >= ?').pluck().get(coun.me.user.id, Date.now() - 86_400_000);
  const cd = (await call('GET', `/api/dashboard?${range}&owner=all`, { cookie: coun.cookie })).json;
  assert.equal(cd.scope.label, 'assigned to you', 'owner=all is ignored for assigned-only logins');
  assert.equal(cd.leads.total, assignedToCounselor);
  assert.ok(cd.outcomes.converted >= 1);
  assert.equal(cd.byOwner, undefined, 'no office-wide data for counselors');
  assert.equal(cd.walkins, undefined);
  assert.equal(cd.bySource.reduce((a, s) => a + s.count, 0), cd.leads.total);

  const ad = (await call('GET', `/api/dashboard?${range}`, { cookie: admin.cookie })).json;
  assert.equal(ad.leads.total, db.prepare('SELECT COUNT(*) FROM leads WHERE created_at >= ?').pluck().get(Date.now() - 86_400_000));
  assert.ok(Array.isArray(ad.byOwner));
  assert.ok(ad.walkins.total >= 1);
  const one = (await call('GET', `/api/dashboard?${range}&owner=${coun.me.user.id}`, { cookie: admin.cookie })).json;
  assert.equal(one.leads.total, assignedToCounselor);

  assert.equal((await call('GET', `/api/dashboard?from=0&to=${Date.now()}`, { cookie: admin.cookie })).status, 400, 'range capped at a year');
  assert.equal((await call('GET', `/api/dashboard?${range}`)).status, 401);
});

// ---------------------------------------------------------------- fees, payments, revenue dashboard

test('payments: owner sets agreed amount and records payments; ledger is immutable', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const leadId = await registerLead({ fullName: 'Fee Payer' });
  const pay = (who, body) => call('POST', `/api/leads/${leadId}/payments`, { cookie: who.cookie, csrf: who.csrf, body });
  const today = Date.now();

  // Not assigned yet: counselor is view-only.
  assert.equal((await call('PUT', `/api/leads/${leadId}/agreed-amount`, { cookie: coun.cookie, csrf: coun.csrf, body: { amount: 50000 } })).status, 403);

  await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });
  assert.equal((await call('PUT', `/api/leads/${leadId}/agreed-amount`, { cookie: coun.cookie, csrf: coun.csrf, body: { amount: 50000 } })).status, 204);
  assert.equal((await pay(coun, { amount: 20000.5, paidOn: today, mode: 'upi', reference: 'UPI123' })).status, 201);
  assert.equal((await pay(coun, { amount: 0, paidOn: today, mode: 'cash' })).status, 422);
  assert.equal((await pay(coun, { amount: 10, paidOn: today + 5 * 86_400_000, mode: 'cash' })).status, 400, 'no future dates');
  assert.equal((await pay(coun, { amount: 10.123, paidOn: today, mode: 'cash' })).status, 422, 'max 2 decimals');

  const f = (await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).json.finance;
  assert.equal(f.agreed, 5_000_000);
  assert.equal(f.collected, 2_000_050);
  assert.equal(f.outstanding, 2_999_950);
  assert.equal(f.payments[0].reference, 'UPI123');

  assert.throws(() => db.prepare('UPDATE payments SET amount = 1').run(), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM payments').run(), /cannot be deleted/);
});

test('dashboard: revenue is Super Admin only office-wide; counselors see their own', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const admin = await login('admin@test.local', 'Adm1n-Passw0rd!');
  assert.ok(admin.me.permissions.includes('reports.revenue'));
  assert.ok(!rec.me.permissions.includes('reports.revenue'));
  const range = `from=${Date.now() - 86_400_000}&to=${Date.now() + 86_400_000}`;

  const ad = (await call('GET', `/api/dashboard?${range}`, { cookie: admin.cookie })).json;
  const allPaid = db.prepare('SELECT SUM(amount) FROM payments WHERE paid_on >= ?').pluck().get(Date.now() - 86_400_000);
  assert.equal(ad.finance.collected, allPaid);
  const row = ad.byCounselor.find((r) => r.id === coun.me.user.id);
  assert.ok(row && row.collected >= 2_000_050 && row.outstanding >= 2_999_950);
  assert.ok(ad.bySourceRevenue.some((r) => r.source === 'walk_in'));

  const rd = (await call('GET', `/api/dashboard?${range}`, { cookie: rec.cookie })).json;
  assert.equal(rd.finance, undefined, 'reception has no revenue figures');
  assert.equal(rd.byCounselor, undefined);

  const cd = (await call('GET', `/api/dashboard?${range}`, { cookie: coun.cookie })).json;
  const mine = db.prepare('SELECT SUM(p.amount) FROM payments p JOIN leads l ON l.id = p.lead_id WHERE l.assigned_to = ? AND p.paid_on >= ?').pluck().get(coun.me.user.id, Date.now() - 86_400_000);
  assert.equal(cd.finance.collected, mine);
  assert.equal(cd.byCounselor, undefined);
});

test('walk-ins: new walk-in leads belong to Reception and stay findable by counselors until handed over', async () => {
  const rec = await login('reception@test.local', 'Rec3ption-Passw0rd!');
  const coun = await login('counselor@test.local', 'C0unselor-Passw0rd!');
  const leadId = await registerLead({ fullName: 'Yasmin Frontdesk' });

  const asRec = (await call('GET', `/api/leads/${leadId}`, { cookie: rec.cookie })).json;
  assert.equal(asRec.owner.id, rec.me.user.id, 'owned by the Reception login');
  assert.ok(asRec.activity.some((a) => a.action === 'lead.assigned' && a.details.auto === 'walk-in default'));

  const awaiting = (await call('GET', '/api/leads?owner=unassigned&q=yasmin', { cookie: rec.cookie })).json;
  assert.ok(awaiting.items.some((l) => l.id === leadId), 'listed as awaiting a counselor');

  const found = (await call('GET', '/api/leads?q=yasmin', { cookie: coun.cookie })).json.items.find((l) => l.id === leadId);
  assert.equal(found?.access, 'readonly', 'counselors can still find it, view only');
  assert.equal((await call('PATCH', `/api/leads/${leadId}`, { cookie: coun.cookie, csrf: coun.csrf, body: { fullName: 'Nope Nope' } })).status, 403);

  await call('PUT', `/api/leads/${leadId}/assignment`, { cookie: rec.cookie, csrf: rec.csrf, body: { assigneeId: coun.me.user.id } });
  assert.equal((await call('GET', `/api/leads/${leadId}`, { cookie: coun.cookie })).json.access, 'full');
  const after = (await call('GET', '/api/leads?owner=unassigned&q=yasmin', { cookie: rec.cookie })).json;
  assert.equal(after.items.some((l) => l.id === leadId), false, 'no longer awaiting');

  // A returning visitor keeps their existing owner.
  const mobile = db.prepare('SELECT mobile FROM leads WHERE id = ?').pluck().get(leadId).slice(3);
  await registerLead({ mobile, fullName: 'Yasmin Frontdesk' });
  assert.equal(db.prepare('SELECT assigned_to FROM leads WHERE id = ?').pluck().get(leadId), coun.me.user.id);
});
