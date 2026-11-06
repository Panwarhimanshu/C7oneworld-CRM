'use strict';

// Creates a Super Admin account and prints a one-time temporary password.
// Usage: npm run create-admin -- --name "Full Name" --email admin@example.com

const readline = require('node:readline/promises');
const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const { hashPassword } = require('../src/lib/crypto');
const { schemas, parse } = require('../src/lib/validate');
const { temporaryPassword } = require('../src/services/auth');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  let fullName = arg('name');
  let email = arg('email');

  if (!fullName || !email) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    fullName ||= await rl.question('Full name: ');
    email ||= await rl.question('Email address: ');
    rl.close();
  }

  let input;
  try {
    input = parse(schemas.userCreate, { fullName, email, role: 'super_admin' });
  } catch (err) {
    console.error('Invalid input:', Object.values(err.extra?.fields || {}).join(' ') || err.message);
    process.exit(1);
  }

  const db = openDatabase(config.databasePath);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) {
    console.error(`A user with email ${input.email} already exists.`);
    process.exit(1);
  }

  const password = temporaryPassword();
  const now = Date.now();
  const info = db.prepare(`INSERT INTO users (full_name, email, role, password_hash, must_change_password, created_at, updated_at)
    VALUES (?, ?, 'super_admin', ?, 1, ?, ?)`).run(input.fullName, input.email, await hashPassword(password), now, now);
  db.prepare(`INSERT INTO audit_log (action, entity_type, entity_id, details, created_at)
    VALUES ('user.created', 'user', ?, '{"role":"super_admin","via":"cli"}', ?)`).run(info.lastInsertRowid, now);
  db.close();

  console.log('\nSuper Admin created.');
  console.log(`  Email:              ${input.email}`);
  console.log(`  Temporary password: ${password}`);
  console.log('\nSign in at /login. You will be asked to set a new password immediately.');
}

main();
