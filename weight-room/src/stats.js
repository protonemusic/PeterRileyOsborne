'use strict';

/**
 * Personal Bests and Hall of Fame, computed from the strength-testing days.
 * Every number is an estimated 1 rep max: the weight lifted for 6 reps × 1.18.
 */

const LIFTS = [
  { key: 'bench', name: 'bench press' },
  { key: 'squat', name: 'squat' },
  { key: 'deadlift', name: 'deadlift' },
];
const FACTOR = 1.18;

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;

/** Every logged test, oldest first, as { studentId, date, bench, squat, deadlift } (estimated 1RMs). */
function allTests(db) {
  const rows = db.prepare(`SELECT sw.student_id AS studentId, sw.assigned_date AS date, sw.results, d.items
    FROM student_workouts sw
    JOIN program_days d ON d.program_id = sw.program_id AND d.day_number = sw.day_number
    WHERE d.kind = 'test' AND sw.results IS NOT NULL
    ORDER BY sw.assigned_date, sw.id`).all();
  const tests = [];
  for (const row of rows) {
    const items = JSON.parse(row.items);
    const results = JSON.parse(row.results);
    const test = { studentId: row.studentId, date: row.date };
    let any = false;
    for (const lift of LIFTS) {
      const i = items.findIndex((it) => it.type !== 'check' && it.name.toLowerCase() === lift.name);
      const weight = i >= 0 ? num(results.items?.[i]?.sets?.[0]?.weight) : null;
      test[lift.key] = weight ? Math.round(weight * FACTOR) : null;
      if (weight) any = true;
    }
    if (any) tests.push(test);
  }
  return tests;
}

function students(db, sportId) {
  return db.prepare(`SELECT st.id, st.first_name || ' ' || st.last_name AS name, st.sport_id AS sportId,
      sp.name AS sportName, sp.gender
    FROM students st LEFT JOIN sports sp ON sp.id = st.sport_id
    ${sportId ? 'WHERE st.sport_id = ?' : ''}
    ORDER BY st.last_name COLLATE NOCASE, st.first_name COLLATE NOCASE`).all(...(sportId ? [sportId] : []));
}

function groupTests(db) {
  const byStudent = new Map();
  for (const t of allTests(db)) {
    if (!byStudent.has(t.studentId)) byStudent.set(t.studentId, []);
    byStudent.get(t.studentId).push(t);
  }
  return byStudent;
}

const sum = (values) => {
  const present = values.filter((v) => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

/**
 * One row per tested student. "Starting" is their first-ever test and "Current" their most
 * recent; with only one test so far, only Current is filled in. Increases can be negative.
 */
function personalBests(db, { sportId } = {}) {
  const byStudent = groupTests(db);
  const rows = [];
  for (const st of students(db, sportId)) {
    const tests = byStudent.get(st.id);
    if (!tests) continue;
    const row = {
      studentId: st.id, name: st.name, sportName: st.sportName,
      startDate: tests[0].date, recentDate: tests[tests.length - 1].date,
    };
    for (const { key } of LIFTS) {
      const withValue = tests.map((t, i) => ({ i, v: t[key] })).filter((x) => x.v != null);
      const first = withValue[0];
      const last = withValue[withValue.length - 1];
      row[`current_${key}`] = last ? last.v : null;
      row[`starting_${key}`] = first && last && first.i !== last.i ? first.v : null;
    }
    row.startingCombined = sum(LIFTS.map(({ key }) => row[`starting_${key}`]));
    row.currentCombined = sum(LIFTS.map(({ key }) => row[`current_${key}`]));
    row.increase = row.startingCombined != null && row.currentCombined != null
      ? row.currentCombined - row.startingCombined : null;
    row.percent = row.increase != null && row.startingCombined ? round1((row.increase / row.startingCombined) * 100) : null;
    rows.push(row);
  }

  // Totals for the rows shown. The percent is the total increase over the total starting weight
  // (adding up each student's percentage wouldn't mean anything).
  const totals = { students: rows.length };
  for (const col of ['starting_bench', 'current_bench', 'starting_squat', 'current_squat',
    'starting_deadlift', 'current_deadlift', 'startingCombined', 'currentCombined', 'increase']) {
    totals[col] = sum(rows.map((r) => r[col]));
  }
  const compared = rows.filter((r) => r.increase != null);
  const base = sum(compared.map((r) => r.startingCombined));
  totals.percent = base ? round1((sum(compared.map((r) => r.increase)) / base) * 100) : null;
  return { rows, totals };
}

/**
 * Top boys and girls (by their sport) by combined best: each lift's best-ever estimated 1RM,
 * with the % increase from their first test to that best.
 */
function hallOfFame(db, { limit = 5 } = {}) {
  const byStudent = groupTests(db);
  const out = { boys: [], girls: [], notSet: 0 };
  for (const st of students(db)) {
    const tests = byStudent.get(st.id);
    if (!tests) continue;
    if (st.gender !== 'boys' && st.gender !== 'girls') { out.notSet += 1; continue; }
    const row = { studentId: st.id, name: st.name, sportName: st.sportName };
    for (const { key } of LIFTS) {
      const values = tests.map((t) => t[key]).filter((v) => v != null);
      const best = values.length ? Math.max(...values) : null;
      row[`${key}Max`] = best;
      row[`${key}Percent`] = values.length > 1 && values[0] ? round1(((best - values[0]) / values[0]) * 100) : null;
    }
    row.combined = sum(LIFTS.map(({ key }) => row[`${key}Max`])) || 0;
    out[st.gender].push(row);
  }
  for (const g of ['boys', 'girls']) {
    out[g] = out[g].sort((a, b) => b.combined - a.combined || a.name.localeCompare(b.name)).slice(0, limit);
  }
  return out;
}

/** Best guess from a sport's name, used for new sports; admins can change it. */
function guessGender(name) {
  if (/\bgirls?\b|\bwomen'?s?\b/i.test(name)) return 'girls';
  if (/\bboys?\b|\bmen'?s?\b/i.test(name)) return 'boys';
  return '';
}

module.exports = { personalBests, hallOfFame, guessGender, FACTOR };
