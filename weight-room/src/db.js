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

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'kiosk')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS program_days (
  id          INTEGER PRIMARY KEY,
  program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  day_number  INTEGER NOT NULL,
  week        INTEGER,
  week_title  TEXT NOT NULL DEFAULT '',
  week_note   TEXT NOT NULL DEFAULT '',
  weekday     TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,             -- weights | run | other
  items       TEXT NOT NULL,             -- JSON array
  UNIQUE (program_id, day_number)
);

-- One row per student per weight room day: the workout they were given and what they logged.
CREATE TABLE IF NOT EXISTS student_workouts (
  id            INTEGER PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id    INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  sign_in_id    INTEGER REFERENCES sign_ins(id) ON DELETE CASCADE,
  day_number    INTEGER NOT NULL,
  assigned_date TEXT NOT NULL,           -- local YYYY-MM-DD
  restarted     INTEGER NOT NULL DEFAULT 0,
  results       TEXT,                    -- JSON
  completed_at  TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_student_workouts ON student_workouts(student_id, assigned_date);

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
  migrate(db);
  return db;
}

/** Changes to tables that already exist in older databases. */
function migrate(db) {
  const studentCols = db.prepare('PRAGMA table_info(students)').all().map((c) => c.name);
  if (!studentCols.includes('workout_token')) {
    db.exec('ALTER TABLE students ADD COLUMN workout_token TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_token ON students(workout_token)');
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
