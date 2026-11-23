'use strict';

const crypto = require('node:crypto');
const { tx } = require('./db');
const { localDate } = require('./time');
const { label } = require('./programParser');

/** Missing more than this many weight room days in a row starts a student over at Day 1. */
const MAX_MISSED_DAYS = 5;

/** Warm-up: every day. */
const WARMUP = {
  name: 'Warm-up',
  plan: '5 min',
  steps: [
    'Easy Jog', 'High Knees', 'Butt Kicks', 'Walking Knee Hugs', 'Walking Lunge with Twist',
    "Frankenstein's", 'Lateral Shuffle', 'Inchworm to Spiderman', 'Arm Circles', 'Body Weight Squats',
  ],
};
/** Cool-down: every day. */
const COOLDOWN_STEPS = [
  'Hamstring Stretch', 'Half-kneeling hip flexor stretch', 'Figure-4 Glute Stretch', 'Butterflies',
  'Calf/Achilles Stretch', 'Cross-body shoulder stretch', "Child's Pose",
];
const ROUTINES = {
  weights: { warmup: WARMUP, cooldown: { name: 'Cool-down', plan: '3 min', steps: COOLDOWN_STEPS } },
  test: { warmup: WARMUP, cooldown: { name: 'Cool-down', plan: '3 min', steps: COOLDOWN_STEPS } },
  run: { warmup: WARMUP, cooldown: { name: 'Cool-down', plan: '4 min', steps: COOLDOWN_STEPS } },
};
const routineFor = (kind) => ROUTINES[kind] || { warmup: null, cooldown: null };

// ---------- strength testing (first and last day of every program) ----------
/** Estimated 1 rep max from a 6-rep set to failure: 6 reps is about 85% of a 1 rep max (x 1.18). */
const ONE_REP_MAX_FACTOR = 1.18;
const TEST_LIFTS = ['Bench Press', 'Squat', 'Deadlift'];

function testDay(first) {
  return {
    week: null,
    weekTitle: '',
    weekNote: 'Work up to a weight you can lift for 6 reps, then do 6 reps to failure. '
      + 'Your estimated 1 rep max is that weight × 1.18 (6 reps ≈ 85% of a 1 rep max).',
    weekday: '',
    title: first ? 'Orientation & Strength Testing' : 'Final Strength Testing',
    kind: 'test',
    items: [
      ...(first ? [{ type: 'check', name: 'Orientation completed', plan: 'Weight room rules, safety and how to use this page' }] : []),
      ...TEST_LIFTS.map((name) => ({ name, sets: 1, reps: '6 to failure', prescription: '6 reps to failure', test: true })),
    ],
  };
}

/** The uploaded days with a testing day added before the first and after the last. */
function withTestDays(days) {
  const middle = days.filter((d) => d.kind !== 'test');
  return [testDay(true), ...middle, testDay(false)].map((d, i) => ({ ...d, dayNumber: i + 1 }));
}

/** Programs saved before testing days existed get them added; everyone's place is kept. */
function addMissingTestDays(db) {
  const programs = db.prepare(`SELECT id FROM programs p WHERE NOT EXISTS
    (SELECT 1 FROM program_days d WHERE d.program_id = p.id AND d.kind = 'test')`).all();
  for (const { id } of programs) {
    tx(db, () => {
      // Shift every day up by one (via negative numbers to keep day numbers unique on the way).
      db.prepare('UPDATE program_days SET day_number = -day_number - 1 WHERE program_id = ?').run(id);
      db.prepare('UPDATE program_days SET day_number = -day_number WHERE program_id = ?').run(id);
      db.prepare('UPDATE student_workouts SET day_number = day_number + 1 WHERE program_id = ?').run(id);
      const last = db.prepare('SELECT MAX(day_number) AS n FROM program_days WHERE program_id = ?').get(id).n || 1;
      insertDay(db, id, { ...testDay(true), dayNumber: 1 });
      insertDay(db, id, { ...testDay(false), dayNumber: last + 1 });
    });
  }
  return programs.length;
}

