'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { parseImport, applyImport } = require('../src/importer');

const LIST = fs.readFileSync(path.join(__dirname, 'fixtures-sports.txt'), 'utf8');
const DATES = {
  fall: { label: 'Fall 2026', startDate: '2026-08-17', endDate: '2026-11-15' },
  winter: { label: 'Winter 2026–27', startDate: '2026-11-16', endDate: '2027-03-01' },
  spring: { label: 'Spring 2027', startDate: '2027-03-02', endDate: '2027-06-06' },
};

test('parses the school sports list', () => {
  const { sports, warnings } = parseImport(LIST);
  assert.deepEqual(warnings, []);
  assert.equal(sports.length, 16); // Cheerleading appears twice but is one sport
  const by = Object.fromEntries(sports.map((s) => [s.name, s]));
  assert.deepEqual(by.Cheerleading.seasons, ['fall', 'winter']);
  assert.deepEqual(by.Cheerleading.coaches, [{ name: 'Daylinn Brooks', email: '' }]);
  assert.deepEqual(by['Girls Volleyball'].coaches, [{ name: 'Anna Baltrusch', email: '' }]); // "Head Coach Anna"
  assert.deepEqual(by['Girls Basketball'].coaches, [{ name: 'Tyler Hollingsworth', email: '' }]); // "Head Coach:Tyler"
  assert.deepEqual(by.Golf.seasons, ['spring']);
  assert.deepEqual(by['Track and Field'].coaches, [{ name: 'Rachael Bailey', email: '' }]);
});

test('reads emails on coach lines and warns about stray coach lines', () => {
  const { sports, warnings } = parseImport(`Head Coach: Nobody
Spring
• Tennis
Head Coach: Amanda Lewis <ALewis@School.org>
Assistant Coach - Pat Kim, pkim@school.org`);
  assert.equal(warnings.length, 1);
  assert.deepEqual(sports[0].coaches, [
    { name: 'Amanda Lewis', email: 'alewis@school.org' },
    { name: 'Pat Kim', email: 'pkim@school.org' },
  ]);
});

test('import creates sports, seasons and coaches once', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO sports (name) VALUES ('football')").run(); // existing sport, different case

  const preview = applyImport(db, parseImport(LIST), DATES, { dryRun: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sports').get().n, 1, 'dry run writes nothing');
  assert.equal(preview.filter((r) => r.sportAdded).length, 15);

  applyImport(db, parseImport(LIST), DATES);
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.equal(count('sports'), 16);
  assert.equal(count('seasons'), 17); // Cheerleading has two
  assert.equal(count('coaches'), 16);
  const cheer = db.prepare(`SELECT se.label FROM seasons se JOIN sports s ON s.id = se.sport_id
    WHERE s.name = 'Cheerleading' ORDER BY se.start_date`).all().map((r) => r.label);
  assert.deepEqual(cheer, ['Fall 2026', 'Winter 2026–27']);

  // Importing again changes nothing.
  const again = applyImport(db, parseImport(LIST), DATES);
  assert.ok(again.every((r) => !r.sportAdded && !r.seasonsAdded.length && !r.coachesAdded.length));
  assert.equal(count('coaches'), 16);

  // A later list with emails fills them in.
  applyImport(db, parseImport('Tennis\nHead Coach: Amanda Lewis alewis@school.org'), DATES);
  assert.equal(db.prepare("SELECT email FROM coaches WHERE name = 'Amanda Lewis'").get().email, 'alewis@school.org');
  assert.equal(count('coaches'), 16);
});
