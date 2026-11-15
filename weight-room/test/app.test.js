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
  await t.call('POST', `/api/admin/sports/${football.id}/seasons`, { label: 'Fall', startDate: '2026-08-15', endDate: '2026-11-30' });
  await t.call('POST', `/api/admin/sports/${track.id}/seasons`, { label: 'Spring', startDate: '2027-02-15', endDate: '2027-05-31' });
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
    await t.login('kiosk');
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
    assert.equal((await t.call('GET', '/api/admin/sports')).status, 200);
    assert.equal((await t.call('GET', '/api/admin/users')).status, 403);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'x@test.org', role: 'admin', password: '12345678' })).status, 403);
  } finally { await t.close(); }
});

test('admins manage users', async () => {
  const t = await setup();
  try {
    const me = await t.login();
    let r = await t.call('POST', '/api/admin/users', { name: 'Coach Two', email: 'Two@Test.org ', role: 'staff', password: 'two-pass-123' });
    assert.equal(r.status, 201);
    const id = r.body.user.id;
    assert.equal(r.body.user.email, 'two@test.org');
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'two@test.org', role: 'staff', password: 'xxxxxxxx' })).status, 400);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'short@test.org', role: 'staff', password: 'short' })).status, 400);
    assert.equal((await t.call('POST', '/api/admin/users', { email: 'role@test.org', role: 'boss', password: 'xxxxxxxx' })).status, 400);

    const list = (await t.call('GET', '/api/admin/users')).body.users;
    assert.deepEqual(list.map((u) => u.role), ['admin', 'staff', 'staff', 'kiosk']);
    assert.ok(list.every((u) => !('password_hash' in u)));

    // can't remove the last admin or delete yourself
    assert.equal((await t.call('PUT', `/api/admin/users/${me.id}`, { email: me.email, role: 'staff' })).status, 400);
    assert.equal((await t.call('DELETE', `/api/admin/users/${me.id}`)).status, 400);

    // reset a password, then the new one works
    assert.equal((await t.call('PUT', `/api/admin/users/${id}`, { name: 'Coach Two', email: 'two@test.org', role: 'staff', password: 'brand-new-pw' })).status, 200);
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
    await t.login('staff');
    assert.equal((await t.call('PUT', '/api/me/password', { currentPassword: 'wrong', newPassword: 'new-staff-pw' })).status, 400);
    assert.equal((await t.call('PUT', '/api/me/password', { currentPassword: 'staff-pass', newPassword: 'new-staff-pw' })).status, 200);
    t.logout();
    assert.equal((await t.call('POST', '/api/login', { email: 'staff@test.org', password: 'new-staff-pw' })).status, 200);
  } finally { await t.close(); }
});

test('kiosk only offers in-season sports, falling back to all', async () => {
  const t = await setup();
  try {
    await t.login('kiosk');
    assert.deepEqual((await t.call('GET', '/api/sports')).body, { sports: [], inSeasonOnly: false });
    await seed(t);
    let r = (await t.call('GET', '/api/sports')).body;
    assert.deepEqual(r.sports.map((s) => s.name), ['Football']);
    assert.equal(r.inSeasonOnly, true);

    t.clock.now = new Date('2027-01-10T20:00:00Z'); // between seasons
    assert.equal((await t.call('GET', '/api/sports')).status, 401); // 14-day admin session expired
    await t.login('kiosk');
    r = (await t.call('GET', '/api/sports')).body;
    assert.deepEqual(r.sports.map((s) => s.name), ['Football', 'Track']);
    assert.equal(r.inSeasonOnly, false);
  } finally { await t.close(); }
});

test('sign up, search by name, sign in once per day', async () => {
  const t = await setup();
  try {
    const { football } = await seed(t);
    const r = await t.call('POST', '/api/signup', { firstName: '  Jordan ', lastName: 'Lee', sportId: football.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.student.firstName, 'Jordan');

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
    assert.equal(first.status, 201);
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
    await t.call('POST', '/api/signin', { studentId: s.id, sportId: track.id });
    const row = t.db.prepare('SELECT sport_id FROM students WHERE id = ?').get(s.id);
    assert.equal(row.sport_id, track.id);
    const si = t.db.prepare('SELECT sport_id FROM sign_ins WHERE student_id = ?').get(s.id);
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
    const r = await t.call('POST', `/api/admin/sports/${football.id}/seasons`, { startDate: '2026-12-01', endDate: '2026-11-01' });
    assert.equal(r.status, 400);
    assert.equal((await t.call('POST', `/api/admin/sports/${football.id}/seasons`, { startDate: '2026-02-30', endDate: '2026-03-01' })).status, 400);
    assert.equal((await t.call('POST', `/api/admin/sports/${football.id}/coaches`, { email: 'not-an-email' })).status, 400);
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
