'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sports (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS seasons (
  id         INTEGER PRIMARY KEY,
  sport_id   INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  label      TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  end_date   TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS coaches (
  id       INTEGER PRIMARY KEY,
  sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  name     TEXT NOT NULL DEFAULT '',
  email    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  sport_id   INTEGER REFERENCES sports(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (first_name COLLATE NOCASE, last_name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS sign_ins (
  id           INTEGER PRIMARY KEY,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  sport_id     INTEGER REFERENCES sports(id) ON DELETE SET NULL, -- sport at time of sign-in
  signed_in_at TEXT NOT NULL,            -- ISO 8601 UTC
  notified_at  TEXT                      -- set once coaches have been emailed
);
CREATE INDEX IF NOT EXISTS idx_sign_ins_time ON sign_ins(signed_in_at);
CREATE INDEX IF NOT EXISTS idx_sign_ins_pending ON sign_ins(notified_at);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  sent_at       TEXT NOT NULL,
  sport_name    TEXT NOT NULL,
  recipients    TEXT NOT NULL,
  sign_in_count INTEGER NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
