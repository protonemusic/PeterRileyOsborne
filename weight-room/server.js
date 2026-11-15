'use strict';

const path = require('node:path');

// Load .env if present (Node 22.13+ built-in).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const { openDb } = require('./src/db');
const { createMailer } = require('./src/mailer');
const { createApp } = require('./src/app');

const env = process.env;
if (!env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}

const db = openDb(env.DATABASE_FILE || path.join(__dirname, 'data', 'weight-room.db'));
const mailer = createMailer(env);
const app = createApp({
  db,
  mailer,
  config: {
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    timeZone: env.TIME_ZONE || 'America/Los_Angeles',
    appName: env.APP_NAME || 'Weight Room',
    secureCookies: env.SECURE_COOKIES === 'true',
  },
});

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  console.log(`Weight room app running at http://localhost:${port}`);
  console.log(`Admin: http://localhost:${port}/admin`);
  if (!mailer.configured) console.log('Email is not configured: "Notify Coaches" will only show a preview.');
});
