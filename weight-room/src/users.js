'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

const ROLES = ['admin', 'kiosk'];
const MIN_PASSWORD = 8;

/** Session length by role. Kiosk iPads stay logged in for a long time. */
const SESSION_DAYS = { admin: 14, kiosk: 180 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Used when the email is unknown, so a failed login takes the same time either way.
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(password ?? ''), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual) && Boolean(stored);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email);
}

async function createUser(db, { email, name = '', role, password }) {
  const hash = await hashPassword(password);
  const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, name, role, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(normalizeEmail(email), name, role, hash, new Date().toISOString());
  return Number(lastInsertRowid);
}

/** Create the first admin from environment variables if there are no users yet. */
async function bootstrapAdmin(db, { email, password, name }) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return { created: false };
  if (!email || !password) {
    throw new Error('No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD so the first admin account can be created.');
  }
  if (!isValidEmail(normalizeEmail(email))) throw new Error('ADMIN_EMAIL is not a valid email address.');
  if (password.length < MIN_PASSWORD) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
  await createUser(db, { email, name: name || 'Admin', role: 'admin', password });
  return { created: true };
}

module.exports = {
  ROLES, MIN_PASSWORD, SESSION_DAYS,
  hashPassword, verifyPassword, normalizeEmail, isValidEmail, createUser, bootstrapAdmin,
};
