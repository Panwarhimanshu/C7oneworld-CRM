'use strict';

const { config, assertConfig } = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const RETENTION = {
  // Unverified registration attempts hold personal data and are purged after a day.
  otpRequestsMs: 24 * 3_600_000,
  otpSendsMs: 7 * 24 * 3_600_000,
  notificationsMs: 90 * 24 * 3_600_000,
};

function main() {
  try {
    assertConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const db = openDatabase(config.databasePath);
  const { app, events } = createApp({ config, db });

  const housekeeping = () => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(now, now - config.session.idleMs);
    db.prepare(`DELETE FROM otp_requests WHERE status <> 'verified' AND created_at < ?`).run(now - RETENTION.otpRequestsMs);
    db.prepare('DELETE FROM otp_sends WHERE sent_at < ?').run(now - RETENTION.otpSendsMs);
    db.prepare('DELETE FROM notifications WHERE created_at < ?').run(now - RETENTION.notificationsMs);
  };
  housekeeping();
  const timer = setInterval(housekeeping, 15 * 60_000);
  timer.unref();

  const server = app.listen(config.port, () => {
    console.log(`${config.appName} running at ${config.publicBaseUrl} (${config.isProduction ? 'production' : 'development'})`);
    console.log(`  Walk-in registration: ${config.publicBaseUrl}/register`);
    console.log(`  Staff sign-in:        ${config.publicBaseUrl}/login`);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  const shutdown = () => {
    events.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
