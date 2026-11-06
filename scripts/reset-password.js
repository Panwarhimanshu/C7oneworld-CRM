'use strict';

// Issues a new one-time password for a login, from the server console. For recovering
// access when nobody can sign in to reset it from the Logins screen.
// Usage: npm run reset-password -- --email someone@example.com

const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const { hashPassword } = require('../src/lib/crypto');
const { temporaryPassword } = require('../src/services/auth');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = String(arg('email') || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run reset-password -- --email someone@example.com');
    process.exit(1);
  }

  const db = openDatabase(config.databasePath);
  const user = db.prepare('SELECT id, full_name, is_active FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No login found for ${email}.`);
    process.exit(1);
  }

  const password = temporaryPassword();
  const now = Date.now();
  const hash = await hashPassword(password);
  db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0,
      locked_until = NULL, updated_at = ? WHERE id = ?`).run(hash, now, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare(`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, created_at)
      VALUES (NULL, 'user.password_reset', 'user', ?, '{"via":"cli"}', ?)`).run(user.id, now);
  })();
  db.close();

  console.log(`\nPassword reset for ${user.full_name} (${email}).`);
  console.log(`  Temporary password: ${password}`);
  if (!user.is_active) console.log('  Note: this login is inactive and cannot sign in until reactivated.');
  console.log('\nSign in at /login. You will be asked to set a new password immediately.');
}

main();
