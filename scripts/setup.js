'use strict';

// First-run setup: creates .env with a fresh APP_SECRET and initialises the database.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

if (fs.existsSync(envPath)) {
  console.log('.env already exists - leaving it unchanged.');
} else {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(envPath, template.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret}`), { mode: 0o600 });
  console.log('Created .env with a new APP_SECRET.');
}

const { config } = require('../src/config');
const { openDatabase } = require('../src/db');
const db = openDatabase(config.databasePath);
const admins = db.prepare(`SELECT COUNT(*) FROM users WHERE role = 'super_admin'`).pluck().get();
db.close();
console.log(`Database ready at ${path.relative(root, config.databasePath)}`);

if (admins === 0) {
  console.log('\nNo Super Admin exists yet. Create one with:');
  console.log('  npm run create-admin -- --name "Your Name" --email you@example.com');
}
