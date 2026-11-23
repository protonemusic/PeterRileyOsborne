'use strict';

/**
 * Bulk import of sports, seasons and coaches from pasted text like:
 *
 *   FALL
 *   Football
 *   Head Coach: Chase Beach
 *   Girls Volleyball
 *   Head Coach Anna Baltrusch <anna@school.org>
 *   WINTER
 *   ...
 *
 * A season heading (Fall/Winter/Spring/Summer) applies to the sports under it.
 * "Coach" lines (Head Coach, Assistant Coach, Coach) attach to the sport above them
 * and may include an email address anywhere on the line.
 */

const SEASON_NAMES = ['fall', 'winter', 'spring', 'summer'];
const SEASON_RE = /^(fall|winter|spring|summer)(\s+season)?\s*:?$/i;
const COACH_RE = /^(?:(?:head|assistant|asst\.?)\s+)?coach(?:es)?\b\s*[:\-–]?\s*(.*)$/i;
const EMAIL_RE = /[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+/;

function clean(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Returns { sports: [{ name, seasons: ['fall', ...], coaches: [{ name, email }] }], warnings } */
function parseImport(text) {
  const sports = new Map(); // lowercased name -> entry
  const warnings = [];
  let season = null;
  let current = null;

  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = clean(raw.replace(/^[\s•*\-–]+/, ''));
    if (!line) return;

    const s = line.match(SEASON_RE);
    if (s) { season = s[1].toLowerCase(); current = null; return; }

    const c = line.match(COACH_RE);
    if (c) {
      if (!current) { warnings.push(`Line ${i + 1}: "${line}" has no sport above it, so it was skipped.`); return; }
      let rest = c[1];
      const emailMatch = rest.match(EMAIL_RE);
      const email = emailMatch ? emailMatch[0].toLowerCase() : '';
      if (emailMatch) rest = rest.replace(emailMatch[0], '');
      const name = clean(rest.replace(/[<>(),;]/g, ' ')).slice(0, 80);
      if (!name && !email) { warnings.push(`Line ${i + 1}: "${line}" has no coach name, so it was skipped.`); return; }
      const dup = current.coaches.some((x) => x.name.toLowerCase() === name.toLowerCase() && (x.email === email || !email || !x.email));
      if (!dup) current.coaches.push({ name, email });
      return;
    }

    if (line.length > 50) { warnings.push(`Line ${i + 1}: "${line.slice(0, 40)}…" is too long for a sport name, so it was skipped.`); current = null; return; }
    const key = line.toLowerCase();
    if (!sports.has(key)) sports.set(key, { name: line, seasons: [], coaches: [] });
    current = sports.get(key);
    if (season && !current.seasons.includes(season)) current.seasons.push(season);
  });

  return { sports: [...sports.values()], warnings };
}

/**
 * Apply a parsed import. Sports are matched by name (any capitalization) and never duplicated;
 * seasons (Fall/Winter/Spring) and coaches (by name) are only added if missing.
 * With dryRun, nothing is written. Returns a summary per sport.
 */
function applyImport(db, parsed, { dryRun = false } = {}) {
  const { guessGender } = require('./stats');
  const findSport = db.prepare('SELECT id, name FROM sports WHERE name = ? COLLATE NOCASE');
  const insertSport = db.prepare('INSERT INTO sports (name, gender) VALUES (?, ?)');
  const hasSeason = db.prepare('SELECT 1 FROM sport_seasons WHERE sport_id = ? AND season = ?');
  const insertSeason = db.prepare('INSERT OR IGNORE INTO sport_seasons (sport_id, season) VALUES (?, ?)');
  const findCoach = db.prepare('SELECT id, email FROM coaches WHERE sport_id = ? AND name = ? COLLATE NOCASE');
  const findCoachByEmail = db.prepare("SELECT id FROM coaches WHERE sport_id = ? AND email = ? COLLATE NOCASE AND email <> ''");
  const insertCoach = db.prepare('INSERT INTO coaches (sport_id, name, email) VALUES (?, ?, ?)');
  const updateEmail = db.prepare('UPDATE coaches SET email = ? WHERE id = ?');
  const LABEL = { fall: 'Fall', winter: 'Winter', spring: 'Spring', summer: 'Summer' };

  const summary = [];
  for (const sport of parsed.sports) {
    const row = { name: sport.name, sportAdded: false, seasonsAdded: [], coachesAdded: [], coachesUpdated: [] };
    let sportId = findSport.get(sport.name)?.id ?? null;
    if (!sportId) {
      row.sportAdded = true;
      if (!dryRun) sportId = Number(insertSport.run(sport.name, guessGender(sport.name)).lastInsertRowid);
    }
    for (const key of sport.seasons) {
      if (key === 'summer') continue; // only Fall, Winter and Spring are tracked
      if (sportId && hasSeason.get(sportId, key)) continue;
      row.seasonsAdded.push(LABEL[key]);
      if (!dryRun) insertSeason.run(sportId, key);
    }
    for (const c of sport.coaches) {
      const existing = sportId
        ? (c.name ? findCoach.get(sportId, c.name) : null) || (c.email ? findCoachByEmail.get(sportId, c.email) : null)
        : null;
      if (existing) {
        if (c.email && !existing.email) {
          row.coachesUpdated.push(c.name || c.email);
          if (!dryRun) updateEmail.run(c.email, existing.id);
        }
        continue;
      }
      row.coachesAdded.push(c.email ? `${c.name} <${c.email}>`.trim() : c.name);
      if (!dryRun) insertCoach.run(sportId, c.name, c.email);
    }
    summary.push(row);
  }
  return summary;
}

module.exports = { parseImport, applyImport, SEASON_NAMES };
