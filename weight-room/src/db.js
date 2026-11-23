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

-- A student can play several sports.
CREATE TABLE IF NOT EXISTS student_sports (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  sport_id   INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, sport_id)
);

-- The student's sports at the time of a sign-in; each sport's coaches are emailed once.
CREATE TABLE IF NOT EXISTS sign_in_sports (
  sign_in_id  INTEGER NOT NULL REFERENCES sign_ins(id) ON DELETE CASCADE,
  sport_id    INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  notified_at TEXT,
  PRIMARY KEY (sign_in_id, sport_id)
);
CREATE INDEX IF NOT EXISTS idx_sign_in_sports_pending ON sign_in_sports(notified_at);

-- Which of Fall / Winter / Spring each sport is played in.
CREATE TABLE IF NOT EXISTS sport_seasons (
  sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  season   TEXT NOT NULL CHECK (season IN ('fall', 'winter', 'spring')),
  PRIMARY KEY (sport_id, season)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
  migrateData(db);
  return db;
}

/** Changes to tables that already exist in older databases. */
function migrate(db) {
  const studentCols = db.prepare('PRAGMA table_info(students)').all().map((c) => c.name);
  if (!studentCols.includes('workout_token')) {
    db.exec('ALTER TABLE students ADD COLUMN workout_token TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_token ON students(workout_token)');

  // Boys/girls for each sport (for the Hall of Fame); existing sports get a guess from their name.
  const sportCols = db.prepare('PRAGMA table_info(sports)').all().map((c) => c.name);
  if (!sportCols.includes('gender')) {
    db.exec("ALTER TABLE sports ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
    const { guessGender } = require('./stats');
    const set = db.prepare('UPDATE sports SET gender = ? WHERE id = ?');
    for (const sp of db.prepare('SELECT id, name FROM sports').all()) set.run(guessGender(sp.name), sp.id);
  }
}

/** One-time data moves from the older single-sport / date-based-season layout. */
function migrateData(db) {
  const done = (key) => db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
  const mark = (key) => db.prepare("INSERT INTO settings (key, value) VALUES (?, 'true')").run(key);

  if (!done('migrated_student_sports')) {
    db.exec(`INSERT OR IGNORE INTO student_sports (student_id, sport_id)
      SELECT id, sport_id FROM students WHERE sport_id IS NOT NULL`);
    db.exec(`INSERT OR IGNORE INTO sign_in_sports (sign_in_id, sport_id, notified_at)
      SELECT id, sport_id, notified_at FROM sign_ins WHERE sport_id IS NOT NULL`);
    mark('migrated_student_sports');
  }

  if (!done('migrated_sport_seasons')) {
    // Name each dated season Fall/Winter/Spring from its label, or else from when it started.
    for (const se of db.prepare('SELECT sport_id, label, start_date FROM seasons').all()) {
      const named = (se.label.match(/fall|winter|spring/i) || [])[0];
      const month = Number(se.start_date.slice(5, 7));
      const season = named ? named.toLowerCase()
        : month >= 7 && month <= 10 ? 'fall' : month >= 11 || month <= 2 ? 'winter' : 'spring';
      db.prepare('INSERT OR IGNORE INTO sport_seasons (sport_id, season) VALUES (?, ?)').run(se.sport_id, season);
    }
    mark('migrated_sport_seasons');
  }
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
