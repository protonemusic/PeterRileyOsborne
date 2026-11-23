'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createUser } = require('../src/users');

// Start a server on a random port with an in-memory DB, a fake mailer and a controllable clock.
async function setup({ emailConfigured = true, failFor = [] } = {}) {
  const db = openDb(':memory:');
  await createUser(db, { email: 'admin@test.org', name: 'Ada Admin', role: 'admin', password: 'admin-pass' });
  await createUser(db, { email: 'staff@test.org', name: 'Sam Staff', role: 'staff', password: 'staff-pass' });
  await createUser(db, { email: 'kiosk@test.org', name: 'Door iPad', role: 'kiosk', password: 'kiosk-pass' });
  const sent = [];
  const mailer = {
    configured: emailConfigured,
    async send(msg) {
      if (failFor.some((s) => msg.subject.includes(s))) throw new Error('SMTP down');
      sent.push(msg);
    },
  };
  const clock = { now: new Date('2026-11-16T22:30:00Z') }; // 2:30 PM in Los Angeles
  const app = createApp({
    db,
    mailer,
    config: { timeZone: 'America/Los_Angeles', appName: 'Weight Room', now: () => clock.now },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function login(role = 'admin') {
    const r = await call('POST', '/api/login', { email: `${role}@test.org`, password: `${role}-pass` });
    assert.equal(r.status, 200);
    return r.body.user;
  }

  async function page(path) {
    const res = await fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, location: res.headers.get('location') };
  }

  return { db, sent, clock, call, login, page, logout: () => { cookie = ''; }, close: () => new Promise((r) => server.close(r)) };
}

async function seed(t) {
  await t.login();
  const football = (await t.call('POST', '/api/admin/sports', { name: 'Football' })).body;
  const track = (await t.call('POST', '/api/admin/sports', { name: 'Track' })).body;
  // School season dates for these tests: Fall runs to Nov 30, Spring from Mar 1.
  await t.call('PUT', '/api/admin/season-dates', { ranges: {
    fall: { start: '08-15', end: '11-30' }, winter: { start: '12-01', end: '02-28' }, spring: { start: '03-01', end: '05-31' } } });
  await t.call('PUT', `/api/admin/sports/${football.id}/seasons`, { seasons: ['fall'] });
  await t.call('PUT', `/api/admin/sports/${track.id}/seasons`, { seasons: ['spring'] });
  await t.call('POST', `/api/admin/sports/${football.id}/coaches`, { name: 'Coach Smith', email: 'smith@school.org' });
  return { football, track };
}

test('everything requires login', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/api/admin/sports')).status, 401);
    assert.equal((await t.call('GET', '/api/sports')).status, 401);
    assert.equal((await t.call('GET', '/api/students/search?q=a')).status, 401);
    assert.equal((await t.call('POST', '/api/signin', { studentId: 1 })).status, 401);
    assert.deepEqual(await t.page('/'), { status: 302, location: '/login?next=%2F' });
    assert.deepEqual(await t.page('/admin'), { status: 302, location: '/login?next=%2Fadmin' });
    assert.equal((await t.page('/login')).status, 200);
    assert.equal((await t.page('/styles.css')).status, 200);
    assert.equal((await t.page('/index.html')).status, 404);

    assert.equal((await t.call('POST', '/api/login', { email: 'admin@test.org', password: 'nope' })).status, 401);
    assert.equal((await t.call('POST', '/api/login', { email: 'nobody@test.org', password: 'admin-pass' })).status, 401);
    const user = await t.login();
    assert.equal(user.role, 'admin');
    assert.equal((await t.call('GET', '/api/admin/sports')).status, 200);
    assert.equal((await t.page('/admin')).status, 200);
    await t.call('POST', '/api/logout');
    assert.equal((await t.call('GET', '/api/admin/sports')).status, 401);
  } finally { await t.close(); }
});

test('repeated failed logins are blocked', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 10; i++) await t.call('POST', '/api/login', { email: 'admin@test.org', password: 'wrong' });
    const r = await t.call('POST', '/api/login', { email: 'admin@test.org', password: 'admin-pass' });
    assert.equal(r.status, 429);
  } finally { await t.close(); }
});