function insertDay(db, programId, d) {
  db.prepare(`INSERT INTO program_days
    (program_id, day_number, week, week_title, week_note, weekday, title, kind, items)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(programId, d.dayNumber, d.week ?? null, d.weekTitle || '',
    d.weekNote || '', d.weekday || '', d.title || '', d.kind, JSON.stringify(d.items));
}

// ---------- programs ----------
/** Saves uploaded days (testing days are added here) as the new active program. */
function saveProgram(db, { name, filename, days }, nowIso) {
  days = withTestDays(days);
  return tx(db, () => {
    db.exec('UPDATE programs SET active = 0');
    const programId = Number(db.prepare('INSERT INTO programs (name, filename, created_at, active) VALUES (?, ?, ?, 1)')
      .run(name, filename || '', nowIso).lastInsertRowid);
    for (const d of days) insertDay(db, programId, d);
    return programId;
  });
}

function activeProgram(db) {
  return db.prepare(`SELECT p.id, p.name, p.filename, p.created_at AS createdAt,
      (SELECT COUNT(*) FROM program_days d WHERE d.program_id = p.id) AS totalDays
    FROM programs p WHERE p.active = 1`).get() || null;
}

function getProgramDay(db, programId, dayNumber) {
  const row = db.prepare(`SELECT day_number AS dayNumber, week, week_title AS weekTitle, week_note AS weekNote,
      weekday, title, kind, items FROM program_days WHERE program_id = ? AND day_number = ?`).get(programId, dayNumber);
  return row ? { ...row, items: JSON.parse(row.items) } : null;
}

// ---------- students ----------
function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function ensureToken(db, studentId) {
  const row = db.prepare('SELECT workout_token FROM students WHERE id = ?').get(studentId);
  if (row?.workout_token) return row.workout_token;
  const token = newToken();
  db.prepare('UPDATE students SET workout_token = ? WHERE id = ?').run(token, studentId);
  return token;
}

function resetToken(db, studentId) {
  const token = newToken();
  db.prepare('UPDATE students SET workout_token = ? WHERE id = ?').run(token, studentId);
  return token;
}

/** Number of days strictly between two local dates on which anyone signed in. */
function openDaysBetween(db, afterDate, beforeDate, tz) {
  const from = new Date(Date.parse(`${afterDate}T00:00:00Z`) - 36 * 3600 * 1000).toISOString();
  const to = new Date(Date.parse(`${beforeDate}T00:00:00Z`) + 36 * 3600 * 1000).toISOString();
  const days = new Set();
  for (const { signed_in_at: at } of db.prepare(
    'SELECT signed_in_at FROM sign_ins WHERE signed_in_at >= ? AND signed_in_at < ?',
  ).all(from, to)) {
    const d = localDate(new Date(at), tz);
    if (d > afterDate && d < beforeDate) days.add(d);
  }
  return days.size;
}

function summarize(db, row, program) {
  if (!row) return null;
  const day = getProgramDay(db, row.program_id, row.day_number);
  return {
    id: row.id,
    dayNumber: row.day_number,
    totalDays: program?.id === row.program_id ? program.totalDays
      : db.prepare('SELECT COUNT(*) AS n FROM program_days WHERE program_id = ?').get(row.program_id).n,
    label: day ? label(day) : `Day ${row.day_number}`,
    restarted: Boolean(row.restarted),
  };
}

/**
 * Called when a student signs in. Gives them today's workout (once per day):
 * Day 1 on their first visit, then the next day each visit; Day 1 again after missing
 * more than MAX_MISSED_DAYS weight room days; "complete" after the last day.
 * Returns { status: 'assigned' | 'complete' | 'none', workout }.
 */
function assignWorkout(db, { studentId, signInId, today, tz }) {
  const program = activeProgram(db);
  if (!program || !program.totalDays) return { status: 'none', workout: null };

  const todays = db.prepare(`SELECT * FROM student_workouts WHERE student_id = ? AND assigned_date = ?
    ORDER BY id DESC LIMIT 1`).get(studentId, today);
  if (todays) return { status: 'assigned', workout: summarize(db, todays, program) };

  const last = db.prepare(`SELECT * FROM student_workouts WHERE student_id = ? AND program_id = ?
    ORDER BY assigned_date DESC, id DESC LIMIT 1`).get(studentId, program.id);

  let dayNumber = 1;
  let restarted = false;
  if (last) {
    if (last.day_number >= program.totalDays) return { status: 'complete', workout: null, program };
    if (openDaysBetween(db, last.assigned_date, today, tz) > MAX_MISSED_DAYS) {
      restarted = true;
    } else {
      dayNumber = last.day_number + 1;
    }
  }
  const id = Number(db.prepare(`INSERT INTO student_workouts
    (student_id, program_id, sign_in_id, day_number, assigned_date, restarted) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(studentId, program.id, signInId ?? null, dayNumber, today, restarted ? 1 : 0).lastInsertRowid);
  return { status: 'assigned', workout: summarize(db, db.prepare('SELECT * FROM student_workouts WHERE id = ?').get(id), program) };
}

