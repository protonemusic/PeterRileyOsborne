'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { tx } = require('./db');
const { localDate, formatTime, formatDay, isValidDate } = require('./time');
const users = require('./users');
const { parseImport, applyImport, SEASON_NAMES } = require('./importer');
const QRCode = require('qrcode');
const workouts = require('./workouts');
const { parseProgramFile, label: dayLabel } = require('./programParser');

const COOKIE = 'wr_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} not found`);

function cleanName(value, field) {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw bad(`${field} is required`);
  if (s.length > 50) throw bad(`${field} is too long`);
  return s;
}

function toId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${field}`);
  return n;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function createApp({ db, mailer, config }) {
  const tz = config.timeZone;
  const now = config.now || (() => new Date());
  const today = () => localDate(now(), tz);
  workouts.addMissingTestDays(db);
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '50kb' }));

  // ---------- helpers ----------
  const getSport = (id) => db.prepare('SELECT id, name FROM sports WHERE id = ?').get(id);
  const requireSport = (id) => {
    const sport = getSport(toId(id, 'sport'));
    if (!sport) throw bad('Please choose a valid sport');
    return sport;
  };

  function inSeasonSports() {
    return db.prepare(`
      SELECT DISTINCT s.id, s.name FROM sports s
      JOIN seasons se ON se.sport_id = s.id
      WHERE se.start_date <= ? AND se.end_date >= ?
      ORDER BY s.name COLLATE NOCASE`).all(today(), today());
  }

  // ---------- sessions ----------
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('base64url');

  function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function cookieHeader(value, maxAgeSec) {
    const secure = config.secureCookies ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  }

  function startSession(res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const days = users.SESSION_DAYS[user.role];
    const expires = new Date(now().getTime() + days * 86400 * 1000).toISOString();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now().toISOString());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), user.id, expires);
    res.setHeader('Set-Cookie', cookieHeader(token, days * 86400));
  }

  /** Attach req.user (or null) from the session cookie. */
  app.use((req, _res, next) => {
    const token = readCookie(req, COOKIE);
    req.user = null;
    if (token) {
      req.tokenHash = hashToken(token);
      req.user = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s
        JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
        .get(req.tokenHash, now().toISOString()) || null;
    }
    next();
  });

  const STAFF = ['admin', 'staff'];
  const ANYONE = ['admin', 'staff', 'kiosk'];
  const requireRole = (roles) => (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, "Your account doesn't have access to this"));
    next();
  };

  // Simple in-memory brake on password guessing, per IP address.
  const failures = new Map();
  function checkLoginRate(ip) {
    const f = failures.get(ip);
    if (f && now().getTime() - f.first > LOGIN_WINDOW_MS) failures.delete(ip);
    if ((failures.get(ip)?.count || 0) >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'Too many failed logins. Please wait 15 minutes and try again.');
    }
  }
  function recordFailure(ip) {
    const f = failures.get(ip) || { count: 0, first: now().getTime() };
    f.count += 1;
    failures.set(ip, f);
  }

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

  // ---------- auth API (public) ----------
  app.post('/api/login', async (req, res) => {
    checkLoginRate(req.ip);
    const email = users.normalizeEmail(req.body?.email);
    const user = db.prepare('SELECT id, email, name, role, password_hash FROM users WHERE email = ?').get(email);
    const ok = await users.verifyPassword(req.body?.password, user?.password_hash);
    if (!user || !ok) {
      recordFailure(req.ip);
      throw new HttpError(401, 'Wrong email or password');
    }
    failures.delete(req.ip);
    startSession(res, user);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    if (req.tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true });
  });

  // The kiosk asks for the logged-in staff/admin's password again before opening the admin page.
  app.post('/api/confirm-password', requireRole(['admin', 'staff']), async (req, res) => {
    checkLoginRate(req.ip);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await users.verifyPassword(req.body?.password, row.password_hash))) {
      recordFailure(req.ip);
      throw new HttpError(401, 'Wrong password');
    }
    failures.delete(req.ip);
    res.json({ ok: true });
  });

  app.get('/api/me', requireRole(ANYONE), (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.put('/api/me/password', requireRole(ANYONE), async (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await users.verifyPassword(req.body?.currentPassword, row.password_hash))) {
      throw bad('Your current password is not right');
    }
    const password = checkPassword(req.body?.newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await users.hashPassword(password), req.user.id);
    // Log out everywhere else.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.tokenHash);
    res.json({ ok: true });
  });

  function checkPassword(p) {
    if (typeof p !== 'string' || p.length < users.MIN_PASSWORD) {
      throw bad(`Password must be at least ${users.MIN_PASSWORD} characters`);
    }
    if (p.length > 200) throw bad('Password is too long');
    return p;
  }

  // ---------- student workout dashboard (no login: the link's token is the key) ----------
  const byToken = (token) => {
    const t = String(token || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) throw notFound('Workout page');
    return t;
  };

  app.get('/api/w/:token', (req, res) => {
    const data = workouts.dashboard(db, byToken(req.params.token), today());
    if (!data) throw notFound('Workout page');
    res.setHeader('Cache-Control', 'no-store');
    const { id, ...student } = data.student;
    res.json({ ...data, student });
  });

  function tokenStudent(token) {
    const st = db.prepare('SELECT id FROM students WHERE workout_token = ?').get(byToken(token));
    if (!st) throw notFound('Workout page');
    return st.id;
  }

  app.get('/api/w/:token/workouts/:id', (req, res) => {
    const detail = workouts.workoutDetail(db, tokenStudent(req.params.token), toId(req.params.id), tz);
    if (!detail) throw notFound('Workout');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ workout: detail });
  });

  app.put('/api/w/:token/workouts/:id', (req, res) => {
    const ok = workouts.saveResults(db, tokenStudent(req.params.token), toId(req.params.id), req.body, now().toISOString());
    if (!ok) throw notFound('Workout');
    res.json({ ok: true });
  });

  // ---------- admin API (staff + admin) ----------
  const admin = express.Router();
  admin.use(requireRole(STAFF));
  app.use('/api/admin', admin);

  // ---------- kiosk API (any logged-in account) ----------
  const kiosk = express.Router();
  kiosk.use(requireRole(ANYONE));

  // Every sport, flagged when it's in season today (students may pick any of them).
  kiosk.get('/sports', (_req, res) => {
    const active = new Set(inSeasonSports().map((s) => s.id));
    const all = db.prepare('SELECT id, name FROM sports ORDER BY name COLLATE NOCASE').all();
    res.json({ sports: all.map((s) => ({ ...s, inSeason: active.has(s.id) })) });
  });

  kiosk.get('/students/search', (req, res) => {
    const q = String(req.query.q || '').trim().replace(/\s+/g, ' ');
    if (!q) return res.json({ students: [] });
    const like = `${escapeLike(q)}%`;
    const students = db.prepare(`
      SELECT st.id, st.first_name AS firstName, st.last_name AS lastName,
             st.sport_id AS sportId, sp.name AS sportName
      FROM students st LEFT JOIN sports sp ON sp.id = st.sport_id
      WHERE (st.first_name || ' ' || st.last_name) LIKE ? ESCAPE '\\'
         OR st.last_name LIKE ? ESCAPE '\\'
         OR (st.last_name || ', ' || st.first_name) LIKE ? ESCAPE '\\'
      ORDER BY st.last_name COLLATE NOCASE, st.first_name COLLATE NOCASE
      LIMIT 10`).all(like, like, like);
    res.json({ students });
  });

  kiosk.post('/signup', async (req, res) => {
    const firstName = cleanName(req.body?.firstName, 'First name');
    const lastName = cleanName(req.body?.lastName, 'Last name');
    const sport = requireSport(req.body?.sportId);
    const existing = db.prepare(`SELECT id FROM students
      WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE`).get(firstName, lastName);
    if (existing) {
      throw new HttpError(409, `${firstName} ${lastName} is already signed up. Use Sign In instead.`);
    }
    // Signing up also signs the student in for their first day.
    const { studentId, signInId, workout, signedInAt } = tx(db, () => {
      const id = Number(db.prepare(`INSERT INTO students (first_name, last_name, sport_id, created_at)
        VALUES (?, ?, ?, ?)`).run(firstName, lastName, sport.id, now().toISOString()).lastInsertRowid);
      return { studentId: id, ...recordSignIn(id, sport.id) };
    });
    res.status(201).json({
      student: { id: studentId, firstName, lastName, sportId: sport.id, sportName: sport.name },
      signedIn: true, alreadySignedIn: false, name: `${firstName} ${lastName}`,
      time: formatTime(signedInAt, tz), signInId,
      ...(await workoutLink(req, studentId, workout)),
    });
  });

  /** Insert a sign-in for now and give the student today's workout. Call inside a transaction. */
  function recordSignIn(studentId, sportId) {
    const signedInAt = now().toISOString();
    const signInId = Number(db.prepare('INSERT INTO sign_ins (student_id, sport_id, signed_in_at) VALUES (?, ?, ?)')
      .run(studentId, sportId, signedInAt).lastInsertRowid);
    const workout = workouts.assignWorkout(db, { studentId, signInId, today: today(), tz });
    return { signInId, signedInAt, workout };
  }

  kiosk.post('/signin', async (req, res) => {
    const studentId = toId(req.body?.studentId, 'student');
    const student = db.prepare('SELECT id, first_name, last_name, sport_id FROM students WHERE id = ?').get(studentId);
    if (!student) throw notFound('Student');

    let sportId = student.sport_id;
    if (req.body?.sportId != null && req.body.sportId !== '') {
      sportId = requireSport(req.body.sportId).id;
      if (sportId !== student.sport_id) {
        db.prepare('UPDATE students SET sport_id = ? WHERE id = ?').run(sportId, studentId);
      }
    }
    if (sportId == null) throw bad('Please choose your current sport');

    const name = `${student.first_name} ${student.last_name}`;
    const last = db.prepare(`SELECT id, signed_in_at FROM sign_ins WHERE student_id = ?
      ORDER BY signed_in_at DESC LIMIT 1`).get(studentId);
    if (last && localDate(new Date(last.signed_in_at), tz) === today()) {
      // Gives them today's workout if they don't have one yet (e.g. they signed in
      // before a program was made active); otherwise returns the one they already have.
      const workout = workouts.assignWorkout(db, { studentId, signInId: last.id, today: today(), tz });
      return res.json({
        alreadySignedIn: true, name, time: formatTime(last.signed_in_at, tz),
        ...(await workoutLink(req, studentId, workout)),
      });
    }

    const { signInId, signedInAt, workout } = tx(db, () => recordSignIn(studentId, sportId));
    res.status(201).json({
      alreadySignedIn: false, name, time: formatTime(signedInAt, tz), signInId,
      ...(await workoutLink(req, studentId, workout)),
    });
  });

  /** The workout summary plus the student's dashboard link and its QR code, for the kiosk. */
  async function workoutLink(req, studentId, { status, workout }) {
    if (status === 'none') return { workout: { status } };
    const url = `${baseUrl(req)}/w/${workouts.ensureToken(db, studentId)}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { workout: { status, ...(workout || {}) }, dashboardUrl: url, qrSvg };
  }

  function baseUrl(req) {
    return (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  }

  admin.get('/me', (req, res) => {
    res.json({ user: publicUser(req.user), emailConfigured: mailer.configured, today: today(), timeZone: tz });
  });

  // Sports, with their seasons and coaches
  admin.get('/sports', (_req, res) => {
    const t = today();
    const sports = db.prepare('SELECT id, name FROM sports ORDER BY name COLLATE NOCASE').all();
    const seasons = db.prepare(`SELECT id, sport_id AS sportId, label, start_date AS startDate,
      end_date AS endDate FROM seasons ORDER BY start_date`).all();
    const coaches = db.prepare('SELECT id, sport_id AS sportId, name, email FROM coaches ORDER BY name COLLATE NOCASE').all();
    res.json({
      sports: sports.map((s) => {
        const own = seasons.filter((se) => se.sportId === s.id)
          .map((se) => ({ ...se, current: se.startDate <= t && se.endDate >= t }));
        return {
          ...s,
          inSeason: own.some((se) => se.current),
          seasons: own,
          coaches: coaches.filter((c) => c.sportId === s.id),
        };
      }),
    });
  });

  admin.post('/sports', (req, res) => {
    const name = cleanName(req.body?.name, 'Sport name');
    if (db.prepare('SELECT 1 FROM sports WHERE name = ? COLLATE NOCASE').get(name)) throw bad(`${name} already exists`);
    const { lastInsertRowid } = db.prepare('INSERT INTO sports (name) VALUES (?)').run(name);
    res.status(201).json({ id: Number(lastInsertRowid), name });
  });

  admin.put('/sports/:id', (req, res) => {
    const id = toId(req.params.id);
    const name = cleanName(req.body?.name, 'Sport name');
    const clash = db.prepare('SELECT id FROM sports WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, id);
    if (clash) throw bad(`${name} already exists`);
    if (db.prepare('UPDATE sports SET name = ? WHERE id = ?').run(name, id).changes === 0) throw notFound('Sport');
    res.json({ id, name });
  });

  admin.delete('/sports/:id', (req, res) => {
    if (db.prepare('DELETE FROM sports WHERE id = ?').run(toId(req.params.id)).changes === 0) throw notFound('Sport');
    res.json({ ok: true });
  });

  function seasonFields(body) {
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 50) : '';
    const { startDate, endDate } = body || {};
    if (!isValidDate(startDate)) throw bad('Start date is required');
    if (!isValidDate(endDate)) throw bad('End date is required');
    if (startDate > endDate) throw bad('Start date must be on or before end date');
    return { label, startDate, endDate };
  }

  admin.post('/sports/:id/seasons', (req, res) => {
    const sportId = toId(req.params.id);
    if (!getSport(sportId)) throw notFound('Sport');
    const { label, startDate, endDate } = seasonFields(req.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO seasons (sport_id, label, start_date, end_date)
      VALUES (?, ?, ?, ?)`).run(sportId, label, startDate, endDate);
    res.status(201).json({ id: Number(lastInsertRowid), sportId, label, startDate, endDate });
  });

  admin.put('/seasons/:id', (req, res) => {
    const id = toId(req.params.id);
    const { label, startDate, endDate } = seasonFields(req.body);
    const r = db.prepare('UPDATE seasons SET label = ?, start_date = ?, end_date = ? WHERE id = ?')
      .run(label, startDate, endDate, id);
    if (r.changes === 0) throw notFound('Season');
    res.json({ id, label, startDate, endDate });
  });

  admin.delete('/seasons/:id', (req, res) => {
    if (db.prepare('DELETE FROM seasons WHERE id = ?').run(toId(req.params.id)).changes === 0) throw notFound('Season');
    res.json({ ok: true });
  });

  /** Coach name and email. The email is optional (it can be added later), but one of the two is required. */
  function coachFields(body) {
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email && !users.isValidEmail(email)) throw bad('Please enter a valid email address');
    if (!name && !email) throw bad('Please enter a coach name or email');
    return { name, email };
  }

  admin.post('/sports/:id/coaches', (req, res) => {
    const sportId = toId(req.params.id);
    if (!getSport(sportId)) throw notFound('Sport');
    const { name, email } = coachFields(req.body);
    const { lastInsertRowid } = db.prepare('INSERT INTO coaches (sport_id, name, email) VALUES (?, ?, ?)')
      .run(sportId, name, email);
    res.status(201).json({ id: Number(lastInsertRowid), sportId, name, email });
  });

  admin.put('/coaches/:id', (req, res) => {
    const id = toId(req.params.id);
    const { name, email } = coachFields(req.body);
    if (db.prepare('UPDATE coaches SET name = ?, email = ? WHERE id = ?').run(name, email, id).changes === 0) throw notFound('Coach');
    res.json({ id, name, email });
  });

  // Bulk import of sports, seasons and coaches from pasted text.
  admin.post('/import', (req, res) => {
    const parsed = parseImport(req.body?.text);
    if (!parsed.sports.length) throw bad('No sports found. Put each sport on its own line.');
    const seasonDates = {};
    for (const key of SEASON_NAMES) {
      const d = req.body?.seasons?.[key];
      if (!d) continue;
      const label = typeof d.label === 'string' ? d.label.trim().slice(0, 50) : '';
      if (!isValidDate(d.startDate) || !isValidDate(d.endDate)) throw bad(`Please enter ${key} start and end dates`);
      if (d.startDate > d.endDate) throw bad(`The ${key} start date must be on or before its end date`);
      seasonDates[key] = { label, startDate: d.startDate, endDate: d.endDate };
    }
    const missing = [...new Set(parsed.sports.flatMap((s) => s.seasons))].filter((k) => !seasonDates[k]);
    if (missing.length) throw bad(`Please enter dates for: ${missing.join(', ')}`);
    const dryRun = req.body?.dryRun === true;
    const summary = dryRun
      ? applyImport(db, parsed, seasonDates, { dryRun })
      : tx(db, () => applyImport(db, parsed, seasonDates));
    res.json({ dryRun, warnings: parsed.warnings, sports: summary });
  });

  admin.delete('/coaches/:id', (req, res) => {
    if (db.prepare('DELETE FROM coaches WHERE id = ?').run(toId(req.params.id)).changes === 0) throw notFound('Coach');
    res.json({ ok: true });
  });

  // Students
  admin.get('/students', (_req, res) => {
    const students = db.prepare(`
      SELECT st.id, st.first_name AS firstName, st.last_name AS lastName, st.sport_id AS sportId,
             sp.name AS sportName, COUNT(si.id) AS signInCount, MAX(si.signed_in_at) AS lastSignIn
      FROM students st
      LEFT JOIN sports sp ON sp.id = st.sport_id
      LEFT JOIN sign_ins si ON si.student_id = st.id
      GROUP BY st.id
      ORDER BY st.last_name COLLATE NOCASE, st.first_name COLLATE NOCASE`).all();
    res.json({
      students: students.map((s) => ({
        ...s,
        workout: workouts.progressFor(db, s.id),
        lastSignIn: s.lastSignIn ? `${formatDay(s.lastSignIn, tz)}, ${formatTime(s.lastSignIn, tz)}` : null,
      })),
    });
  });

  admin.put('/students/:id', (req, res) => {
    const id = toId(req.params.id);
    const firstName = cleanName(req.body?.firstName, 'First name');
    const lastName = cleanName(req.body?.lastName, 'Last name');
    const sportId = req.body?.sportId ? requireSport(req.body.sportId).id : null;
    const clash = db.prepare(`SELECT id FROM students WHERE first_name = ? COLLATE NOCASE
      AND last_name = ? COLLATE NOCASE AND id <> ?`).get(firstName, lastName, id);
    if (clash) throw bad(`Another student is already named ${firstName} ${lastName}`);
    const r = db.prepare('UPDATE students SET first_name = ?, last_name = ?, sport_id = ? WHERE id = ?')
      .run(firstName, lastName, sportId, id);
    if (r.changes === 0) throw notFound('Student');
    res.json({ ok: true });
  });

  admin.post('/students/:id/workout-link', (req, res) => {
    const id = toId(req.params.id);
    if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(id)) throw notFound('Student');
    const token = req.body?.reset === true ? workouts.resetToken(db, id) : workouts.ensureToken(db, id);
    res.json({ url: `${baseUrl(req)}/w/${token}` });
  });

  // ---------- workout programs ----------
  const upload = express.raw({ type: () => true, limit: '20mb' });

  async function parseUpload(req) {
    if (!req.body?.length) throw bad('Please choose a file to upload');
    try {
      return await parseProgramFile(req.body);
    } catch (err) {
      if (err.userFacing) throw bad(err.message);
      console.error(err);
      throw bad("That file couldn't be read. Make sure it's a PDF or Word .docx file.");
    }
  }

  const describeDay = (d) => ({
    dayNumber: d.dayNumber, label: dayLabel(d), kind: d.kind, weekTitle: d.weekTitle, weekNote: d.weekNote,
    items: d.items,
  });

  admin.post('/programs/preview', upload, async (req, res) => {
    const { days, warnings } = await parseUpload(req);
    res.json({ days: workouts.withTestDays(days).map(describeDay), warnings });
  });

  admin.post('/programs', upload, async (req, res) => {
    const name = String(req.query.name || '').trim().slice(0, 100);
    if (!name) throw bad('Please give the program a name');
    const { days } = await parseUpload(req);
    const filename = String(req.query.filename || '').slice(0, 200);
    const id = workouts.saveProgram(db, { name, filename, days }, now().toISOString());
    const saved = db.prepare('SELECT COUNT(*) AS n FROM program_days WHERE program_id = ?').get(id).n;
    res.status(201).json({ id, days: saved });
  });

  admin.get('/programs', (_req, res) => {
    const programs = db.prepare(`SELECT p.id, p.name, p.filename, p.created_at AS createdAt, p.active,
        (SELECT COUNT(*) FROM program_days d WHERE d.program_id = p.id) AS totalDays,
        (SELECT COUNT(DISTINCT student_id) FROM student_workouts w WHERE w.program_id = p.id) AS students
      FROM programs p ORDER BY p.created_at DESC`).all();
    res.json({
      programs: programs.map((p) => ({ ...p, active: Boolean(p.active), uploaded: formatDay(p.createdAt, tz) })),
    });
  });

  admin.get('/programs/:id/days', (req, res) => {
    const id = toId(req.params.id);
    const rows = db.prepare('SELECT day_number FROM program_days WHERE program_id = ? ORDER BY day_number').all(id);
    if (!rows.length) throw notFound('Program');
    res.json({ days: rows.map((r) => describeDay(workouts.getProgramDay(db, id, r.day_number))) });
  });

  admin.post('/programs/:id/activate', (req, res) => {
    const id = toId(req.params.id);
    if (!db.prepare('SELECT 1 FROM programs WHERE id = ?').get(id)) throw notFound('Program');
    tx(db, () => {
      db.exec('UPDATE programs SET active = 0');
      db.prepare('UPDATE programs SET active = 1 WHERE id = ?').run(id);
    });
    res.json({ ok: true });
  });

  admin.delete('/programs/:id', (req, res) => {
    if (db.prepare('DELETE FROM programs WHERE id = ?').run(toId(req.params.id)).changes === 0) throw notFound('Program');
    res.json({ ok: true });
  });

  admin.delete('/students/:id', (req, res) => {
    if (db.prepare('DELETE FROM students WHERE id = ?').run(toId(req.params.id)).changes === 0) throw notFound('Student');
    res.json({ ok: true });
  });

  // Sign-ins for one local day
  admin.get('/signins', (req, res) => {
    const date = req.query.date ? String(req.query.date) : today();
    if (!isValidDate(date)) throw bad('Invalid date');
    // Pull a generous UTC window, then filter to the local day exactly.
    const from = new Date(Date.parse(`${date}T00:00:00Z`) - 36 * 3600 * 1000).toISOString();
    const to = new Date(Date.parse(`${date}T00:00:00Z`) + 60 * 3600 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT si.id, si.signed_in_at AS signedInAt, si.notified_at AS notifiedAt,
             st.first_name || ' ' || st.last_name AS name, sp.name AS sportName
      FROM sign_ins si
      JOIN students st ON st.id = si.student_id
      LEFT JOIN sports sp ON sp.id = si.sport_id
      WHERE si.signed_in_at >= ? AND si.signed_in_at < ?
      ORDER BY si.signed_in_at`).all(from, to);
    res.json({
      date,
      signIns: rows
        .filter((r) => localDate(new Date(r.signedInAt), tz) === date)
        .map((r) => ({ ...r, time: formatTime(r.signedInAt, tz), notified: Boolean(r.notifiedAt) })),
    });
  });

  admin.delete('/signins/:id', (req, res) => {
    if (db.prepare('DELETE FROM sign_ins WHERE id = ?').run(toId(req.params.id)).changes === 0) throw notFound('Sign-in');
    res.json({ ok: true });
  });

  // ---------- Notify coaches ----------
  /** Sign-ins not yet emailed, grouped by sport, with each sport's coaches and email. */
  function pendingBySport() {
    const rows = db.prepare(`
      SELECT si.id, si.signed_in_at AS signedInAt, si.sport_id AS sportId,
             COALESCE(sp.name, 'No sport') AS sportName,
             st.first_name AS firstName, st.last_name AS lastName
      FROM sign_ins si
      JOIN students st ON st.id = si.student_id
      LEFT JOIN sports sp ON sp.id = si.sport_id
      WHERE si.notified_at IS NULL
      ORDER BY sp.name COLLATE NOCASE, si.signed_in_at`).all();
    const coachStmt = db.prepare('SELECT name, email FROM coaches WHERE sport_id = ? ORDER BY name COLLATE NOCASE');
    const groups = new Map();
    for (const r of rows) {
      const key = r.sportId ?? 0;
      if (!groups.has(key)) {
        groups.set(key, {
          sportId: r.sportId,
          sportName: r.sportName,
          coaches: r.sportId ? coachStmt.all(r.sportId) : [],
          signIns: [],
        });
      }
      groups.get(key).signIns.push(r);
    }
    return [...groups.values()].map((g) => ({ ...g, email: buildEmail(g) }));
  }

  function buildEmail({ sportName, signIns }) {
    const days = new Map();
    for (const s of signIns) {
      const day = formatDay(s.signedInAt, tz);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ name: `${s.firstName} ${s.lastName}`, time: formatTime(s.signedInAt, tz) });
    }
    const dayNames = [...days.keys()];
    const range = dayNames.length === 1 ? dayNames[0] : `${dayNames[0]} – ${dayNames[dayNames.length - 1]}`;
    const subject = `${config.appName}: ${sportName} sign-ins (${range})`;
    const count = signIns.length;
    const intro = `${count} ${sportName} athlete${count === 1 ? '' : 's'} signed in to the weight room:`;

    let text = `${intro}\n`;
    let html = `<p>${escapeHtml(intro)}</p>`;
    for (const [day, list] of days) {
      text += `\n${day}\n${list.map((x) => `  ${x.time.padStart(8)}  ${x.name}`).join('\n')}\n`;
      html += `<h3 style="margin:16px 0 4px">${escapeHtml(day)}</h3><table cellpadding="4" style="border-collapse:collapse">`
        + list.map((x) => `<tr><td style="color:#555">${escapeHtml(x.time)}</td><td>${escapeHtml(x.name)}</td></tr>`).join('')
        + '</table>';
    }
    text += `\n— ${config.appName}\n`;
    html += `<p style="color:#777;margin-top:16px">— ${escapeHtml(config.appName)}</p>`;
    return { subject, text, html };
  }

  admin.get('/notify/preview', (_req, res) => {
    res.json({ emailConfigured: mailer.configured, groups: pendingBySport() });
  });

  admin.post('/notify', async (_req, res) => {
    const groups = pendingBySport();
    if (!mailer.configured) {
      throw new HttpError(503, 'Email is not set up yet, so nothing was sent. See the README to add SMTP settings.');
    }
    const results = [];
    for (const g of groups) {
      const withEmail = g.coaches.filter((c) => c.email);
      if (!withEmail.length) {
        const reason = g.coaches.length ? 'No coach email addresses on file' : 'No coaches on file';
        results.push({ sportName: g.sportName, status: 'skipped', reason, count: g.signIns.length });
        continue;
      }
      const to = withEmail.map((c) => (c.name ? `"${c.name.replace(/"/g, '')}" <${c.email}>` : c.email));
      try {
        await mailer.send({ to, ...g.email });
      } catch (err) {
        results.push({ sportName: g.sportName, status: 'failed', reason: err.message, count: g.signIns.length });
        continue;
      }
      const sentAt = now().toISOString();
      tx(db, () => {
        const mark = db.prepare('UPDATE sign_ins SET notified_at = ? WHERE id = ?');
        for (const s of g.signIns) mark.run(sentAt, s.id);
        db.prepare(`INSERT INTO notifications (sent_at, sport_name, recipients, sign_in_count)
          VALUES (?, ?, ?, ?)`).run(sentAt, g.sportName, withEmail.map((c) => c.email).join(', '), g.signIns.length);
      });
      results.push({ sportName: g.sportName, status: 'sent', to: withEmail.map((c) => c.email), count: g.signIns.length });
    }
    res.json({ results });
  });

  admin.get('/notifications', (_req, res) => {
    const rows = db.prepare(`SELECT id, sent_at AS sentAt, sport_name AS sportName, recipients,
      sign_in_count AS count FROM notifications ORDER BY sent_at DESC LIMIT 50`).all();
    res.json({
      notifications: rows.map((r) => ({ ...r, when: `${formatDay(r.sentAt, tz)}, ${formatTime(r.sentAt, tz)}` })),
    });
  });

  // ---------- user accounts (admin only) ----------
  const adminOnly = requireRole(['admin']);
  const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;

  function userFields(body, { requirePassword }) {
    const email = users.normalizeEmail(body?.email);
    if (!users.isValidEmail(email)) throw bad('Please enter a valid email address');
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const role = body?.role;
    if (!users.ROLES.includes(role)) throw bad('Please choose a role');
    const password = body?.password ? checkPassword(body.password) : null;
    if (requirePassword && !password) throw bad(`Password must be at least ${users.MIN_PASSWORD} characters`);
    return { email, name, role, password };
  }

  admin.get('/users', adminOnly, (_req, res) => {
    const rows = db.prepare(`SELECT id, email, name, role, created_at AS createdAt FROM users
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, name COLLATE NOCASE, email`).all();
    res.json({ users: rows });
  });

  admin.post('/users', adminOnly, async (req, res) => {
    const f = userFields(req.body, { requirePassword: true });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(f.email)) throw bad(`${f.email} already has an account`);
    const id = await users.createUser(db, f);
    res.status(201).json({ user: { id, email: f.email, name: f.name, role: f.role } });
  });

  admin.put('/users/:id', adminOnly, async (req, res) => {
    const id = toId(req.params.id);
    const existing = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!existing) throw notFound('User');
    const f = userFields(req.body, { requirePassword: false });
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(f.email, id)) {
      throw bad(`${f.email} already has an account`);
    }
    if (existing.role === 'admin' && f.role !== 'admin' && adminCount() === 1) {
      throw bad('There must be at least one admin');
    }
    db.prepare('UPDATE users SET email = ?, name = ?, role = ? WHERE id = ?').run(f.email, f.name, f.role, id);
    if (f.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await users.hashPassword(f.password), id);
    }
    if (f.password || f.role !== existing.role) {
      // Force a fresh login with the new password or role (but keep the current admin's own session).
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(id, req.tokenHash);
    }
    res.json({ ok: true });
  });

  admin.delete('/users/:id', adminOnly, (req, res) => {
    const id = toId(req.params.id);
    if (id === req.user.id) throw bad("You can't delete your own account");
    if (db.prepare('DELETE FROM users WHERE id = ?').run(id).changes === 0) throw notFound('User');
    res.json({ ok: true });
  });

  app.use('/api', kiosk);
  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  // ---------- pages ----------
  const views = path.join(__dirname, '..', 'views');
  const page = (file, roles) => (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!roles) return res.sendFile(path.join(views, file));
    if (!req.user || !roles.includes(req.user.role)) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    res.sendFile(path.join(views, file));
  };
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/login', page('login.html'));
  app.get('/w/:token', (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex');
    page('workout.html')(req, res);
  });
  app.get('/', page('index.html', ANYONE));
  app.get('/admin', page('admin.html', STAFF));
  // "no-cache" = browsers may keep a copy but must check for a newer one each time,
  // so the kiosk iPad picks up new versions right after a deploy.
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