test('kiosk accounts only reach the sign-in screen', async () => {
  const t = await setup();
  try {
    assert.equal((await t.login('kiosk')).role, 'kiosk');
    assert.equal((await t.page('/')).status, 200);
    assert.equal((await t.page('/admin')).status, 302);
    assert.equal((await t.call('GET', '/api/sports')).status, 200);
    assert.equal((await t.call('GET', '/api/admin/sports')).status, 403);
    assert.equal((await t.call('POST', '/api/admin/notify')).status, 403);
  } finally { await t.close(); }
});

test('staff can run the admin page but not manage users', async () => {
  const t = await setup();
  try {
    await t.login('staff');
    assert.equal((await t.page('/admin')).status, 200);
    assert.equal((await t.page('/')).status, 200);
    assert.equal((await t.call('GET', '/api/admin/sports')).status, 200);
    assert.equal((await t.call('GET', '/api/admin/notify/preview')).status, 200);
    assert.equal((await t.call('GET', '/api/admin/users')).status, 403);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'x@test.org', role: 'admin', password: '12345678' })).status, 403);
  } finally { await t.close(); }
});

test('admins manage users', async () => {
  const t = await setup();
  try {
    const me = await t.login();
    let r = await t.call('POST', '/api/admin/users', { name: 'Coach Two', email: 'Two@Test.org ', role: 'admin', password: 'two-pass-123' });
    assert.equal(r.status, 201);
    const id = r.body.user.id;
    assert.equal(r.body.user.email, 'two@test.org');
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'two@test.org', role: 'kiosk', password: 'xxxxxxxx' })).status, 400);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'short@test.org', role: 'kiosk', password: 'short' })).status, 400);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'staff@test.org', role: 'staff', password: 'xxxxxxxx' })).status, 400); // email taken
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'boss@test.org', role: 'boss', password: 'xxxxxxxx' })).status, 400);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'role@test.org', role: 'boss', password: 'xxxxxxxx' })).status, 400);

    const list = (await t.call('GET', '/api/admin/users')).body.users;
    assert.deepEqual(list.map((u) => u.role), ['admin', 'admin', 'staff', 'kiosk']);
    assert.ok(list.every((u) => !('password_hash' in u)));

    // can't remove the last admin or delete yourself
    assert.equal((await t.call('PUT', `/api/admin/users/${id}`, { name: 'Coach Two', email: 'two@test.org', role: 'kiosk' })).status, 200);
    assert.equal((await t.call('PUT', `/api/admin/users/${me.id}`, { email: me.email, role: 'kiosk' })).status, 400);
    assert.equal((await t.call('DELETE', `/api/admin/users/${me.id}`)).status, 400);

    // reset a password, then the new one works
    assert.equal((await t.call('PUT', `/api/admin/users/${id}`, { name: 'Coach Two', email: 'two@test.org', role: 'kiosk', password: 'brand-new-pw' })).status, 200);
    t.logout();
    assert.equal((await t.call('POST', '/api/login', { email: 'two@test.org', password: 'two-pass-123' })).status, 401);
    assert.equal((await t.call('POST', '/api/login', { email: 'two@test.org', password: 'brand-new-pw' })).status, 200);

    // deleting a user ends their session
    t.logout();
    await t.login();
    assert.equal((await t.call('DELETE', `/api/admin/users/${id}`)).status, 200);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id).n, 0);
  } finally { await t.close(); }
});

test('users can change their own password', async () => {
  const t = await setup();
  try {
    await t.login('kiosk');
    assert.equal((await t.call('PUT', '/api/me/password', { currentPassword: 'wrong', newPassword: 'new-kiosk-pw' })).status, 400);
    assert.equal((await t.call('PUT', '/api/me/password', { currentPassword: 'kiosk-pass', newPassword: 'new-kiosk-pw' })).status, 200);
    t.logout();
    assert.equal((await t.call('POST', '/api/login', { email: 'kiosk@test.org', password: 'new-kiosk-pw' })).status, 200);
  } finally { await t.close(); }
});

test('kiosk lists every sport, flagging the ones in season', async () => {
  const t = await setup();
  try {
    await t.login('kiosk');
    assert.deepEqual((await t.call('GET', '/api/sports')).body, { sports: [] });
    await seed(t);
    await t.login('kiosk');
    let r = (await t.call('GET', '/api/sports')).body;
    assert.deepEqual(r.sports.map((s) => [s.name, s.inSeason]), [['Football', true], ['Track', false]]);

    t.clock.now = new Date('2027-03-10T20:00:00Z'); // track season
    await t.login('kiosk');
    r = (await t.call('GET', '/api/sports')).body;
    assert.deepEqual(r.sports.map((s) => [s.name, s.inSeason]), [['Football', false], ['Track', true]]);
  } finally { await t.close(); }
});

