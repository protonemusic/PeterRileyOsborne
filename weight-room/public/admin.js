'use strict';

const $ = (id) => document.getElementById(id);

/** Tiny element builder: h('td', { className: 'x', onclick }, 'text', child) */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v !== undefined && v !== null && v !== false) el[k] = v;
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login?next=/admin'); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function showMessage(el, text, kind = 'error') {
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}
const flash = (text, kind) => showMessage($('global-msg'), text, kind);

/** Run an action; report errors in the global message bar. */
async function act(fn) {
  try { await fn(); } catch (err) { if (err.message !== 'Please log in') flash(err.message); }
}

let state = { sports: [], emailConfigured: false, today: '' };

// ---------- auth ----------
$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
});

async function start() {
  const me = await api('/api/admin/me');
  state.emailConfigured = me.emailConfigured;
  state.today = me.today;
  state.user = me.user;
  $('whoami').textContent = `Logged in as ${me.user.name || me.user.email} (${me.user.role})`;
  $('nav-users').hidden = me.user.role !== 'admin';
  if (!$('signin-date').value) $('signin-date').value = me.today;
  await loadSports();
  await showView(currentView);
}

// ---------- views ----------
let currentView = 'today';
const loaders = {
  today: () => Promise.all([loadPreview(), loadSignIns()]),
  sports: () => loadSports().then(renderSports),
  students: () => loadSports().then(loadStudents),
  history: loadHistory,
  bests: () => loadSports().then(loadBests),
  users: loadUsers,
  workouts: loadPrograms,
  account: async () => {},
};

async function showView(view) {
  currentView = view;
  document.querySelectorAll('.nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== view; });
  flash('');
  await act(loaders[view]);
}
document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

async function loadSports() {
  state.sports = (await api('/api/admin/sports')).sports;
}

function sportSelect(current, { allowNone = true } = {}) {
  const sel = h('select');
  if (allowNone) sel.append(new Option('— none —', ''));
  for (const s of state.sports) sel.append(new Option(s.name, s.id, false, s.id === current));
  return sel;
}

// ---------- notify ----------
async function loadPreview() {
  const { groups, emailConfigured } = await api('/api/admin/notify/preview');
  const box = $('notify-preview');
  box.replaceChildren();
  $('notify-btn').disabled = !groups.length;

  if (!emailConfigured) {
    showMessage($('notify-msg'), 'Email is not set up yet. You can see what would be sent below, but nothing will go out until SMTP settings are added (see README).', 'warn');
  } else if (!$('notify-msg').classList.contains('ok')) {
    showMessage($('notify-msg'), '');
  }

  if (!groups.length) {
    box.append(h('p', { className: 'muted' }, 'No new sign-ins to report. Coaches are up to date.'));
    return;
  }
  for (const g of groups) {
    const withEmail = g.coaches.filter((c) => c.email);
    const noEmail = g.coaches.filter((c) => !c.email);
    const coaches = withEmail.length
      ? withEmail.map((c) => (c.name ? `${c.name} <${c.email}>` : c.email)).join(', ')
      : null;
    box.append(h('div', { className: 'notify-group' },
      h('h3', {}, h('span', {}, g.sportName), h('span', { className: 'pill' }, `${g.signIns.length} sign-in${g.signIns.length === 1 ? '' : 's'}`)),
      coaches
        ? h('div', { className: 'small' }, h('span', { className: 'muted' }, 'To: '), coaches)
        : h('div', { className: 'small', style: 'color:var(--warn)' }, !g.sportId
          ? 'These sign-ins have no sport, so there is no one to email.'
          : g.coaches.length
            ? 'No coach email addresses on file for this sport. Add one under Sports, Seasons & Coaches.'
            : 'No coaches on file for this sport. Add one under Sports, Seasons & Coaches.'),
      coaches && noEmail.length
        ? h('div', { className: 'small', style: 'color:var(--warn)' }, `Not emailed (no address on file): ${noEmail.map((c) => c.name).join(', ')}`)
        : null,
      h('details', {}, h('summary', {}, 'Preview email'),
        h('p', { className: 'small' }, h('strong', {}, 'Subject: '), g.email.subject),
        h('pre', { className: 'email' }, g.email.text)),
    ));
  }
}

$('notify-btn').addEventListener('click', () => act(async () => {
  const btn = $('notify-btn');
  if (!state.emailConfigured) {
    showMessage($('notify-msg'), 'Email is not set up yet, so nothing can be sent. Add SMTP settings (see README) and restart the app.', 'warn');
    return;
  }
  if (!confirm('Send sign-in emails to coaches now?')) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const { results } = await api('/api/admin/notify', { method: 'POST' });
    const sent = results.filter((r) => r.status === 'sent');
    const lines = results.map((r) => (r.status === 'sent'
      ? `✓ ${r.sportName}: ${r.count} sign-in${r.count === 1 ? '' : 's'} sent to ${r.to.join(', ')}`
      : `✗ ${r.sportName}: ${r.reason}`));
    const kind = sent.length === results.length ? 'ok' : sent.length ? 'warn' : 'error';
    showMessage($('notify-msg'), results.length ? lines.join('\n') : 'Nothing to send.', kind);
    $('notify-msg').style.whiteSpace = 'pre-line';
  } finally {
    btn.textContent = 'Notify Coaches';
    await Promise.all([loadPreview(), loadSignIns()]);
  }
}));