/** Where a student is in the active program, for the admin Students list. */
function progressFor(db, studentId) {
  const program = activeProgram(db);
  if (!program) return null;
  const last = db.prepare(`SELECT day_number FROM student_workouts WHERE student_id = ? AND program_id = ?
    ORDER BY assigned_date DESC, id DESC LIMIT 1`).get(studentId, program.id);
  if (!last) return 'Not started';
  return last.day_number >= program.totalDays ? 'Complete' : `Day ${last.day_number} of ${program.totalDays}`;
}

// ---------- logging results ----------
const str = (v, max) => (v == null ? '' : String(v).slice(0, max));

/** Keep only the expected shape, as short strings, for the given day. */
function cleanResults(day, input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const routine = routineFor(day.kind);
  const out = {
    notes: str(input?.notes, 1000),
    warmup: routine.warmup ? Boolean(input?.warmup) : false,
    cooldown: routine.cooldown ? Boolean(input?.cooldown) : false,
    items: [],
  };
  day.items.forEach((item, i) => {
    const r = items[i] || {};
    if (item.type === 'check') {
      out.items.push({ done: Boolean(r.done) });
    } else if (day.kind === 'weights' || day.kind === 'test') {
      const sets = Array.isArray(r.sets) ? r.sets : [];
      out.items.push({
        sets: Array.from({ length: item.sets }, (_, s) => ({
          weight: str(sets[s]?.weight, 12).trim(),
          reps: str(sets[s]?.reps, 12).trim(),
        })),
      });
    } else {
      out.items.push({ done: Boolean(r.done), result: str(r.result, 40).trim(), notes: str(r.notes, 200).trim() });
    }
  });
  return out;
}

function lastTimeFor(db, studentId, workoutId, names) {
  const want = new Map(names.map((n) => [n.toLowerCase(), null]));
  const rows = db.prepare(`SELECT sw.results, d.items, d.kind FROM student_workouts sw
    JOIN program_days d ON d.program_id = sw.program_id AND d.day_number = sw.day_number
    WHERE sw.student_id = ? AND sw.id <> ? AND sw.results IS NOT NULL AND d.kind IN ('weights', 'test')
    ORDER BY sw.assigned_date DESC, sw.id DESC LIMIT 60`).all(studentId, workoutId);
  for (const row of rows) {
    const items = JSON.parse(row.items);
    const results = JSON.parse(row.results);
    items.forEach((item, i) => {
      if (item.type === 'check') return;
      const key = item.name.toLowerCase();
      if (!want.has(key) || want.get(key)) return;
      const sets = (results.items?.[i]?.sets || []).filter((s) => s.weight || s.reps);
      if (sets.length) want.set(key, sets.map((s) => [s.weight, s.reps].filter(Boolean).join(' × ')).join(', '));
    });
  }
  return want;
}

