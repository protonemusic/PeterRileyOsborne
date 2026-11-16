'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createUser } = require('../src/users');
const { parseProgramFile, parseRows } = require('../src/programParser');
const workouts = require('../src/workouts');

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'football-program.pdf'));

async function setup() {
  const db = openDb(':memory:');
  await createUser(db, { email: 'admin@test.org', role: 'admin', password: 'admin-pass' });
  const clock = { now: new Date('2026-11-16T18:00:00Z') }; // Mon Nov 16, 10 AM Pacific
  const app = createApp({
    db,
    mailer: { configured: false, async send() {} },
    config: { timeZone: 'America/Los_Angeles', appName: 'Weight Room', now: () => clock.now, publicUrl: 'https://wr.example.org' },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(method, url, body, { raw, type } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': type || 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  // Anonymous fetch (a student's phone: no login cookie).
  async function phone(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  await call('POST', '/api/login', { email: 'admin@test.org', password: 'admin-pass' });
  const sport = (await call('POST', '/api/admin/sports', { name: 'Football' })).body;
  const student = async (first) => (await call('POST', '/api/signup', { firstName: first, lastName: 'Test', sportId: sport.id })).body.student;
  const day = (iso) => { clock.now = new Date(`${iso}T18:00:00Z`); };
  const signIn = async (s) => {
    let r = await call('POST', '/api/signin', { studentId: s.id });
    if (r.status === 401) { // the test clock jumped past the 14-day login
      await call('POST', '/api/login', { email: 'admin@test.org', password: 'admin-pass' });
      r = await call('POST', '/api/signin', { studentId: s.id });
    }
    return r.body;
  };
  const uploadPdf = (name = 'Football 8-Week') =>
    call('POST', `/api/admin/programs?name=${encodeURIComponent(name)}&filename=program.pdf`, null, { raw: PDF, type: 'application/octet-stream' });
  return { db, base, call, phone, student, day, signIn, uploadPdf, close: () => new Promise((r) => server.close(r)) };
}

test('parses all 40 workouts from the football PDF', async () => {
  const { days, warnings } = await parseProgramFile(PDF);
  assert.deepEqual(warnings, []);
  assert.equal(days.length, 40);
  assert.deepEqual(days.slice(0, 5).map((d) => `${d.weekday} ${d.kind}`),
    ['Monday weights', 'Tuesday run', 'Wednesday weights', 'Thursday run', 'Friday weights']);
  assert.deepEqual(days[0].items[0], { code: 'A1', name: 'High pull', priority: true, prescription: '5 x 3 (heavy)', sets: 5, reps: '3 (heavy)' });
  assert.deepEqual(days[1].items[0], { name: 'Form work', plan: '8 min' });
  assert.equal(days[0].weekTitle, 'Foundation (Mini Cycle 1)');
  assert.match(days[5].weekNote, /^Week 2 of this phase/);
  assert.equal(days[34].items.length, 8); // includes "Ladders | 3 passes"
  assert.deepEqual(days[34].items[1], { code: 'A2', name: 'Ladders', priority: false, prescription: '3 passes', sets: 1, reps: '3 passes' });
  assert.ok(days.every((d) => d.items.length >= 6));
});

test('parses Word-style rows (paragraphs and table rows)', () => {
  const { days } = parseRows([
    ['Week 1: Base'],
    ['Day 1: Lower', 'Sets x Reps', 'Set 1', 'Set 2'],
    ['Back squat*', '5 x 5'],
    ['Plank', '3 x 30 sec'],
    ['Day 2: Conditioning', 'Plan'],
    ['Sprints', '6 x 40 yd'],
    ['Some unrelated paragraph that ends the table'],
    ['Sled push', '4 x 20 yd'],
  ]);
  assert.equal(days.length, 2);
  assert.deepEqual(days[0].items.map((i) => [i.name, i.sets, i.priority]), [['Back squat', 5, true], ['Plank', 3, false]]);
  assert.deepEqual(days[1].items, [{ name: 'Sprints', plan: '6 x 40 yd' }]);
});

test('parses a Word (.docx) program', async () => {
  const { days } = await parseProgramFile(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-program.docx')));
  assert.deepEqual(days.map((d) => [d.weekday, d.kind, d.items.length]), [['Monday', 'weights', 2], ['Tuesday', 'run', 2]]);
  assert.equal(days[0].weekNote, 'Week 1 of this phase: learn the lifts.');
  assert.deepEqual(days[0].items[0], { code: 'A1', name: 'Back squat', priority: true, prescription: '5 x 5', sets: 5, reps: '5' });
  assert.deepEqual(days[1].items[1], { name: 'Shuttle (timed)', plan: '4 reps' });
});

test('rejects files that are not PDF or Word', async () => {
  const t = await setup();
  try {
    const r = await t.call('POST', '/api/admin/programs/preview', null, { raw: Buffer.from('hello'), type: 'application/octet-stream' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /PDF or a Word/);
  } finally { await t.close(); }
});

test('no program uploaded: sign-in works without a workout', async () => {
  const t = await setup();
  try {
    const s = await t.student('Ava');
    const r = await t.signIn(s);
    assert.deepEqual(r.workout, { status: 'none' });
    assert.equal(r.qrSvg, undefined);
  } finally { await t.close(); }
});

test('preview and upload a program', async () => {
  const t = await setup();
  try {
    const preview = await t.call('POST', '/api/admin/programs/preview', null, { raw: PDF, type: 'application/octet-stream' });
    assert.equal(preview.body.days.length, 40);
    assert.equal(preview.body.days[0].label, 'Week 1 · Monday: Weights');
    assert.equal((await t.call('GET', '/api/admin/programs')).body.programs.length, 0, 'preview saves nothing');
    assert.equal((await t.uploadPdf('')).status, 400, 'name required');
    const r = await t.uploadPdf();
    assert.equal(r.status, 201);
    const list = (await t.call('GET', '/api/admin/programs')).body.programs;
    assert.deepEqual(list.map((p) => [p.name, p.totalDays, p.active]), [['Football 8-Week', 40, true]]);
  } finally { await t.close(); }
});

test('each sign-in gives the next workout, once per day, with a QR link', async () => {
  const t = await setup();
  try {
    await t.uploadPdf();
    const s = await t.student('Ava');
    let r = await t.signIn(s);
    assert.equal(r.workout.status, 'assigned');
    assert.equal(r.workout.dayNumber, 1);
    assert.equal(r.workout.totalDays, 40);
    assert.equal(r.workout.label, 'Week 1 · Monday: Weights');
    assert.match(r.dashboardUrl, /^https:\/\/wr\.example\.org\/w\/[A-Za-z0-9_-]{24}$/);
    assert.match(r.qrSvg, /^<svg/);

    r = await t.signIn(s); // same day again
    assert.equal(r.alreadySignedIn, true);
    assert.equal(r.workout.dayNumber, 1);

    t.day('2026-11-17');
    assert.equal((await t.signIn(s)).workout.dayNumber, 2);
    t.day('2026-11-19'); // skipped a day the room was closed: no penalty
    const r3 = await t.signIn(s);
    assert.equal(r3.workout.dayNumber, 3);
    assert.equal(r3.workout.label, 'Week 1 · Wednesday: Weights');
    assert.equal(r3.dashboardUrl, r.dashboardUrl, 'same link every time');
  } finally { await t.close(); }
});

test('missing more than 5 weight room days starts over at Day 1', async () => {
  const t = await setup();
  try {
    await t.uploadPdf();
    const ava = await t.student('Ava');
    const ben = await t.student('Ben');
    t.day('2026-11-16');
    await t.signIn(ava); // Day 1
    t.day('2026-11-17');
    await t.signIn(ava); // Day 2

    // Ben comes in on 5 days Ava misses (weekend in between doesn't count).
    for (const d of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24']) { t.day(d); await t.signIn(ben); }
    t.day('2026-11-25');
    let r = await t.signIn(ava);
    assert.equal(r.workout.dayNumber, 3, 'missing exactly 5 days is OK');
    assert.equal(r.workout.restarted, false);

    for (const d of ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-07']) { t.day(d); await t.signIn(ben); }
    t.day('2026-12-08');
    r = await t.signIn(ava);
    assert.equal(r.workout.dayNumber, 1, 'missing 6 days starts over');
    assert.equal(r.workout.restarted, true);
    t.day('2026-12-09');
    assert.equal((await t.signIn(ava)).workout.dayNumber, 2);
  } finally { await t.close(); }
});

test('after the last day the program is complete', async () => {
  const t = await setup();
  try {
    workouts.saveProgram(t.db, {
      name: 'Two day', days: [
        { dayNumber: 1, week: 1, weekday: 'Monday', title: 'Lift', kind: 'weights', items: [{ name: 'Squat', sets: 2, reps: '5', prescription: '2 x 5' }] },
        { dayNumber: 2, week: 1, weekday: 'Tuesday', title: 'Run', kind: 'run', items: [{ name: 'Sprints', plan: '4 x 20 yd' }] },
      ],
    }, new Date().toISOString());
    const s = await t.student('Ava');
    t.day('2026-11-16'); await t.signIn(s);
    t.day('2026-11-17'); assert.equal((await t.signIn(s)).workout.dayNumber, 2);
    t.day('2026-11-18');
    const r = await t.signIn(s);
    assert.equal(r.workout.status, 'complete');
    assert.ok(r.qrSvg, 'still gets a link to their history');
    t.day('2026-12-30'); // even after a long break
    assert.equal((await t.signIn(s)).workout.status, 'complete');
    const token = r.dashboardUrl.split('/w/')[1];
    assert.equal((await t.phone('GET', `/api/w/${token}`)).body.complete, true);
  } finally { await t.close(); }
});

test('a new program starts everyone at Day 1', async () => {
  const t = await setup();
  try {
    await t.uploadPdf('Program A');
    const s = await t.student('Ava');
    t.day('2026-11-16'); await t.signIn(s);
    t.day('2026-11-17'); await t.signIn(s);
    await t.uploadPdf('Program B');
    t.day('2026-11-18');
    assert.equal((await t.signIn(s)).workout.dayNumber, 1);
  } finally { await t.close(); }
});

test('student dashboard: view, log weights and reps, see last time', async () => {
  const t = await setup();
  try {
    await t.uploadPdf();
    const s = await t.student('Ava');
    t.day('2026-11-16');
    const first = await t.signIn(s);
    const token = first.dashboardUrl.split('/w/')[1];

    // No login needed on the phone; a bad token is a 404.
    assert.equal((await t.phone('GET', '/api/w/not-a-real-token-123456')).status, 404);
    let dash = (await t.phone('GET', `/api/w/${token}`)).body;
    assert.deepEqual(dash.student, { firstName: 'Ava', lastName: 'Test', sportName: 'Football' });
    assert.equal(dash.workouts.length, 1);
    const w1 = dash.workouts[0];

    let detail = (await t.phone('GET', `/api/w/${token}/workouts/${w1.id}`)).body.workout;
    assert.equal(detail.kind, 'weights');
    assert.equal(detail.items[0].name, 'High pull');
    assert.equal(detail.results.items[0].sets.length, 5);

    const results = { items: detail.items.map((it) => ({ sets: Array.from({ length: it.sets }, () => ({ weight: '95', reps: '3' })) })), notes: 'felt good' };
    assert.equal((await t.phone('PUT', `/api/w/${token}/workouts/${w1.id}`, { results, completed: true })).status, 200);
    detail = (await t.phone('GET', `/api/w/${token}/workouts/${w1.id}`)).body.workout;
    assert.equal(detail.completed, true);
    assert.equal(detail.results.notes, 'felt good');
    assert.deepEqual(detail.results.items[0].sets[0], { weight: '95', reps: '3' });

    // Week 2 Monday repeats High pull: shows what they did last time.
    for (const d of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23']) { t.day(d); await t.signIn(s); }
    dash = (await t.phone('GET', `/api/w/${token}`)).body;
    assert.equal(dash.workouts[0].dayNumber, 6);
    detail = (await t.phone('GET', `/api/w/${token}/workouts/${dash.workouts[0].id}`)).body.workout;
    assert.equal(detail.items[0].name, 'High pull');
    assert.equal(detail.items[0].lastTime, '95 × 3, 95 × 3, 95 × 3, 95 × 3, 95 × 3');

    // Running day: done / result / notes.
    const run = dash.workouts.find((w) => w.dayNumber === 2);
    const runResults = { items: [{ done: true, result: '', notes: '' }, { done: true, result: '5.2s' }] };
    await t.phone('PUT', `/api/w/${token}/workouts/${run.id}`, { results: runResults });
    detail = (await t.phone('GET', `/api/w/${token}/workouts/${run.id}`)).body.workout;
    assert.equal(detail.kind, 'run');
    assert.deepEqual(detail.results.items[1], { done: true, result: '5.2s', notes: '' });
    assert.equal(detail.completed, false);

    // Another student's token can't open this workout.
    const ben = await t.student('Ben');
    const benToken = (await t.signIn(ben)).dashboardUrl.split('/w/')[1];
    assert.equal((await t.phone('GET', `/api/w/${benToken}/workouts/${w1.id}`)).status, 404);
    assert.equal((await t.phone('PUT', `/api/w/${benToken}/workouts/${w1.id}`, { results: {} })).status, 404);
  } finally { await t.close(); }
});

test('admin sees progress, can reset a link; removing a sign-in removes its workout', async () => {
  const t = await setup();
  try {
    await t.uploadPdf();
    const s = await t.student('Ava');
    const r = await t.signIn(s);
    let list = (await t.call('GET', '/api/admin/students')).body.students;
    assert.equal(list[0].workout, 'Day 1 of 40');

    const reset = (await t.call('POST', `/api/admin/students/${s.id}/workout-link`, { reset: true })).body;
    assert.notEqual(reset.url, r.dashboardUrl);
    assert.equal((await t.phone('GET', `/api/w/${r.dashboardUrl.split('/w/')[1]}`)).status, 404, 'old link stops working');
    assert.equal((await t.phone('GET', `/api/w/${reset.url.split('/w/')[1]}`)).status, 200);

    await t.call('DELETE', `/api/admin/signins/${r.signInId}`);
    list = (await t.call('GET', '/api/admin/students')).body.students;
    assert.equal(list[0].workout, 'Not started');
  } finally { await t.close(); }
});

test('existing databases get the new student column', () => {
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-')), 'db.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE students (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    sport_id INTEGER, created_at TEXT NOT NULL)`);
  old.exec("INSERT INTO students (first_name, last_name, created_at) VALUES ('Old', 'Student', '2026-01-01')");
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT workout_token FROM students').get().workout_token, null);
  assert.ok(workouts.ensureToken(db, 1));
  db.close();
});