// ---------- sign-ins ----------
async function loadSignIns() {
  const date = $('signin-date').value || state.today;
  const { signIns } = await api(`/api/admin/signins?date=${date}`);
  const body = $('signin-rows');
  body.replaceChildren();
  if (!signIns.length) {
    body.append(h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'No sign-ins on this day.')));
    return;
  }
  for (const s of signIns) {
    body.append(h('tr', {},
      h('td', {}, s.time),
      h('td', {}, s.name),
      h('td', {}, s.sportName || '—'),
      h('td', {}, h('span', { className: `pill ${s.notified ? 'ok' : 'warn'}` }, s.notified ? 'Notified' : 'Pending')),
      h('td', { className: 'actions' }, h('button', {
        className: 'link danger',
        onclick: () => act(async () => {
          if (!confirm(`Remove ${s.name}'s sign-in at ${s.time}?`)) return;
          await api(`/api/admin/signins/${s.id}`, { method: 'DELETE' });
          await Promise.all([loadSignIns(), loadPreview()]);
        }),
      }, 'Remove')),
    ));
  }
}
$('signin-date').addEventListener('change', () => act(loadSignIns));

// ---------- sports, seasons, coaches ----------
$('add-sport-form').addEventListener('submit', (e) => act(async () => {
  e.preventDefault();
  await api('/api/admin/sports', { method: 'POST', body: { name: $('new-sport').value } });
  $('new-sport').value = '';
  await loadSports();
  renderSports();
}));

// Which sport entries are expanded (remembered on this device).
const expandedSports = new Set((() => {
  try { return JSON.parse(localStorage.getItem('wr-expanded-sports') || '[]'); } catch { return []; }
})());
function saveExpanded() {
  try { localStorage.setItem('wr-expanded-sports', JSON.stringify([...expandedSports])); } catch { /* ignore */ }
}

