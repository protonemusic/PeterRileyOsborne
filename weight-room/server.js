'use strict';

const path = require('node:path');

// Load .env if present (Node 22.13+ built-in).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const { openDb } = require('./src/db');
const { createMailer } = require('./src/mailer');
const { createApp } = require('./src/app');
const { bootstrapAdmin } = require('./src/users');

const env = process.env;

async function main() {
  const db = openDb(env.DATABASE_FILE || path.join(__dirname, 'data', 'weight-room.db'));
  const boot = await bootstrapAdmin(db, { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME });
  if (boot.created) console.log(`Created the first admin account for ${env.ADMIN_EMAIL}.`);
  const mailer = createMailer(env);
  const app = createApp({
    db,
    mailer,
    config: {
      timeZone: env.TIME_ZONE || 'America/Los_Angeles',
      appName: env.APP_NAME || 'Weight Room',
      secureCookies: env.SECURE_COOKIES === 'true',
      trustProxy: env.TRUST_PROXY === 'true',
      // Optional: the site's address for QR codes (otherwise taken from the request).
      publicUrl: env.PUBLIC_URL || '',
    },
  });

  const port = Number(env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Weight room app running at http://localhost:${port}`);
    console.log(`Admin: http://localhost:${port}/admin`);
    if (!mailer.configured) console.log('Email is not configured: "Notify Coaches" will only show a preview.');
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
