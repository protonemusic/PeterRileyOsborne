'use strict';

/**
 * Seasons and students' sports.
 *
 * Each sport is played in one or more of Fall / Winter / Spring. When those seasons run is one
 * school-wide setting (month and day, repeating every year), used to mark sports "in season".
 * A student can play several sports.
 */

const SEASONS = ['fall', 'winter', 'spring'];
const SEASON_LABELS = { fall: 'Fall', winter: 'Winter', spring: 'Spring' };
const DEFAULT_RANGES = {
  fall: { start: '08-17', end: '11-15' },
  winter: { start: '11-16', end: '03-01' },
  spring: { start: '03-02', end: '06-06' },
};
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function seasonRanges(db) {
  return { ...DEFAULT_RANGES, ...(getSetting(db, 'season_ranges') || {}) };
}

/** Validate and save { fall: { start: 'MM-DD', end: 'MM-DD' }, ... }. Returns an error message or null. */
function saveSeasonRanges(db, input) {
  const out = {};
  for (const s of SEASONS) {
    const r = input?.[s];
    if (!r || !MMDD.test(r.start) || !MMDD.test(r.end)) return `Please enter a start and end date for ${SEASON_LABELS[s]}`;
    out[s] = { start: r.start, end: r.end };
  }
  setSetting(db, 'season_ranges', out);
  return null;
}

/** Seasons that include the given local date (YYYY-MM-DD). A range may wrap past New Year. */
function currentSeasons(db, today) {
  const md = today.slice(5);
  const ranges = seasonRanges(db);
  return SEASONS.filter((s) => {
    const { start, end } = ranges[s];
    return start <= end ? md >= start && md <= end : md >= start || md <= end;
  });
}

function sportSeasons(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT sport_id, season FROM sport_seasons').all()) {
    if (!map.has(r.sport_id)) map.set(r.sport_id, []);
    map.get(r.sport_id).push(r.season);
  }
  for (const list of map.values()) list.sort((a, b) => SEASONS.indexOf(a) - SEASONS.indexOf(b));
  return map;
}

function setSportSeasons(db, sportId, seasons) {
  db.prepare('DELETE FROM sport_seasons WHERE sport_id = ?').run(sportId);
  const ins = db.prepare('INSERT OR IGNORE INTO sport_seasons (sport_id, season) VALUES (?, ?)');
  for (const s of seasons) if (SEASONS.includes(s)) ins.run(sportId, s);
}

/** Every sport with its seasons and whether it's in season today. */
function allSports(db, today) {
  const now = new Set(currentSeasons(db, today));
  const seasons = sportSeasons(db);
  return db.prepare('SELECT id, name, gender FROM sports ORDER BY name COLLATE NOCASE').all().map((s) => {
    const own = seasons.get(s.id) || [];
    return { ...s, seasons: own, inSeason: own.some((x) => now.has(x)) };
  });
}

// ---------- students' sports ----------
/** Map of studentId -> [{ id, name }] for the given students (or everyone). */
function sportsByStudent(db) {
  const map = new Map();
  for (const r of db.prepare(`SELECT ss.student_id AS studentId, sp.id, sp.name FROM student_sports ss
    JOIN sports sp ON sp.id = ss.sport_id ORDER BY sp.name COLLATE NOCASE`).all()) {
    if (!map.has(r.studentId)) map.set(r.studentId, []);
    map.get(r.studentId).push({ id: r.id, name: r.name });
  }
  return map;
}

function studentSports(db, studentId) {
  return db.prepare(`SELECT sp.id, sp.name FROM student_sports ss JOIN sports sp ON sp.id = ss.sport_id
    WHERE ss.student_id = ? ORDER BY sp.name COLLATE NOCASE`).all(studentId);
}

/** Replace a student's sports. students.sport_id keeps the first one for older code paths. */
function setStudentSports(db, studentId, sportIds) {
  db.prepare('DELETE FROM student_sports WHERE student_id = ?').run(studentId);
  const ins = db.prepare('INSERT OR IGNORE INTO student_sports (student_id, sport_id) VALUES (?, ?)');
  for (const id of sportIds) ins.run(studentId, id);
  db.prepare('UPDATE students SET sport_id = ? WHERE id = ?').run(sportIds[0] ?? null, studentId);
}

const sportNames = (list) => (list || []).map((s) => s.name).join(', ');

module.exports = {
  SEASONS, SEASON_LABELS, DEFAULT_RANGES, seasonRanges, saveSeasonRanges, currentSeasons, sportSeasons,
  setSportSeasons, allSports, sportsByStudent, studentSports, setStudentSports, sportNames, getSetting, setSetting,
};