const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function renderSports() {
  const list = $('sports-list');
  list.replaceChildren();
  if (!state.sports.length) {
    list.append(h('p', { className: 'muted' }, 'No sports yet. Add your first one above.'));
    return;
  }
  const refresh = async () => { await loadSports(); renderSports(); };

  for (const sport of state.sports) {
    const seasonLabel = h('input', { placeholder: 'Label (e.g. Fall 2026)', maxLength: 50 });
    const seasonStart = h('input', { type: 'date', required: true, title: 'Start date' });
    const seasonEnd = h('input', { type: 'date', required: true, title: 'End date' });
    const coachName = h('input', { placeholder: 'Coach name' , maxLength: 80 });
    const coachEmail = h('input', { type: 'email', placeholder: 'coach@school.org (optional)' });

    const missingEmail = sport.coaches.filter((c) => !c.email).length;
    const coachCount = `${sport.coaches.length} coach${sport.coaches.length === 1 ? '' : 'es'}`
      + (missingEmail ? ` · ${missingEmail} need${missingEmail === 1 ? 's' : ''} email` : '');
    const details = h('details', {
      className: 'sport',
      open: expandedSports.has(sport.id),
      ontoggle: () => {
        if (details.open) expandedSports.add(sport.id); else expandedSports.delete(sport.id);
        saveExpanded();
      },
    },
      h('summary', { className: 'sport-head' },
        h('span', { className: 'chevron', ariaHidden: 'true' }),
        h('h3', {}, sport.name),
        h('span', { className: `pill ${sport.inSeason ? 'ok' : ''}` }, sport.inSeason ? 'In season' : 'Out of season'),
        h('span', { className: `pill ${sport.gender ? '' : 'warn'}` },
          sport.gender === 'boys' ? 'Boys' : sport.gender === 'girls' ? 'Girls' : 'Boys/Girls not set'),
        h('span', { className: 'spacer' }),
        h('span', { className: 'muted small' }, coachCount),
      ),
      h('div', { className: 'sport-actions' },
        // Boys/girls decides which Hall of Fame list this sport's students appear in.
        h('div', { className: 'segmented', role: 'radiogroup', ariaLabel: `${sport.name}: boys or girls` },
          ['boys', 'girls'].map((g) => h('button', {
            type: 'button', role: 'radio', ariaChecked: String(sport.gender === g),
            onclick: () => act(async () => {
              await api(`/api/admin/sports/${sport.id}/gender`, { method: 'PUT', body: { gender: g } });
              await refresh();
            }),
          }, g === 'boys' ? 'Boys' : 'Girls'))),
        h('span', { className: 'spacer' }),
        h('button', {
          className: 'link',
          onclick: () => act(async () => {
            const name = prompt('Rename sport', sport.name);
            if (!name || name === sport.name) return;
            await api(`/api/admin/sports/${sport.id}`, { method: 'PUT', body: { name } });
            await refresh();
          }),
        }, 'Rename'),
        h('button', {
          className: 'link danger',
          onclick: () => act(async () => {
            if (!confirm(`Delete ${sport.name}? Its seasons and coaches are removed too. Students keep their records but lose this sport.`)) return;
            await api(`/api/admin/sports/${sport.id}`, { method: 'DELETE' });
            await refresh();
          }),
        }, 'Delete'),
      ),

      h('div', { className: 'sub' }, 'Seasons'),
      sport.seasons.length
        ? h('ul', { className: 'list' }, sport.seasons.map((se) => h('li', {},
          h('span', {},
            se.label ? h('strong', {}, `${se.label}: `) : null,
            `${fmtDate(se.startDate)} – ${fmtDate(se.endDate)} `,
            se.current ? h('span', { className: 'pill ok' }, 'Current') : null),
          h('span', {},
            h('button', { className: 'link', onclick: () => act(async () => {
              const startDate = prompt('Start date (YYYY-MM-DD)', se.startDate);
              if (!startDate) return;
              const endDate = prompt('End date (YYYY-MM-DD)', se.endDate);
              if (!endDate) return;
              await api(`/api/admin/seasons/${se.id}`, { method: 'PUT', body: { label: se.label, startDate, endDate } });
              await refresh();
            }) }, 'Edit'),
            h('button', { className: 'link danger', onclick: () => act(async () => {
              if (!confirm('Delete this season?')) return;
              await api(`/api/admin/seasons/${se.id}`, { method: 'DELETE' });
              await refresh();
            }) }, 'Delete')),
        )))
        : h('p', { className: 'muted small' }, 'No seasons yet.'),
      h('form', {
        className: 'inline-form',
        onsubmit: (e) => act(async () => {
          e.preventDefault();
          await api(`/api/admin/sports/${sport.id}/seasons`, {
            method: 'POST',
            body: { label: seasonLabel.value, startDate: seasonStart.value, endDate: seasonEnd.value },
          });
          await refresh();
        }),
      }, seasonLabel, seasonStart, seasonEnd, h('button', { type: 'submit' }, 'Add Season')),

      h('div', { className: 'sub' }, 'Coaches'),
      sport.coaches.length
        ? h('ul', { className: 'list' }, sport.coaches.map((c) => h('li', {},
          h('span', {},
            c.name ? h('strong', {}, `${c.name} `) : null,
            c.email ? h('span', { className: 'muted' }, c.email) : h('span', { className: 'pill warn' }, 'No email')),
          h('span', {},
            h('button', { className: 'link', onclick: () => act(async () => {
              const name = prompt('Coach name', c.name);
              if (name === null) return;
              const email = prompt(`Email for ${name || 'this coach'}`, c.email);
              if (email === null) return;
              await api(`/api/admin/coaches/${c.id}`, { method: 'PUT', body: { name, email } });
              await refresh();
            }) }, c.email ? 'Edit' : 'Add Email'),
            h('button', { className: 'link danger', onclick: () => act(async () => {
              if (!confirm(`Remove ${c.name || c.email}?`)) return;
              await api(`/api/admin/coaches/${c.id}`, { method: 'DELETE' });
              await refresh();
            }) }, 'Remove')),
        )))
        : h('p', { className: 'muted small' }, 'No coaches yet. Add one so they get sign-in emails.'),
      h('form', {
        className: 'inline-form',
        onsubmit: (e) => act(async () => {
          e.preventDefault();
          await api(`/api/admin/sports/${sport.id}/coaches`, {
            method: 'POST', body: { name: coachName.value, email: coachEmail.value },
          });
          await refresh();
        }),
      }, coachName, coachEmail, h('button', { type: 'submit' }, 'Add Coach')),
    );
    list.append(details);
  }
}

