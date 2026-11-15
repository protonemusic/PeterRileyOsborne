'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { tx } = require('./db');
const { localDate, formatTime, formatDay, isValidDate } = require('./time');

const COOKIE = 'wr_admin';
const SESSION_HOURS = 12;

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
  const app = express();
  app.disable('x-powered-by');
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

  // ---------- admin session ----------
  const secret = crypto.createHash('sha256')
    .update(`${config.sessionSecret || ''}:${config.adminPassword}`).digest();
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function makeToken() {
    const exp = String(now().getTime() + SESSION_HOURS * 3600 * 1000);
    return `${exp}.${sign(exp)}`;
  }

  function validToken(token) {
    if (!token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig) return false;
    const expected = Buffer.from(sign(exp));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
    return Number(exp) > now().getTime();
  }

  function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function cookieHeader(value, maxAgeSec) {
    const secure = config.secureCookies ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  }

  function requireAdmin(req, _res, next) {
    if (!validToken(readCookie(req, COOKIE))) return next(new HttpError(401, 'Please log in'));
    next();
  }

  function passwordMatches(given) {
    const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
    const b = crypto.createHash('sha256').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // ---------- kiosk (public) API ----------
  app.get('/api/sports', (_req, res) => {
    const active = inSeasonSports();
    if (active.length) return res.json({ sports: active, inSeasonOnly: true });
    const all = db.prepare('SELECT id, name FROM sports ORDER BY name COLLATE NOCASE').all();
    res.json({ sports: all, inSeasonOnly: false });
  });

  app.get('/api/students/search', (req, res) => {
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

  app.post('/api/signup', (req, res) => {
    const firstName = cleanName(req.body?.firstName, 'First name');
    const lastName = cleanName(req.body?.lastName, 'Last name');
    const sport = requireSport(req.body?.sportId);
    const existing = db.prepare(`SELECT id FROM students
      WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE`).get(firstName, lastName);
    if (existing) {
      throw new HttpError(409, `${firstName} ${lastName} is already signed up. Use Sign In instead.`);
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO students (first_name, last_name, sport_id, created_at)
      VALUES (?, ?, ?, ?)`).run(firstName, lastName, sport.id, now().toISOString());
    res.status(201).json({
      student: { id: Number(lastInsertRowid), firstName, lastName, sportId: sport.id, sportName: sport.name },
    });
  });

  app.post('/api/signin', (req, res) => {
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
    const last = db.prepare(`SELECT signed_in_at FROM sign_ins WHERE student_id = ?
      ORDER BY signed_in_at DESC LIMIT 1`).get(studentId);
    if (last && localDate(new Date(last.signed_in_at), tz) === today()) {
      return res.json({ alreadySignedIn: true, name, time: formatTime(last.signed_in_at, tz) });
    }

    const signedInAt = now().toISOString();
    db.prepare('INSERT INTO sign_ins (student_id, sport_id, signed_in_at) VALUES (?, ?, ?)')
      .run(studentId, sportId, signedInAt);
    res.status(201).json({ alreadySignedIn: false, name, time: formatTime(signedInAt, tz) });
  });

  // ---------- admin API ----------
  app.post('/api/admin/login', (req, res) => {
    if (!passwordMatches(req.body?.password)) throw new HttpError(401, 'Wrong password');
    res.setHeader('Set-Cookie', cookieHeader(makeToken(), SESSION_HOURS * 3600));
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (_req, res) => {
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use(requireAdmin);
  app.use('/api/admin', admin);

  admin.get('/me', (_req, res) => {
    res.json({ ok: true, emailConfigured: mailer.configured, today: today(), timeZone: tz });
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

  admin.post('/sports/:id/coaches', (req, res) => {
    const sportId = toId(req.params.id);
    if (!getSport(sportId)) throw notFound('Sport');
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) || email.length > 254) {
      throw bad('Please enter a valid email address');
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO coaches (sport_id, name, email) VALUES (?, ?, ?)')
      .run(sportId, name, email);
    res.status(201).json({ id: Number(lastInsertRowid), sportId, name, email });
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
      if (!g.coaches.length) {
        results.push({ sportName: g.sportName, status: 'skipped', reason: 'No coaches on file', count: g.signIns.length });
        continue;
      }
      const to = g.coaches.map((c) => (c.name ? `"${c.name.replace(/"/g, '')}" <${c.email}>` : c.email));
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
          VALUES (?, ?, ?, ?)`).run(sentAt, g.sportName, g.coaches.map((c) => c.email).join(', '), g.signIns.length);
      });
      results.push({ sportName: g.sportName, status: 'sent', to: g.coaches.map((c) => c.email), count: g.signIns.length });
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

  // ---------- pages ----------
  const pub = path.join(__dirname, '..', 'public');
  app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.use(express.static(pub));

  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

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
