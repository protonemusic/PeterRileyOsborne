'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createUser } = require('../src/users');
const workouts = require('../src/workouts');
const stats = require('../src/stats');

// A program is just its two testing days here (Day 1 and Day 2 = final test).
function setupDb() {
  const db = openDb(':memory:');
  const sport = (name, gender) => Number(db.prepare('INSERT INTO sports (name, gender) VALUES (?, ?)').run(name, gender).lastInsertRowid);
  const ids = { football: sport('Football', 'boys'), soccer: sport('Girls Soccer', 'girls'), cheer: sport('Cheerleading', '') };
  const pid = workouts.saveProgram(db, { name: 'P', days: [] }, '2026-01-01T00:00:00Z');
  let n = 0;
  const student = (first, ...sportIds) => {
    const id = Number(db.prepare(`INSERT INTO students (first_name, last_name, sport_id, created_at)
      VALUES (?, ?, ?, '2026-01-01')`).run(first, `Last${++n}`, sportIds[0]).lastInsertRowid);
    for (const sid of sportIds) db.prepare('INSERT INTO student_sports (student_id, sport_id) VALUES (?, ?)').run(id, sid);
    return id;
  };
  // Log a test: weights for 6 reps (estimated 1RM = weight x 1.18).
  const logTest = (studentId, date, [bench, squat, dead], day = 1) => {
    const items = [...(day === 1 ? [{ done: true }] : []), ...[bench, squat, dead].map((w) => ({ sets: [{ weight: w == null ? '' : String(w), reps: '6' }] }))];
    db.prepare(`INSERT INTO student_workouts (student_id, program_id, day_number, assigned_date, results)
      VALUES (?, ?, ?, ?, ?)`).run(studentId, pid, day, date, JSON.stringify({ items }));
  };
  return { db, ids, student, logTest };
}

test('personal bests: first test fills Current only; later tests compare to the first', () => {
  const { db, ids, student, logTest } = setupDb();
  const ava = student('Ava', ids.soccer);
  const ben = student('Ben', ids.football);
  const cy = student('Cy', ids.football);
  student('Dee', ids.football); // never tested: not listed

  logTest(ava, '2026-09-01', [100, 150, 200]);
  logTest(ben, '2026-09-01', [200, 250, 300]);
  logTest(ben, '2026-10-30', [220, 260, 290], 2); // deadlift went down
  logTest(cy, '2026-09-02', [150, 200, 250]);
  logTest(cy, '2026-10-30', [140, 190, 240], 2); // everything went down

  const { rows, totals } = stats.personalBests(db);
  assert.deepEqual(rows.map((r) => r.name), ['Ava Last1', 'Ben Last2', 'Cy Last3']);

  const a = rows[0];
  assert.equal(a.startDate, '2026-09-01');
  assert.equal(a.recentDate, '2026-09-01');
  assert.deepEqual([a.current_bench, a.current_squat, a.current_deadlift], [118, 177, 236]);
  assert.deepEqual([a.starting_bench, a.starting_squat, a.starting_deadlift], [null, null, null]);
  assert.equal(a.currentCombined, 531);
  assert.equal(a.startingCombined, null);
  assert.equal(a.increase, null);
  assert.equal(a.percent, null);

  const b = rows[1];
  assert.equal(b.recentDate, '2026-10-30');
  assert.deepEqual([b.starting_bench, b.current_bench], [236, 260]);
  assert.deepEqual([b.starting_deadlift, b.current_deadlift], [354, 342]);
  assert.equal(b.startingCombined, 236 + 295 + 354);
  assert.equal(b.currentCombined, 260 + 307 + 342);
  assert.equal(b.increase, 24);
  assert.equal(b.percent, 2.7);

  const c = rows[2];
  assert.ok(c.increase < 0, 'increases can be negative');
  assert.ok(c.percent < 0);

  // Totals: sums of each column; percent = total increase / total starting.
  assert.equal(totals.students, 3);
  assert.equal(totals.current_bench, 118 + 260 + 165);
  assert.equal(totals.starting_bench, 236 + 177);
  assert.equal(totals.increase, b.increase + c.increase);
  assert.equal(totals.percent, Math.round(((b.increase + c.increase) / (b.startingCombined + c.startingCombined)) * 1000) / 10);

  // Filter by sport.
  const soccer = stats.personalBests(db, { sportId: ids.soccer });
  assert.deepEqual(soccer.rows.map((r) => r.name), ['Ava Last1']);
  assert.equal(soccer.totals.currentCombined, 531);
  assert.equal(soccer.totals.increase, null);
});