// ---------- students ----------
let students = [];
async function loadStudents() {
  students = (await api('/api/admin/students')).students;
  renderStudents();
}

function renderStudents() {
  const q = $('student-filter').value.trim().toLowerCase();
  const body = $('student-rows');
  body.replaceChildren();
  const shown = students.filter((s) => `${s.firstName} ${s.lastName}`.toLowerCase().includes(q));
  if (!shown.length) {
    body.append(h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, students.length ? 'No matches.' : 'No students have signed up yet.')));
    return;
  }
  for (const s of shown) {
    const first = h('input', { value: s.firstName, maxLength: 50 });
    const last = h('input', { value: s.lastName, maxLength: 50 });
    const sport = sportSelect(s.sportId);
    body.append(h('tr', {},
      h('td', {}, first), h('td', {}, last), h('td', {}, sport),
      h('td', {}, String(s.signInCount)),
      h('td', { className: 'small' }, s.lastSignIn || '—'),
      h('td', { className: 'small' }, s.workout || '—'),
      h('td', { className: 'actions' },
        h('button', { className: 'link', title: "Open this student's workout page", onclick: () => act(async () => {
          // Open the window first so iPad Safari doesn't block it as a pop-up.
          const win = window.open('', '_blank');
          const { url } = await api(`/api/admin/students/${s.id}/workout-link`, { method: 'POST', body: {} });
          if (win) win.location = url; else location.href = url;
        }) }, 'Workouts'),
        h('button', { className: 'link', title: 'Make a new workout link; the old QR link stops working', onclick: () => act(async () => {
          if (!confirm(`Make a new workout link for ${s.firstName}? Their old link stops working. They'll get the new one next time they sign in.`)) return;
          await api(`/api/admin/students/${s.id}/workout-link`, { method: 'POST', body: { reset: true } });
          flash(`New workout link made for ${s.firstName} ${s.lastName}.`, 'ok');
        }) }, 'New Link'),
        h('button', { className: 'link', onclick: () => act(async () => {
          await api(`/api/admin/students/${s.id}`, {
            method: 'PUT', body: { firstName: first.value, lastName: last.value, sportId: sport.value || null },
          });
          flash(`Saved ${first.value} ${last.value}.`, 'ok');
          await loadStudents();
        }) }, 'Save'),
        h('button', { className: 'link danger', onclick: () => act(async () => {
          if (!confirm(`Delete ${s.firstName} ${s.lastName} and all of their sign-ins?`)) return;
          await api(`/api/admin/students/${s.id}`, { method: 'DELETE' });
          await loadStudents();
        }) }, 'Delete')),
    ));
  }
}
$('student-filter').addEventListener('input', renderStudents);

// ---------- history ----------
async function loadHistory() {
  const { notifications } = await api('/api/admin/notifications');
  const body = $('history-rows');
  body.replaceChildren();
  if (!notifications.length) {
    body.append(h('tr', {}, h('td', { colSpan: 4, className: 'muted' }, 'No emails sent yet.')));
    return;
  }
  for (const n of notifications) {
    body.append(h('tr', {}, h('td', {}, n.when), h('td', {}, n.sportName), h('td', {}, String(n.count)), h('td', { className: 'small' }, n.recipients)));
  }
}

