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
      const r = i >= 0 ? results.items?.[i] : null;
      // The recorded 1 rep max; tests saved before it was stored are calculated the same way.
      const weight = num(r?.sets?.[0]?.weight);
      const max = num(r?.oneRepMax) ?? (weight ? Math.round(weight * FACTOR) : null);
      test[lift.key] = max ? Math.round(max) : null;
      if (max) any = true;
    }
    if (any) tests.push(test);
  }
  return tests;
}

/** Students with their sports (joined names) and boys/girls from those sports. */
function students(db, sportId) {
  const rows = db.prepare(`SELECT st.id, st.first_name || ' ' || st.last_name AS name FROM students st
    ${sportId ? 'WHERE EXISTS (SELECT 1 FROM student_sports ss WHERE ss.student_id = st.id AND ss.sport_id = ?)' : ''}
    ORDER BY st.last_name COLLATE NOCASE, st.first_name COLLATE NOCASE`).all(...(sportId ? [sportId] : []));
  const sportsOf = new Map();
  for (const r of db.prepare(`SELECT ss.student_id AS sid, sp.name, sp.gender FROM student_sports ss
    JOIN sports sp ON sp.id = ss.sport_id ORDER BY sp.name COLLATE NOCASE`).all()) {
    if (!sportsOf.has(r.sid)) sportsOf.set(r.sid, []);
    sportsOf.get(r.sid).push(r);
  }
  return rows.map((st) => {
    const list = sportsOf.get(st.id) || [];
    // Boys or girls when the student's sports that are set agree (coed/unset sports don't count).
    const genders = [...new Set(list.map((x) => x.gender).filter(Boolean))];
    return { ...st, sportName: list.map((x) => x.name).join(', '), gender: genders.length === 1 ? genders[0] : '' };
  });
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
  // notSet: tested students whose sports aren't set to boys or girls (or are set to both).
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

// ---------- CSV export ----------
/** One CSV field. Text that a spreadsheet would run as a formula (=, +, -, @) gets a leading '. */
function csvField(value, { text = false } = {}) {
  if (value == null) return '';
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvLine = (cells) => cells.map(([v, opts]) => csvField(v, opts)).join(',');
// Byte order mark so Excel reads names with accents correctly.
const csvDocument = (lines) => `﻿${lines.join('\r\n')}\r\n`;
const T = (v) => [v, { text: true }];
const N = (v) => [v];

function personalBestsCsv({ rows, totals }) {
  const header = ['Student Name', 'Sport', 'Program Start Date', 'Most Recent Test Date', 'Starting Bench', 'Current Bench',
    'Starting Squat', 'Current Squat', 'Starting Deadlift', 'Current Deadlift', 'Starting Combined Weight',
    'Current Combined Weight', 'Weight Increase', 'Percent Increase (%)'];
  const nums = (r) => ['starting_bench', 'current_bench', 'starting_squat', 'current_squat', 'starting_deadlift',
    'current_deadlift', 'startingCombined', 'currentCombined', 'increase', 'percent'].map((k) => N(r[k]));
  return csvDocument([
    csvLine(header.map(T)),
    ...rows.map((r) => csvLine([T(r.name), T(r.sportName), N(r.startDate), N(r.recentDate), ...nums(r)])),
    csvLine([T(`Totals (${totals.students} students)`), T(''), N(''), N(''), ...nums(totals)]),
  ]);
}

function hallOfFameCsv({ boys, girls }) {
  const header = ['Group', 'Rank', 'Student Name', 'Sport', 'Bench Max', 'Squat Max', 'Deadlift Max',
    '% Bench Increase', '% Squat Increase', '% Deadlift Increase'];
  const lines = [csvLine(header.map(T))];
  for (const [group, list] of [['Boys', boys], ['Girls', girls]]) {
    list.forEach((r, i) => lines.push(csvLine([T(group), N(i + 1), T(r.name), T(r.sportName), N(r.benchMax), N(r.squatMax),
      N(r.deadliftMax), N(r.benchPercent), N(r.squatPercent), N(r.deadliftPercent)])));
  }
  return csvDocument(lines);
}

module.exports = { personalBests, hallOfFame, guessGender, FACTOR, personalBestsCsv, hallOfFameCsv, csvField };
