'use strict';

const { AppError, badRequest, tooMany } = require('../lib/errors');
const { randomToken, hmac, safeEqualHex, numericCode } = require('../lib/crypto');
const { toE164, maskPhone, maskEmail } = require('../lib/phone');

// A verification session may be resent within this window; afterwards the visitor starts over.
const REQUEST_LIFETIME_MS = 30 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function createRegistrationService({ db, config, messaging, audit, events, notifications, logger }) {
  const otp = config.otp;
  const devBypass = !config.isProduction && otp.devBypassCode ? otp.devBypassCode : null;
  if (devBypass) logger.warn(`[DEV ONLY] OTP bypass active: every verification code is ${devBypass}`);
  const newCode = () => devBypass || numericCode(otp.length);

  const q = {
    sendsForDestination: db.prepare('SELECT COUNT(*) FROM otp_sends WHERE destination = ? AND sent_at > ?').pluck(),
    sendsForIp: db.prepare('SELECT COUNT(*) FROM otp_sends WHERE ip = ? AND sent_at > ?').pluck(),
    sendsGlobal: db.prepare('SELECT COUNT(*) FROM otp_sends WHERE sent_at > ?').pluck(),
    expirePendingForDestination: db.prepare(`UPDATE otp_requests SET status = 'expired'
                                             WHERE destination = ? AND status = 'pending'`),
    insertRequest: db.prepare(`INSERT INTO otp_requests
      (id, full_name, email, mobile, channel, destination, code_hash, ip, last_sent_at, expires_at, created_at)
      VALUES (@id, @fullName, @email, @mobile, @channel, @destination, @codeHash, @ip, @now, @expiresAt, @now)`),
    insertSend: db.prepare('INSERT INTO otp_sends (request_id, destination, ip, sent_at) VALUES (?, ?, ?, ?)'),
    getRequest: db.prepare('SELECT * FROM otp_requests WHERE id = ?'),
    markExpired: db.prepare(`UPDATE otp_requests SET status = 'expired' WHERE id = ?`),
    rotateCode: db.prepare(`UPDATE otp_requests
      SET code_hash = @codeHash, attempts = 0, sends = sends + 1, last_sent_at = @now, expires_at = @expiresAt
      WHERE id = @id AND status = 'pending'`),
    bumpAttempts: db.prepare(`UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'
                              RETURNING attempts`).pluck(),
    lockRequest: db.prepare(`UPDATE otp_requests SET status = 'locked' WHERE id = ?`),
    markVerified: db.prepare(`UPDATE otp_requests SET status = 'verified', verified_at = ?, lead_id = ? WHERE id = ?`),

    leadByMobile: db.prepare('SELECT * FROM leads WHERE mobile = ? ORDER BY id DESC LIMIT 1'),
    leadByEmail: db.prepare('SELECT * FROM leads WHERE email = ? ORDER BY id DESC LIMIT 1'),
    insertLead: db.prepare(`INSERT INTO leads (lead_code, full_name, email, mobile, mobile_verified_at, email_verified_at, source, created_at, updated_at)
      VALUES (@tmpCode, @fullName, @email, @mobile, @mobileVerifiedAt, @emailVerifiedAt, 'walk_in', @now, @now)`),
    setLeadCode: db.prepare('UPDATE leads SET lead_code = ? WHERE id = ?'),
    // New walk-in leads belong to the Reception login (the oldest active one, if ever several).
    receptionOwner: db.prepare(`SELECT id, full_name FROM users WHERE role = 'reception' AND is_active = 1 ORDER BY id LIMIT 1`),
    assignOwner: db.prepare('UPDATE leads SET assigned_to = ?, assigned_at = ? WHERE id = ?'),
    markMobileVerified: db.prepare('UPDATE leads SET mobile_verified_at = ?, updated_at = ? WHERE id = ? AND mobile_verified_at IS NULL'),
    markEmailVerified: db.prepare('UPDATE leads SET email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL'),
    openVisit: db.prepare(`SELECT id FROM visits WHERE lead_id = ? AND status IN ('waiting','with_counselor') AND checked_in_at > ?
                           ORDER BY id DESC LIMIT 1`).pluck(),
    insertVisit: db.prepare(`INSERT INTO visits
      (lead_id, submitted_name, submitted_email, submitted_mobile, verified_channel, checked_in_at, updated_at)
      VALUES (@leadId, @name, @email, @mobile, @channel, @now, @now)`),
  };

  function enforceSendCaps(destination, ip, now) {
    if (q.sendsGlobal.get(now - HOUR) >= otp.maxGlobalPerHour) {
      logger.error('OTP global hourly cap reached - possible abuse');
      throw new AppError(503, 'OTP_UNAVAILABLE', 'Verification is temporarily unavailable. Please ask the reception desk for help.');
    }
    if (q.sendsForIp.get(ip, now - HOUR) >= otp.maxPerIpPerHour) {
      throw tooMany('Too many verification codes have been requested from this device. Please ask the reception desk for help.');
    }
    if (q.sendsForDestination.get(destination, now - DAY) >= otp.maxPerDestinationPerDay) {
      throw tooMany('Too many verification codes have been sent to this contact today. Please ask the reception desk for help.');
    }
  }

  async function dispatch(channel, destination, code) {
    const send = messaging[channel];
    try {
      await send(destination, code);
    } catch (err) {
      logger.error(`OTP dispatch via ${channel} failed: ${err.message}`);
      throw new AppError(502, 'OTP_SEND_FAILED', 'We could not send the verification code. Please check your details or ask the reception desk for help.');
    }
  }

  function publicView(row, now) {
    return {
      requestId: row.id,
      channel: row.channel,
      destination: row.channel === 'sms' ? maskPhone(row.destination) : maskEmail(row.destination),
      expiresIn: Math.max(0, Math.ceil((row.expires_at - now) / 1000)),
      resendIn: Math.max(0, Math.ceil((row.last_sent_at + otp.resendCooldownSeconds * 1000 - now) / 1000)),
      resendsLeft: Math.max(0, otp.maxResends - (row.sends - 1)),
    };
  }

  async function start(input, ip) {
    if (!otp.channels.includes(input.channel)) throw badRequest('This verification method is not available.');
    const mobile = toE164(input.countryCode, input.mobile);
    if (!mobile) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Please correct the highlighted fields.', {
        fields: { mobile: 'Please enter a valid mobile number.' },
      });
    }

    const destination = input.channel === 'sms' ? mobile : input.email;
    const now = Date.now();
    enforceSendCaps(destination, ip, now);

    const id = randomToken(24);
    const code = newCode();
    db.transaction(() => {
      q.expirePendingForDestination.run(destination);
      q.insertRequest.run({
        id,
        fullName: input.fullName,
        email: input.email,
        mobile,
        channel: input.channel,
        destination,
        codeHash: hmac(config.appSecret, `${id}:${code}`),
        ip,
        now,
        expiresAt: now + otp.ttlSeconds * 1000,
      });
      // Recorded before dispatch so failed sends still count towards abuse caps.
      q.insertSend.run(id, destination, ip, now);
    })();

    try {
      await dispatch(input.channel, destination, code);
    } catch (err) {
      q.markExpired.run(id);
      throw err;
    }
    return publicView(q.getRequest.get(id), Date.now());
  }

  function loadPending(requestId, now) {
    const row = q.getRequest.get(requestId);
    if (!row || row.status !== 'pending' || now - row.created_at > REQUEST_LIFETIME_MS) {
      throw new AppError(410, 'SESSION_ENDED', 'This verification has ended. Please enter your details again.');
    }
    return row;
  }

  async function resend(requestId, ip) {
    const now = Date.now();
    const row = loadPending(requestId, now);
    if (row.sends - 1 >= otp.maxResends) {
      throw new AppError(429, 'RESEND_LIMIT', 'You have reached the maximum number of resends. Please enter your details again or ask the reception desk for help.');
    }
    const wait = row.last_sent_at + otp.resendCooldownSeconds * 1000 - now;
    if (wait > 0) {
      throw new AppError(429, 'RESEND_COOLDOWN', 'Please wait before requesting another code.', { retryAfter: Math.ceil(wait / 1000) });
    }
    enforceSendCaps(row.destination, ip, now);

    const code = newCode();
    db.transaction(() => {
      q.rotateCode.run({ id: row.id, codeHash: hmac(config.appSecret, `${row.id}:${code}`), now, expiresAt: now + otp.ttlSeconds * 1000 });
      q.insertSend.run(row.id, row.destination, ip, now);
    })();
    await dispatch(row.channel, row.destination, code);
    return publicView(q.getRequest.get(row.id), Date.now());
  }

  // Fully synchronous: no await between reading and writing the request, so concurrent
  // verify calls cannot race past the attempt counter.
  function verify(requestId, code, ip) {
    const now = Date.now();
    const row = loadPending(requestId, now);

    if (now > row.expires_at) {
      throw new AppError(400, 'OTP_EXPIRED', 'This code has expired. Please request a new one.', { canResend: row.sends - 1 < otp.maxResends });
    }

    const attempts = q.bumpAttempts.get(row.id);
    const valid = code.length === otp.length && safeEqualHex(hmac(config.appSecret, `${row.id}:${code}`), row.code_hash);

    if (!valid) {
      const remaining = otp.maxAttempts - attempts;
      if (remaining <= 0) {
        q.lockRequest.run(row.id);
        audit({ action: 'registration.otp_locked', details: { channel: row.channel }, ip });
        throw new AppError(400, 'OTP_LOCKED', 'Too many incorrect attempts. Please enter your details again to receive a new code.');
      }
      throw new AppError(400, 'OTP_INVALID', 'The code you entered is incorrect.', {
        attemptsRemaining: remaining,
        canResend: row.sends - 1 < otp.maxResends,
      });
    }

    const result = db.transaction(() => completeRegistration(row, now, ip))();
    events.publish('walkin', { visitId: result.visitId, leadId: result.leadId, isNew: result.isNewVisit }, { permission: 'walkins.view' });
    if (result.isNewVisit) {
      notifications.notifyHolders('walkins.view', {
        type: 'walkin.new', title: 'New walk-in',
        body: `${row.full_name} has registered and is waiting at the front desk.`, link: `/app/leads/${result.leadId}`,
      });
    }
    return { firstName: row.full_name.split(' ')[0] };
  }

  // Leads are matched only on the identifier the visitor just proved they own. Contact
  // details on an existing lead are never overwritten from the public form; what the
  // visitor typed is kept on the visit so reception can review differences.
  function completeRegistration(row, now, ip) {
    const viaSms = row.channel === 'sms';
    let lead = viaSms ? q.leadByMobile.get(row.mobile) : q.leadByEmail.get(row.email);
    let isNewLead = false;

    if (!lead) {
      const info = q.insertLead.run({
        tmpCode: `tmp-${row.id}`,
        fullName: row.full_name,
        email: row.email,
        mobile: row.mobile,
        mobileVerifiedAt: viaSms ? now : null,
        emailVerifiedAt: viaSms ? null : now,
        now,
      });
      const leadId = Number(info.lastInsertRowid);
      q.setLeadCode.run(`LD${String(leadId).padStart(6, '0')}`, leadId);
      lead = { id: leadId };
      isNewLead = true;
      const reception = q.receptionOwner.get();
      if (reception) {
        q.assignOwner.run(reception.id, now, leadId);
        audit({ action: 'lead.assigned', entityType: 'lead', entityId: leadId, details: { from: null, to: reception.full_name, auto: 'walk-in default' }, ip });
      }
    } else if (viaSms) {
      q.markMobileVerified.run(now, now, lead.id);
    } else {
      q.markEmailVerified.run(now, now, lead.id);
    }

    let visitId = q.openVisit.get(lead.id, now - 12 * HOUR);
    const isNewVisit = !visitId;
    if (isNewVisit) {
      visitId = Number(q.insertVisit.run({
        leadId: lead.id,
        name: row.full_name,
        email: row.email,
        mobile: row.mobile,
        channel: row.channel,
        now,
      }).lastInsertRowid);
    }

    q.markVerified.run(now, lead.id, row.id);
    audit({
      action: isNewLead ? 'lead.created' : 'lead.checked_in',
      entityType: 'lead',
      entityId: lead.id,
      details: { source: 'walk_in', verifiedVia: row.channel, visitId, duplicateCheckIn: !isNewVisit },
      ip,
    });
    return { leadId: lead.id, visitId, isNewVisit };
  }

  function formOptions() {
    return {
      channels: otp.channels,
      defaultCountryCode: config.defaultCountryCode,
      otpLength: otp.length,
      appName: config.appName,
      orgName: config.orgName,
      ...(devBypass ? { devBypassCode: devBypass } : {}),
    };
  }

  return { start, resend, verify, formOptions };
}

module.exports = { createRegistrationService };