// ---------- import ----------
// Default season dates for the current school year (July–June); adjust them on the page.
(function fillDefaultSeasons() {
  const now = new Date();
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const defaults = {
    fall: [`Fall ${y}`, `${y}-08-17`, `${y}-11-15`],
    winter: [`Winter ${y}–${String(y + 1).slice(2)}`, `${y}-11-16`, `${y + 1}-03-01`],
    spring: [`Spring ${y + 1}`, `${y + 1}-03-02`, `${y + 1}-06-06`],
  };
  for (const [key, [label, start, end]] of Object.entries(defaults)) {
    $(`imp-${key}-label`).value = label;
    $(`imp-${key}-start`).value = start;
    $(`imp-${key}-end`).value = end;
  }
})();

function importBody(dryRun) {
  const seasons = {};
  for (const key of ['fall', 'winter', 'spring']) {
    seasons[key] = { label: $(`imp-${key}-label`).value, startDate: $(`imp-${key}-start`).value, endDate: $(`imp-${key}-end`).value };
  }
  return { text: $('import-text').value, seasons, dryRun };
}

function renderImportResult({ dryRun, warnings, sports }) {
  const box = $('import-result');
  box.replaceChildren();
  const added = (r) => r.sportAdded || r.seasonsAdded.length || r.coachesAdded.length || r.coachesUpdated.length;
  const changes = sports.filter(added);
  box.append(h('p', {}, h('strong', {}, dryRun
    ? (changes.length ? `Preview: ${changes.length} of ${sports.length} sports will change. Nothing has been saved yet.` : 'Everything in this list is already in the app. Nothing to import.')
    : `Imported. ${changes.length} of ${sports.length} sports changed.`)));
  for (const w of warnings) box.append(h('div', { className: 'small', style: 'color:var(--warn)' }, w));
  const rows = sports.map((r) => h('tr', {},
    h('td', {}, r.name, r.sportAdded ? h('span', { className: 'pill ok', style: 'margin-left:6px' }, 'New') : null),
    h('td', { className: 'small' }, r.seasonsAdded.join(', ') || '—'),
    h('td', { className: 'small' }, [...r.coachesAdded, ...r.coachesUpdated.map((n) => `${n} (email added)`)].join(', ') || '—'),
  ));
  box.append(h('div', { className: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Sport'), h('th', {}, dryRun ? 'Seasons to add' : 'Seasons added'), h('th', {}, dryRun ? 'Coaches to add' : 'Coaches added'))),
    h('tbody', {}, rows))));
  $('import-run').disabled = !(dryRun && changes.length);
}

$('import-preview').addEventListener('click', () => act(async () => {
  renderImportResult(await api('/api/admin/import', { method: 'POST', body: importBody(true) }));
}));
// Any change after a preview means it has to be previewed again.
$('import-card').addEventListener('input', () => { $('import-run').disabled = true; });
$('import-run').addEventListener('click', () => act(async () => {
  const result = await api('/api/admin/import', { method: 'POST', body: importBody(false) });
  renderImportResult(result);
  $('import-run').disabled = true;
  await loadSports();
  renderSports();
}));