test('personal bests: first-ever vs most recent across several tests; a skipped lift uses the others', () => {
  const { db, ids, student, logTest } = setupDb();
  const s = student('Ava', ids.soccer);
  logTest(s, '2026-01-10', [100, 100, 100]);
  logTest(s, '2026-03-10', [110, null, 120], 2); // skipped squat
  logTest(s, '2026-05-10', [120, 130, null]);
  const [r] = stats.personalBests(db).rows;
  assert.equal(r.startDate, '2026-01-10');
  assert.equal(r.recentDate, '2026-05-10');
  assert.deepEqual([r.starting_bench, r.current_bench], [118, 142]);
  assert.deepEqual([r.starting_squat, r.current_squat], [118, 153]);
  assert.deepEqual([r.starting_deadlift, r.current_deadlift], [118, 142]); // most recent deadlift was March
});

test('hall of fame: top 5 boys and girls by combined best, with % increase per lift', () => {
  const { db, ids, student, logTest } = setupDb();
  for (let i = 0; i < 7; i++) {
    const b = student(`Boy${i}`, ids.football);
    logTest(b, '2026-09-01', [100 + i * 10, 200, 300]);
  }
  const g = student('Gina', ids.soccer);
  logTest(g, '2026-09-01', [100, 100, 100]);
  logTest(g, '2026-10-30', [120, 90, 150], 2);
  const cheer = student('Cam', ids.cheer); // sport not set to boys/girls
  logTest(cheer, '2026-09-01', [300, 300, 300]);

  const hof = stats.hallOfFame(db, { limit: 5 });
  assert.equal(hof.boys.length, 5);
  assert.deepEqual(hof.boys.map((r) => r.name.split(' ')[0]), ['Boy6', 'Boy5', 'Boy4', 'Boy3', 'Boy2']);
  assert.equal(hof.boys[0].benchPercent, null, 'one test: no increase yet');
  assert.equal(hof.girls.length, 1);
  const gina = hof.girls[0];
  assert.deepEqual([gina.benchMax, gina.squatMax, gina.deadliftMax], [142, 118, 177]); // best ever per lift
  assert.equal(gina.benchPercent, 20.3); // 118 -> 142 lb (rounded 1RMs)
  assert.equal(gina.squatPercent, 0, 'best squat was the first test');
  assert.equal(gina.deadliftPercent, 50);
  assert.equal(hof.notSet, 1);
});

