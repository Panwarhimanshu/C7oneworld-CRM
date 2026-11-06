'use strict';

const nodemailer = require('nodemailer');
const { maskPhone, maskEmail } = require('../lib/phone');

const TIMEOUT_MS = 10_000;

function otpText(config, code) {
  const minutes = Math.round(config.otp.ttlSeconds / 60);
  return `${code} is your ${config.appName} verification code. It is valid for ${minutes} minutes. Do not share this code with anyone.`;
}

function createSmsSender(config, logger) {
  const { provider, twilio, msg91 } = config.sms;

  if (provider === 'console') {
    return async (to, code) => {
      logger.warn(`[DEV ONLY] SMS OTP for ${maskPhone(to)}: ${code}`);
    };
  }

  if (provider === 'twilio') {
    if (!twilio.accountSid || !twilio.authToken || !twilio.from) throw new Error('Twilio credentials are incomplete.');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64');
    return async (to, code) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: twilio.from, Body: otpText(config, code) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
    };
  }

  if (provider === 'msg91') {
    if (!msg91.authKey || !msg91.templateId) throw new Error('MSG91 credentials are incomplete.');
    return async (to, code) => {
      const res = await fetch('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: { authkey: msg91.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          template_id: msg91.templateId,
          short_url: '0',
          recipients: [{ mobiles: to.replace('+', ''), otp: code }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.type === 'error') throw new Error(`MSG91 responded ${res.status}`);
    };
  }

  throw new Error(`Unknown SMS_PROVIDER "${provider}"`);
}

function createEmailSender(config, logger) {
  const { provider, smtp, from } = config.email;

  if (provider === 'console') {
    return async (to, code) => {
      logger.warn(`[DEV ONLY] Email OTP for ${maskEmail(to)}: ${code}`);
    };
  }

  if (provider === 'smtp') {
    if (!smtp.host) throw new Error('SMTP_HOST is required for EMAIL_PROVIDER=smtp.');
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return async (to, code) => {
      await transport.sendMail({
        from,
        to,
        subject: `${code} is your ${config.appName} verification code`,
        text: `${otpText(config, code)}\n\nIf you did not request this code, you can ignore this email.\n\n${config.orgName}`,
      });
    };
  }

  throw new Error(`Unknown EMAIL_PROVIDER "${provider}"`);
}

function createMessaging(config, logger) {
  const channels = config.otp.channels;
  return {
    sms: channels.includes('sms') ? createSmsSender(config, logger) : null,
    email: channels.includes('email') ? createEmailSender(config, logger) : null,
  };
}

module.exports = { createMessaging };