// ---------- workout programs ----------
async function loadPrograms() {
  const { programs } = await api('/api/admin/programs');
  const active = programs.find((p) => p.active);
  const cur = $('program-current');
  cur.replaceChildren(active
    ? h('div', {}, h('strong', {}, active.name), ` · ${active.totalDays} workouts · uploaded ${active.uploaded} · ${active.students} student${active.students === 1 ? '' : 's'} started`)
    : h('span', {}, 'No program yet. Upload one below. Until then, students sign in without a workout.'));

  const body = $('program-rows');
  body.replaceChildren();
  if (!programs.length) {
    body.append(h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'No programs uploaded yet.')));
  }
  for (const p of programs) {
    body.append(h('tr', {},
      h('td', {}, p.name, p.active ? h('span', { className: 'pill ok', style: 'margin-left:6px' }, 'Active') : null),
      h('td', {}, String(p.totalDays)),
      h('td', { className: 'small' }, p.uploaded),
      h('td', {}, String(p.students)),
      h('td', { className: 'actions' },
        h('button', { className: 'link', onclick: () => act(async () => {
          const { days } = await api(`/api/admin/programs/${p.id}/days`);
          renderProgramDays($('program-result'), days, [], `${p.name}: ${days.length} workouts`);
          $('program-save').disabled = true;
          $('program-result').scrollIntoView({ behavior: 'smooth' });
        }) }, 'View'),
        p.active ? null : h('button', { className: 'link', onclick: () => act(async () => {
          if (!confirm(`Make "${p.name}" the active program? Everyone starts it at Day 1 on their next sign-in.`)) return;
          await api(`/api/admin/programs/${p.id}/activate`, { method: 'POST' });
          await loadPrograms();
        }) }, 'Make Active'),
        h('button', { className: 'link danger', onclick: () => act(async () => {
          if (!confirm(`Delete "${p.name}"? Students' logged workouts for this program are deleted too.`)) return;
          await api(`/api/admin/programs/${p.id}`, { method: 'DELETE' });
          await loadPrograms();
        }) }, 'Delete')),
    ));
  }
}

function renderProgramDays(box, days, warnings, heading) {
  box.replaceChildren(h('p', {}, h('strong', {}, heading)));
  for (const w of warnings) box.append(h('div', { className: 'small', style: 'color:var(--warn)' }, w));
  for (const d of days) {
    box.append(h('details', { className: 'day-preview' },
      h('summary', {}, h('strong', {}, `Day ${d.dayNumber}`), ` · ${d.label}`, h('span', { className: 'muted small' }, ` · ${d.items.length} ${d.kind === 'weights' ? 'lifts' : 'drills'}`)),
      d.weekNote ? h('p', { className: 'muted small' }, d.weekNote) : null,
      h('ul', { className: 'list' }, d.items.map((it) => h('li', {},
        h('span', {}, it.code ? h('span', { className: 'muted' }, `${it.code} `) : null, it.priority ? h('strong', {}, `${it.name} ★`) : it.name),
        h('span', { className: 'muted' }, it.prescription || it.plan || '')))),
    ));
  }
}

function programFile() {
  const file = $('program-file').files[0];
  if (!file) throw new Error('Please choose a PDF or Word file first');
  return file;
}

async function uploadProgram(url, file) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login?next=/admin'); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

$('program-file').addEventListener('change', () => {
  const file = $('program-file').files[0];
  $('program-save').disabled = true;
  $('program-result').replaceChildren();
  if (file && !$('program-name').value) {
    $('program-name').value = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/^\d{6,}-/, '').trim();
  }
});

$('program-preview').addEventListener('click', () => act(async () => {
  const file = programFile();
  $('program-preview').disabled = true;
  try {
    const { days, warnings } = await uploadProgram('/api/admin/programs/preview', file);
    renderProgramDays($('program-result'), days, warnings,
      `Found ${days.length} workouts. Tap a day to check it. Nothing is saved until you tap Make Active.`);
    $('program-save').disabled = false;
  } finally {
    $('program-preview').disabled = false;
  }
}));

$('program-save').addEventListener('click', () => act(async () => {
  const file = programFile();
  const name = $('program-name').value.trim();
  if (!name) throw new Error('Please give the program a name');
  if (!confirm(`Make "${name}" the active program? Everyone starts it at Day 1 on their next sign-in.`)) return;
  $('program-save').disabled = true;
  const r = await uploadProgram(`/api/admin/programs?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`, file);
  flash(`"${name}" is now the active program (${r.days} workouts).`, 'ok');
  $('program-file').value = '';
  $('program-name').value = '';
  $('program-result').replaceChildren();
  await loadPrograms();
}));