test('sign up, search by name, sign in once per day', async () => {
  const t = await setup();
  try {
    const { football } = await seed(t);
    const r = await t.call('POST', '/api/signup', { firstName: '  Jordan ', lastName: 'Lee', sportId: football.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.student.firstName, 'Jordan');
    // Signing up also signs them in.
    assert.equal(r.body.signedIn, true);
    assert.equal(r.body.time, '2:30 PM');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sign_ins').get().n, 1);

    const dup = await t.call('POST', '/api/signup', { firstName: 'jordan', lastName: 'LEE', sportId: football.id });
    assert.equal(dup.status, 409);
    assert.equal((await t.call('POST', '/api/signup', { firstName: 'A', lastName: 'B' })).status, 400);

    for (const q of ['jor', 'Jordan L', 'lee', 'Lee, J']) {
      const found = (await t.call('GET', `/api/students/search?q=${encodeURIComponent(q)}`)).body.students;
      assert.equal(found.length, 1, `search "${q}"`);
      assert.equal(found[0].sportName, 'Football');
    }
    assert.equal((await t.call('GET', '/api/students/search?q=%25')).body.students.length, 0);

    const id = r.body.student.id;
    const first = await t.call('POST', '/api/signin', { studentId: id });
    assert.equal(first.status, 200);
    assert.equal(first.body.alreadySignedIn, true);
    assert.equal(first.body.time, '2:30 PM');

    t.clock.now = new Date('2026-11-17T01:00:00Z'); // 5 PM same local day
    const again = await t.call('POST', '/api/signin', { studentId: id });
    assert.equal(again.body.alreadySignedIn, true);

    t.clock.now = new Date('2026-11-17T22:00:00Z'); // next day
    assert.equal((await t.call('POST', '/api/signin', { studentId: id })).status, 201);

    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sign_ins').get().n, 2);
  } finally { await t.close(); }
});

test('changing sport at sign-in updates the student', async () => {
  const t = await setup();
  try {
    const { football, track } = await seed(t);
    const s = (await t.call('POST', '/api/signup', { firstName: 'Sam', lastName: 'Ortiz', sportId: football.id })).body.student;
    t.clock.now = new Date('2026-11-17T22:00:00Z'); // next day
    await t.login();
    await t.call('POST', '/api/signin', { studentId: s.id, sportId: track.id });
    const row = t.db.prepare('SELECT sport_id FROM students WHERE id = ?').get(s.id);
    assert.equal(row.sport_id, track.id);
    const si = t.db.prepare('SELECT sport_id FROM sign_ins WHERE student_id = ? ORDER BY id DESC').get(s.id);
    assert.equal(si.sport_id, track.id);
  } finally { await t.close(); }
});

test('notify coaches emails each sport once and skips sports without coaches', async () => {
  const t = await setup();
  try {
    const { football, track } = await seed(t);
    const a = (await t.call('POST', '/api/signup', { firstName: 'Ava', lastName: 'Diaz', sportId: football.id })).body.student;
    const b = (await t.call('POST', '/api/signup', { firstName: 'Ben', lastName: 'Cho', sportId: football.id })).body.student;
    const c = (await t.call('POST', '/api/signup', { firstName: 'Cy', lastName: 'Park', sportId: track.id })).body.student;
    for (const s of [a, b, c]) await t.call('POST', '/api/signin', { studentId: s.id });

    const preview = (await t.call('GET', '/api/admin/notify/preview')).body;
    assert.equal(preview.groups.length, 2);

    const r = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.deepEqual(r.map((x) => [x.sportName, x.status]), [['Football', 'sent'], ['Track', 'skipped']]);
    assert.equal(t.sent.length, 1);
    assert.deepEqual(t.sent[0].to, ['"Coach Smith" <smith@school.org>']);
    assert.match(t.sent[0].subject, /Football sign-ins \(Mon, Nov 16\)/);
    assert.match(t.sent[0].text, /2:30 PM {2}Ava Diaz/);
    assert.match(t.sent[0].text, /Ben Cho/);
    assert.doesNotMatch(t.sent[0].text, /Cy Park/);

    // Sending again only reports what's new: Track still pending (no coach), Football already done.
    const again = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.deepEqual(again.map((x) => [x.sportName, x.status]), [['Track', 'skipped']]);
    assert.equal(t.sent.length, 1);

    const history = (await t.call('GET', '/api/admin/notifications')).body.notifications;
    assert.equal(history.length, 1);
    assert.equal(history[0].count, 2);
  } finally { await t.close(); }
});

test('failed email leaves sign-ins pending', async () => {
  const t = await setup({ failFor: ['Football'] });
  try {
    const { football } = await seed(t);
    const a = (await t.call('POST', '/api/signup', { firstName: 'Ava', lastName: 'Diaz', sportId: football.id })).body.student;
    await t.call('POST', '/api/signin', { studentId: a.id });
    const r = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.equal(r[0].status, 'failed');
    assert.equal((await t.call('GET', '/api/admin/notify/preview')).body.groups.length, 1);
  } finally { await t.close(); }
});

test('without email configured, notify sends nothing and marks nothing', async () => {
  const t = await setup({ emailConfigured: false });
  try {
    const { football } = await seed(t);
    const a = (await t.call('POST', '/api/signup', { firstName: 'Ava', lastName: 'Diaz', sportId: football.id })).body.student;
    await t.call('POST', '/api/signin', { studentId: a.id });
    assert.equal((await t.call('POST', '/api/admin/notify')).status, 503);
    assert.equal((await t.call('GET', '/api/admin/notify/preview')).body.groups.length, 1);
  } finally { await t.close(); }
});

test('admin sign-in list uses the local day', async () => {
  const t = await setup();
  try {
    const { football } = await seed(t);
    const a = (await t.call('POST', '/api/signup', { firstName: 'Ava', lastName: 'Diaz', sportId: football.id })).body.student;
    t.clock.now = new Date('2026-11-17T06:30:00Z'); // 10:30 PM Nov 16 local, Nov 17 in UTC
    await t.call('POST', '/api/signin', { studentId: a.id });
    assert.equal((await t.call('GET', '/api/admin/signins?date=2026-11-16')).body.signIns.length, 1);
    assert.equal((await t.call('GET', '/api/admin/signins?date=2026-11-17')).body.signIns.length, 0);
  } finally { await t.close(); }
});

test('season validation', async () => {
  const t = await setup();
  try {
    const { football } = await seed(t);
    assert.equal((await t.call('PUT', `/api/admin/sports/${football.id}/seasons`, { seasons: ['summer'] })).status, 400);
    const ok = await t.call('PUT', `/api/admin/sports/${football.id}/seasons`, { seasons: ['winter', 'fall', 'fall'] });
    assert.deepEqual(ok.body.seasons, ['fall', 'winter']);
    assert.equal((await t.call('PUT', '/api/admin/season-dates', { ranges: { fall: { start: '13-01', end: '11-01' } } })).status, 400);
    const dates = (await t.call('GET', '/api/admin/season-dates')).body;
    assert.deepEqual(dates.ranges.fall, { start: '08-15', end: '11-30' });
    assert.deepEqual(dates.currentSeasons, ['fall']); // Nov 16
    assert.equal((await t.call('POST', `/api/admin/sports/${football.id}/coaches`, { email: 'not-an-email' })).status, 400);
    assert.equal((await t.call('POST', `/api/admin/sports/${football.id}/coaches`, {})).status, 400);
  } finally { await t.close(); }
});

test('first admin is created from settings only when there are no users', async () => {
  const { bootstrapAdmin } = require('../src/users');
  const db = openDb(':memory:');
  await assert.rejects(bootstrapAdmin(db, {}), /ADMIN_EMAIL/);
  await assert.rejects(bootstrapAdmin(db, { email: 'a@b.org', password: 'short' }), /at least 8/);
  assert.deepEqual(await bootstrapAdmin(db, { email: 'A@b.org', password: 'long-enough' }), { created: true });
  assert.deepEqual(await bootstrapAdmin(db, { email: 'c@d.org', password: 'long-enough' }), { created: false });
  assert.equal(db.prepare('SELECT email, role FROM users').get().email, 'a@b.org');
});


test('import endpoint, coaches without email, and editing a coach', async () => {
  const t = await setup();
  try {
    const { football } = await seed(t); // Football has Coach Smith with an email
    assert.equal((await t.call('POST', '/api/admin/import', { text: '' })).status, 400);
    const text = 'FALL\nFootball\nHead Coach: Chase Beach\nGirls Soccer\nHead Coach: Colin Hay\nWINTER\nWrestling\nHead Coach: Pete Machacek';
    const preview = (await t.call('POST', '/api/admin/import', { text, dryRun: true })).body;
    assert.equal(preview.dryRun, true);
    assert.equal((await t.call('GET', '/api/admin/sports')).body.sports.length, 2);
    const r = await t.call('POST', '/api/admin/import', { text });
    assert.equal(r.status, 200);
    const sports = (await t.call('GET', '/api/admin/sports')).body.sports;
    assert.deepEqual(sports.map((s) => [s.name, s.seasons]),
      [['Football', ['fall']], ['Girls Soccer', ['fall']], ['Track', ['spring']], ['Wrestling', ['winter']]]);

    // Students sign in to Girls Soccer, which has a coach but no email yet.
    const soccer = sports.find((s) => s.name === 'Girls Soccer');
    const st = (await t.call('POST', '/api/signup', { firstName: 'Ana', lastName: 'Ruiz', sportId: soccer.id })).body.student;
    await t.call('POST', '/api/signin', { studentId: st.id });
    const fb = (await t.call('POST', '/api/signup', { firstName: 'Bo', lastName: 'Diaz', sportId: football.id })).body.student;
    await t.call('POST', '/api/signin', { studentId: fb.id });

    let results = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.deepEqual(results.map((x) => [x.sportName, x.status]), [['Football', 'sent'], ['Girls Soccer', 'skipped']]);
    assert.equal(results[1].reason, 'No coach email addresses on file');
    assert.deepEqual(t.sent[0].to, ['"Coach Smith" <smith@school.org>']); // Chase Beach has no email yet

    // Add the email, then the pending Girls Soccer sign-in goes out.
    const hay = soccer.coaches[0];
    assert.equal((await t.call('PUT', `/api/admin/coaches/${hay.id}`, { name: 'Colin Hay', email: 'Hay@School.org' })).status, 200);
    results = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.deepEqual(results.map((x) => [x.sportName, x.status]), [['Girls Soccer', 'sent']]);
    assert.deepEqual(t.sent[1].to, ['"Colin Hay" <hay@school.org>']);
  } finally { await t.close(); }
});

test('the kiosk Admin link asks for the password again', async () => {
  const t = await setup();
  try {
    await t.login('kiosk');
    assert.equal((await t.call('POST', '/api/confirm-password', { password: 'kiosk-pass' })).status, 403);
    await t.login('staff');
    assert.equal((await t.call('POST', '/api/confirm-password', { password: 'nope' })).status, 401);
    assert.equal((await t.call('POST', '/api/confirm-password', { password: 'staff-pass' })).status, 200);
    await t.login('admin');
    assert.equal((await t.call('POST', '/api/confirm-password', { password: 'admin-pass' })).status, 200);
    t.logout();
    assert.equal((await t.call('POST', '/api/confirm-password', { password: 'admin-pass' })).status, 401);
  } finally { await t.close(); }
});

test('students can play several sports; each sport\'s coaches hear about the sign-in', async () => {
  const t = await setup();
  try {
    const { football, track } = await seed(t); // Football: Coach Smith
    await t.call('POST', `/api/admin/sports/${track.id}/coaches`, { name: 'Coach Run', email: 'run@school.org' });
    assert.equal((await t.call('POST', '/api/signup', { firstName: 'No', lastName: 'Sport', sportIds: [] })).status, 400);
    const r = await t.call('POST', '/api/signup', { firstName: 'Ava', lastName: 'Two', sportIds: [track.id, football.id, football.id] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.student.sports.map((x) => x.name), ['Football', 'Track']);
    assert.equal(r.body.student.sportName, 'Football, Track');

    const found = (await t.call('GET', '/api/students/search?q=ava')).body.students[0];
    assert.deepEqual(found.sportIds.sort(), [football.id, track.id].sort());

    const signIns = (await t.call('GET', '/api/admin/signins?date=2026-11-16')).body.signIns;
    assert.equal(signIns[0].sportName, 'Football, Track');
    assert.equal(signIns[0].notified, false);

    const results = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.deepEqual(results.map((x) => [x.sportName, x.status]), [['Football', 'sent'], ['Track', 'sent']]);
    assert.equal(t.sent.length, 2);
    assert.ok(t.sent.every((m) => m.text.includes('Ava Two')));
    assert.equal((await t.call('GET', '/api/admin/signins?date=2026-11-16')).body.signIns[0].notified, true);
    assert.deepEqual((await t.call('POST', '/api/admin/notify')).body.results, [], 'nothing sent twice');

    // Changing sports at the next sign-in; that sign-in goes only to the new sport's coaches.
    t.clock.now = new Date('2026-11-17T22:00:00Z');
    await t.login();
    await t.call('POST', '/api/signin', { studentId: r.body.student.id, sportIds: [track.id] });
    const results2 = (await t.call('POST', '/api/admin/notify')).body.results;
    assert.deepEqual(results2.map((x) => x.sportName), ['Track']);

    // Admin edits a student's sports.
    assert.equal((await t.call('PUT', `/api/admin/students/${r.body.student.id}`, { firstName: 'Ava', lastName: 'Two', sportIds: [football.id] })).status, 200);
    const list = (await t.call('GET', '/api/admin/students')).body.students;
    assert.equal(list.find((s) => s.firstName === 'Ava').sportName, 'Football');
  } finally { await t.close(); }
});

test('winter can run past New Year; sports list shows seasons', async () => {
  const t = await setup();
  try {
    await t.login();
    const sp = (await t.call('POST', '/api/admin/sports', { name: 'Wrestling' })).body;
    await t.call('PUT', `/api/admin/sports/${sp.id}/seasons`, { seasons: ['winter'] });
    for (const [iso, inSeason] of [['2026-12-20T20:00:00Z', true], ['2027-01-15T20:00:00Z', true], ['2027-03-15T20:00:00Z', false]]) {
      t.clock.now = new Date(iso);
      await t.login();
      const s = (await t.call('GET', '/api/admin/sports')).body.sports[0];
      assert.deepEqual(s.seasons, ['winter']);
      assert.equal(s.inSeason, inSeason, iso);
    }
  } finally { await t.close(); }
});

test('older databases: single sports, dated seasons and sign-ins move to the new layout', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-')), 'db.sqlite');
  let db = openDb(file);
  // Simulate an older install: data only in the old columns/tables.
  db.exec("DELETE FROM settings WHERE key IN ('migrated_student_sports', 'migrated_sport_seasons')");
  db.exec("INSERT INTO sports (id, name) VALUES (1, 'Football'), (2, 'Cheerleading'), (3, 'Baseball')");
  db.exec(`INSERT INTO seasons (sport_id, label, start_date, end_date) VALUES
    (1, 'Fall 2026', '2026-08-17', '2026-11-15'), (2, 'Fall 2026', '2026-08-17', '2026-11-15'),
    (2, 'Winter 2026–27', '2026-11-16', '2027-03-01'), (3, '', '2027-03-02', '2027-06-06')`);
  db.exec("INSERT INTO students (id, first_name, last_name, sport_id, created_at) VALUES (1, 'Old', 'Timer', 1, '2026-09-01')");
  db.exec("INSERT INTO sign_ins (id, student_id, sport_id, signed_in_at, notified_at) VALUES (1, 1, 1, '2026-09-02T15:00:00Z', '2026-09-03T00:00:00Z'), (2, 1, 1, '2026-09-04T15:00:00Z', NULL)");
  db.close();
  db = openDb(file);
  assert.deepEqual(db.prepare('SELECT sport_id, season FROM sport_seasons ORDER BY sport_id, season').all().map((r) => `${r.sport_id}:${r.season}`),
    ['1:fall', '2:fall', '2:winter', '3:spring']);
  assert.deepEqual(db.prepare('SELECT student_id, sport_id FROM student_sports').all().map((r) => [r.student_id, r.sport_id]), [[1, 1]]);
  assert.deepEqual(db.prepare('SELECT sign_in_id, notified_at FROM sign_in_sports ORDER BY sign_in_id').all().map((r) => [r.sign_in_id, Boolean(r.notified_at)]),
    [[1, true], [2, false]]);
  db.close();
});