function workoutDetail(db, studentId, workoutId, tz) {
  const row = db.prepare('SELECT * FROM student_workouts WHERE id = ? AND student_id = ?').get(workoutId, studentId);
  if (!row) return null;
  const day = getProgramDay(db, row.program_id, row.day_number);
  if (!day) return null;
  const results = row.results ? JSON.parse(row.results) : null;
  const lifts = day.items.filter((i) => i.type !== 'check').map((i) => i.name);
  const last = day.kind === 'weights' || day.kind === 'test' ? lastTimeFor(db, studentId, row.id, lifts) : new Map();
  const totalDays = db.prepare('SELECT COUNT(*) AS n FROM program_days WHERE program_id = ?').get(row.program_id).n;
  return {
    id: row.id,
    dayNumber: row.day_number,
    totalDays,
    date: row.assigned_date,
    restarted: Boolean(row.restarted),
    completed: Boolean(row.completed_at),
    label: label(day),
    weekTitle: day.weekTitle,
    weekNote: day.weekNote,
    kind: day.kind,
    ...routineFor(day.kind),
    oneRepMaxFactor: ONE_REP_MAX_FACTOR,
    items: day.items.map((item) => ({ ...item, lastTime: last.get(item.name.toLowerCase()) || null })),
    results: cleanResults(day, results || {}),
  };
}

function saveResults(db, studentId, workoutId, body, nowIso) {
  const row = db.prepare('SELECT * FROM student_workouts WHERE id = ? AND student_id = ?').get(workoutId, studentId);
  if (!row) return false;
  const day = getProgramDay(db, row.program_id, row.day_number);
  if (!day) return false;
  const results = cleanResults(day, body?.results || {});
  const completedAt = body?.completed === true ? (row.completed_at || nowIso)
    : body?.completed === false ? null : row.completed_at;
  db.prepare('UPDATE student_workouts SET results = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(results), completedAt, nowIso, row.id);
  return true;
}

function dashboard(db, token, today) {
  const student = db.prepare(`SELECT st.id, st.first_name AS firstName, st.last_name AS lastName,
      (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT sp.name FROM student_sports ss JOIN sports sp ON sp.id = ss.sport_id
        WHERE ss.student_id = st.id ORDER BY sp.name COLLATE NOCASE)) AS sportName
    FROM students st WHERE st.workout_token = ?`).get(token);
  if (!student) return null;
  const program = activeProgram(db);
  const rows = db.prepare(`SELECT sw.*, (SELECT COUNT(*) FROM program_days d WHERE d.program_id = sw.program_id) AS total
    FROM student_workouts sw WHERE sw.student_id = ? ORDER BY sw.assigned_date DESC, sw.id DESC LIMIT 200`).all(student.id);
  const workouts = rows.map((r) => {
    const day = getProgramDay(db, r.program_id, r.day_number);
    return {
      id: r.id, date: r.assigned_date, dayNumber: r.day_number, totalDays: r.total,
      label: day ? label(day) : `Day ${r.day_number}`, completed: Boolean(r.completed_at),
      restarted: Boolean(r.restarted), current: Boolean(program && r.program_id === program.id),
    };
  });
  const lastInProgram = program && rows.find((r) => r.program_id === program.id);
  return {
    student,
    program: program ? { name: program.name, totalDays: program.totalDays } : null,
    // Finished once the last day has been logged, or its day has passed.
    complete: Boolean(lastInProgram && lastInProgram.day_number >= program.totalDays
      && (lastInProgram.completed_at || lastInProgram.assigned_date < today)),
    workouts,
  };
}

module.exports = {
  MAX_MISSED_DAYS, ONE_REP_MAX_FACTOR, withTestDays, addMissingTestDays, saveProgram, activeProgram, getProgramDay, ensureToken, resetToken, openDaysBetween,
  assignWorkout, progressFor, workoutDetail, saveResults, dashboard,
};