// ---------- personal bests ----------
const fmtLb = (n) => (n == null ? '—' : n.toLocaleString());
const fmtSigned = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString()}`);
const fmtPct = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const fmtDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const changeClass = (n) => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

async function loadBests() {
  const sel = $('pb-sport');
  const chosen = sel.value;
  sel.replaceChildren(new Option('All', ''), ...state.sports.map((s) => new Option(s.name, s.id, false, String(s.id) === chosen)));
  const { rows, totals } = await api(`/api/admin/personal-bests${sel.value ? `?sportId=${sel.value}` : ''}`);
  const body = $('pb-rows');
  body.replaceChildren();
  if (!rows.length) {
    body.append(h('tr', {}, h('td', { colSpan: 13, className: 'muted' }, 'No strength tests logged yet for this group.')));
  }
  const numCells = (r) => [
    h('td', { className: 'num' }, fmtLb(r.starting_bench)), h('td', { className: 'num' }, fmtLb(r.current_bench)),
    h('td', { className: 'num' }, fmtLb(r.starting_squat)), h('td', { className: 'num' }, fmtLb(r.current_squat)),
    h('td', { className: 'num' }, fmtLb(r.starting_deadlift)), h('td', { className: 'num' }, fmtLb(r.current_deadlift)),
    h('td', { className: 'num' }, fmtLb(r.startingCombined)), h('td', { className: 'num' }, fmtLb(r.currentCombined)),
    h('td', { className: `num ${changeClass(r.increase)}` }, fmtSigned(r.increase)),
    h('td', { className: `num ${changeClass(r.percent)}` }, fmtPct(r.percent)),
  ];
  for (const r of rows) {
    body.append(h('tr', {},
      h('th', { scope: 'row' }, r.name, r.sportName ? h('div', { className: 'small muted' }, r.sportName) : null),
      h('td', {}, fmtDay(r.startDate)), h('td', {}, fmtDay(r.recentDate)),
      numCells(r)));
  }
  $('pb-foot').replaceChildren(h('tr', {},
    h('th', { scope: 'row' }, `Totals (${totals.students} student${totals.students === 1 ? '' : 's'})`),
    h('td', {}, ''), h('td', {}, ''),
    numCells(totals)));
}
$('pb-sport').addEventListener('change', () => act(loadBests));

// ---------- users ----------
const ROLE_LABELS = { admin: 'Admin', staff: 'Staff', kiosk: 'Kiosk' };

async function loadUsers() {
  const { users } = await api('/api/admin/users');
  const body = $('user-rows');
  body.replaceChildren();
  for (const u of users) {
    const name = h('input', { value: u.name, maxLength: 80 });
    const email = h('input', { type: 'email', value: u.email, autocapitalize: 'off' });
    const role = h('select');
    for (const [v, label] of Object.entries(ROLE_LABELS)) role.append(new Option(label, v, false, v === u.role));
    const password = h('input', { type: 'password', placeholder: 'unchanged', autocomplete: 'new-password' });
    const isMe = u.id === state.user.id;
    body.append(h('tr', {},
      h('td', {}, name), h('td', {}, email), h('td', {}, role), h('td', {}, password),
      h('td', { className: 'actions' },
        h('button', { className: 'link', onclick: () => act(async () => {
          await api(`/api/admin/users/${u.id}`, {
            method: 'PUT',
            body: { name: name.value, email: email.value, role: role.value, password: password.value || undefined },
          });
          flash(`Saved ${name.value || email.value}.`, 'ok');
          await loadUsers();
        }) }, 'Save'),
        isMe ? h('span', { className: 'pill' }, 'You') : h('button', { className: 'link danger', onclick: () => act(async () => {
          if (!confirm(`Delete the account for ${u.name || u.email}?`)) return;
          await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          await loadUsers();
        }) }, 'Delete')),
    ));
  }
}

$('add-user-form').addEventListener('submit', (e) => act(async () => {
  e.preventDefault();
  await api('/api/admin/users', {
    method: 'POST',
    body: { name: $('nu-name').value, email: $('nu-email').value, role: $('nu-role').value, password: $('nu-password').value },
  });
  flash(`Added ${$('nu-name').value || $('nu-email').value}.`, 'ok');
  e.target.reset();
  await loadUsers();
}));

// ---------- my account ----------
$('password-form').addEventListener('submit', (e) => act(async () => {
  e.preventDefault();
  await api('/api/me/password', {
    method: 'PUT', body: { currentPassword: $('pw-current').value, newPassword: $('pw-new').value },
  });
  e.target.reset();
  flash('Password changed. Any other devices using your account have been logged out.', 'ok');
}));

// ---------- boot ----------
act(start);