test('sport gender is guessed from the name and can be changed; pages are staff-only', async () => {
  assert.equal(stats.guessGender('Girls Basketball'), 'girls');
  assert.equal(stats.guessGender('Boys Volleyball'), 'boys');
  assert.equal(stats.guessGender('Football'), '');

  const db = openDb(':memory:');
  await createUser(db, { email: 'admin@test.org', role: 'admin', password: 'admin-pass' });
  await createUser(db, { email: 'kiosk@test.org', role: 'kiosk', password: 'kiosk-pass' });
  const app = createApp({ db, mailer: { configured: false }, config: { timeZone: 'America/Los_Angeles', appName: 'WR' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/api/login', { email: 'admin@test.org', password: 'admin-pass' });
    const sp = (await call('POST', '/api/admin/sports', { name: 'Girls Soccer' })).body;
    assert.equal(sp.gender, 'girls');
    const fb = (await call('POST', '/api/admin/sports', { name: 'Football' })).body;
    assert.equal(fb.gender, '');
    assert.equal((await call('PUT', `/api/admin/sports/${fb.id}/gender`, { gender: 'boys' })).status, 200);
    assert.equal((await call('PUT', `/api/admin/sports/${fb.id}/gender`, { gender: 'other' })).status, 400);
    const list = (await call('GET', '/api/admin/sports')).body.sports;
    assert.deepEqual(list.map((s) => [s.name, s.gender]), [['Football', 'boys'], ['Girls Soccer', 'girls']]);
    assert.equal((await call('GET', '/api/admin/personal-bests')).status, 200);
    assert.equal((await call('GET', `/api/admin/personal-bests?sportId=${fb.id}`)).status, 200);
    assert.equal((await call('GET', '/hall-of-fame')).status, 200);

    await call('POST', '/api/login', { email: 'kiosk@test.org', password: 'kiosk-pass' });
    assert.equal((await call('GET', '/api/admin/personal-bests')).status, 403);
    assert.equal((await call('GET', '/api/admin/hall-of-fame')).status, 403);
    assert.equal((await call('GET', '/hall-of-fame')).status, 302);
  } finally { await new Promise((r) => server.close(r)); }
});

test('existing sports get boys/girls guessed when the column is added', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-')), 'db.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE sports (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)');
  old.exec("INSERT INTO sports (name) VALUES ('Girls Basketball'), ('Boys Soccer'), ('Wrestling')");
  old.close();
  const db = openDb(file);
  assert.deepEqual(db.prepare('SELECT name, gender FROM sports ORDER BY id').all().map((r) => [r.name, r.gender]),
    [['Girls Basketball', 'girls'], ['Boys Soccer', 'boys'], ['Wrestling', '']]);
  db.close();
});

test('CSV export: escaped fields, totals row, both Hall of Fame groups; staff-only', async () => {
  assert.equal(stats.csvField('Smith, Jr.', { text: true }), '"Smith, Jr."');
  assert.equal(stats.csvField('Say "hi"', { text: true }), '"Say ""hi"""');
  assert.equal(stats.csvField('=HYPERLINK("x")', { text: true }), `"'=HYPERLINK(""x"")"`);
  assert.equal(stats.csvField(-24), '-24', 'negative numbers stay numbers');
  assert.equal(stats.csvField(null), '');

  const { db, ids, student, logTest } = setupDb();
  const ben = student('Ben', ids.football);
  logTest(ben, '2026-09-01', [200, 250, 300]);
  logTest(ben, '2026-10-30', [220, 260, 290], 2);
  const g = student('Gina', ids.soccer);
  logTest(g, '2026-09-01', [100, 100, 100]);

  const pb = stats.personalBestsCsv(stats.personalBests(db));
  const lines = pb.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Student Name,Sport,Program Start Date,Most Recent Test Date,Starting Bench,Current Bench,Starting Squat,Current Squat,Starting Deadlift,Current Deadlift,Starting Combined Weight,Current Combined Weight,Weight Increase,Percent Increase (%)');
  assert.equal(lines[1], 'Ben Last1,Football,2026-09-01,2026-10-30,236,260,295,307,354,342,885,909,24,2.7');
  assert.equal(lines[2], 'Gina Last2,Girls Soccer,2026-09-01,2026-09-01,,118,,118,,118,,354,,');
  assert.match(lines[3], /^Totals \(2 students\),,,,236,378,/);

  const hof = stats.hallOfFameCsv(stats.hallOfFame(db));
  const hl = hof.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(hl[0], 'Group,Rank,Student Name,Sport,Bench Max,Squat Max,Deadlift Max,% Bench Increase,% Squat Increase,% Deadlift Increase');
  assert.match(hl[1], /^Boys,1,Ben Last1,Football,260,307,354,/);
  assert.match(hl[2], /^Girls,1,Gina Last2,Girls Soccer,118,118,118,,,$/);

  // Over HTTP: download headers, and kiosk accounts can't export.
  await createUser(db, { email: 'admin@test.org', role: 'admin', password: 'admin-pass' });
  await createUser(db, { email: 'kiosk@test.org', role: 'kiosk', password: 'kiosk-pass' });
  const app = createApp({ db, mailer: { configured: false }, config: { timeZone: 'America/Los_Angeles', appName: 'WR' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  })).headers.get('set-cookie').split(';')[0];
  try {
    let cookie = await login('admin@test.org', 'admin-pass');
    let res = await fetch(`${base}/api/admin/personal-bests.csv?sportId=${ids.soccer}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="personal-bests-girls-soccer-\d{4}-\d{2}-\d{2}\.csv"/);
    const body = await res.text();
    assert.ok(body.includes('Gina Last2') && !body.includes('Ben Last1'), 'export follows the sport filter');
    res = await fetch(`${base}/api/admin/hall-of-fame.csv`, { headers: { Cookie: cookie } });
    assert.match(res.headers.get('content-disposition'), /filename="hall-of-fame-/);
    cookie = await login('kiosk@test.org', 'kiosk-pass');
    assert.equal((await fetch(`${base}/api/admin/personal-bests.csv`, { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/hall-of-fame.csv`, { headers: { Cookie: cookie } })).status, 403);
  } finally { await new Promise((r) => server.close(r)); }
});

test('multi-sport students: listed under each sport; boys/girls only when their sports agree', () => {
  const { db, ids, student, logTest } = setupDb();
  const both = student('Bo', ids.football, ids.cheer); // boys + unset: counts as boys
  const mixed = student('Mix', ids.football, ids.soccer); // boys + girls: not set
  logTest(both, '2026-09-01', [100, 100, 100]);
  logTest(mixed, '2026-09-01', [100, 100, 100]);
  assert.deepEqual(stats.personalBests(db, { sportId: ids.cheer }).rows.map((r) => r.name), ['Bo Last1']);
  assert.deepEqual(stats.personalBests(db, { sportId: ids.football }).rows.map((r) => r.name), ['Bo Last1', 'Mix Last2']);
  assert.equal(stats.personalBests(db).rows[0].sportName, 'Cheerleading, Football');
  const hof = stats.hallOfFame(db);
  assert.deepEqual(hof.boys.map((r) => r.name), ['Bo Last1']);
  assert.equal(hof.notSet, 1);
});

test('the school logos (light and dark) are served without a login (it appears on the login page too)', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db, mailer: { configured: false }, config: { timeZone: 'America/Los_Angeles', appName: 'WR' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    for (const file of ['logo.png', 'logo-dark.png']) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/${file}`);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get('content-type'), 'image/png');
    }
  } finally { await new Promise((r) => server.close(r)); }
});
