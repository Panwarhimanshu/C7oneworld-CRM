'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && !process.env.C7_SKIP_ENV_FILE) {
  process.loadEnvFile(envFile);
}

const env = process.env;

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid value for ${name}: expected an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const isProduction = env.NODE_ENV === 'production';

const config = {
  root: ROOT,
  isProduction,
  isTest: env.NODE_ENV === 'test',
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  appSecret: env.APP_SECRET || '',
  appName: env.APP_NAME || 'C7oneworld',
  orgName: env.ORG_NAME || 'C7oneworld Solutions Private Limited',
  trustProxy: int('TRUST_PROXY', 0, { min: 0, max: 10 }),
  databasePath: path.resolve(ROOT, env.DATABASE_PATH || './data/c7one.db'),

  session: {
    idleMs: int('SESSION_IDLE_MINUTES', 30, { min: 5, max: 480 }) * 60_000,
    absoluteMs: int('SESSION_ABSOLUTE_HOURS', 12, { min: 1, max: 72 }) * 3_600_000,
    cookieName: isProduction ? '__Host-c7sid' : 'c7sid',
  },

  auth: {
    maxFailedAttempts: 5,
    lockoutMinutes: 15,
    minPasswordLength: 12,
  },

  otp: {
    length: int('OTP_LENGTH', 6, { min: 4, max: 8 }),
    ttlSeconds: int('OTP_TTL_SECONDS', 300, { min: 60, max: 900 }),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5, { min: 1, max: 10 }),
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 30, { min: 10, max: 300 }),
    maxResends: int('OTP_MAX_RESENDS', 3, { min: 0, max: 10 }),
    maxPerDestinationPerDay: int('OTP_MAX_PER_DESTINATION_PER_DAY', 8, { min: 1, max: 100 }),
    maxPerIpPerHour: int('OTP_MAX_PER_IP_PER_HOUR', 15, { min: 1, max: 1000 }),
    maxGlobalPerHour: int('OTP_MAX_GLOBAL_PER_HOUR', 300, { min: 1, max: 100000 }),
    channels: (env.OTP_CHANNELS || 'sms,email')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter((c) => c === 'sms' || c === 'email'),
    // Development only: every OTP becomes this fixed code. Refused in production.
    devBypassCode: (env.OTP_DEV_BYPASS_CODE || '').trim(),
  },

  defaultCountryCode: (env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91',

  sms: {
    provider: (env.SMS_PROVIDER || 'console').toLowerCase(),
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM_NUMBER || '',
    },
    msg91: {
      authKey: env.MSG91_AUTH_KEY || '',
      templateId: env.MSG91_TEMPLATE_ID || '',
    },
  },

  email: {
    provider: (env.EMAIL_PROVIDER || 'console').toLowerCase(),
    from: env.EMAIL_FROM || 'C7one <no-reply@example.com>',
    smtp: {
      host: env.SMTP_HOST || '',
      port: int('SMTP_PORT', 587, { min: 1, max: 65535 }),
      secure: bool('SMTP_SECURE', false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    },
  },
};

function assertConfig() {
  const problems = [];
  if (!/^[0-9a-f]{64,}$/i.test(config.appSecret)) {
    problems.push('APP_SECRET must be at least 64 hex characters. Run `npm run setup` to generate one.');
  }
  const bypass = config.otp.devBypassCode;
  if (bypass && !new RegExp(`^\\d{${config.otp.length}}$`).test(bypass)) {
    problems.push(`OTP_DEV_BYPASS_CODE must be exactly ${config.otp.length} digits.`);
  }
  if (config.otp.channels.length === 0) {
    problems.push('OTP_CHANNELS must include at least one of: sms, email');
  }
  if (isProduction) {
    if (bypass) {
      problems.push('OTP_DEV_BYPASS_CODE must not be set in production.');
    }
    if (config.sms.provider === 'console' && config.otp.channels.includes('sms')) {
      problems.push('SMS_PROVIDER=console is not allowed in production.');
    }
    if (config.email.provider === 'console' && config.otp.channels.includes('email')) {
      problems.push('EMAIL_PROVIDER=console is not allowed in production.');
    }
    if (!config.publicBaseUrl.startsWith('https://')) {
      problems.push('PUBLIC_BASE_URL must use https:// in production.');
    }
  }
  if (problems.length) {
    const err = new Error('Configuration error:\n  - ' + problems.join('\n  - '));
    err.code = 'E_CONFIG';
    throw err;
  }
}

module.exports = { config, assertConfig };
