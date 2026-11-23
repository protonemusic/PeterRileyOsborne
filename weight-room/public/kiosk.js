'use strict';

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.replace('/login?next=/');
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function showMessage(el, text, kind = 'error') {
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}

// ---------- tabs ----------
const panels = { signin: $('panel-signin'), signup: $('panel-signup'), success: $('panel-success') };
const tabs = { signin: $('tab-signin'), signup: $('tab-signup') };

function showPanel(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
  for (const [key, el] of Object.entries(tabs)) el.setAttribute('aria-selected', String(key === name));
  document.querySelector('.tabs').hidden = name === 'success';
}
tabs.signin.addEventListener('click', () => { resetSignIn(); showPanel('signin'); $('name-search').focus(); });
tabs.signup.addEventListener('click', () => { resetSignUp(); showPanel('signup'); $('first-name').focus(); });

// ---------- sports ----------
let sports = [];
async function loadSports() {
  try {
    sports = (await api('/api/sports')).sports;
  } catch {
    sports = [];
  }
  fillSportChecks($('signup-sports'), []);
}

/** Checkboxes for every sport, in-season ones first. Any number can be chosen. */
function fillSportChecks(fieldset, selectedIds) {
  const box = fieldset.querySelector('.sport-check-groups');
  const chosen = new Set(selectedIds);
  box.replaceChildren();
  const inSeason = sports.filter((s) => s.inSeason);
  const other = sports.filter((s) => !s.inSeason);
  const group = (title, list) => {
    if (!list.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'sport-check-group';
    const h = document.createElement('div');
    h.className = 'sport-check-title';
    h.textContent = title;
    wrap.append(h);
    for (const s of list) {
      const label = document.createElement('label');
      label.className = 'sport-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = s.id;
      input.checked = chosen.has(s.id);
      label.append(input, document.createTextNode(s.name));
      wrap.append(label);
    }
    box.append(wrap);
  };
  group('In season', inSeason);
  group(inSeason.length ? 'Other sports' : 'All sports', other);
  if (!sports.length) box.textContent = 'No sports have been added yet.';
}

const checkedSports = (fieldset) => [...fieldset.querySelectorAll('input:checked')].map((i) => Number(i.value));

// ---------- sign in ----------
const search = $('name-search');
const suggestions = $('suggestions');
let results = [];
let active = -1;
let selected = null;
let searchTimer = null;
let searchSeq = 0;

function closeSuggestions() {
  suggestions.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  active = -1;
}

function renderSuggestions(query) {
  suggestions.replaceChildren();
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `No one found for “${query}”. New here? Tap “Sign Up”.`;
    suggestions.append(li);
  }
  results.forEach((s, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.id = `opt-${s.id}`;
    li.setAttribute('aria-selected', String(i === active));
    const name = document.createElement('span');
    name.textContent = `${s.firstName} ${s.lastName}`;
    const sport = document.createElement('span');
    sport.className = 'muted';
    sport.textContent = s.sportName || '';
    li.append(name, sport);
    // pointerdown fires before the input loses focus
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(s); });
    suggestions.append(li);
  });
  suggestions.hidden = false;
  search.setAttribute('aria-expanded', 'true');
}

search.addEventListener('input', () => {
  const q = search.value.trim();
  showMessage($('signin-msg'), '');
  clearTimeout(searchTimer);
  if (!q) { closeSuggestions(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const data = await api(`/api/students/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return; // a newer search is in flight
      results = data.students;
      active = results.length ? 0 : -1;
      renderSuggestions(q);
    } catch (err) {
      showMessage($('signin-msg'), err.message);
    }
  }, 150);
});

search.addEventListener('keydown', (e) => {
  if (suggestions.hidden || !results.length) return;
  if (e.key === 'ArrowDown') { active = (active + 1) % results.length; renderSuggestions(search.value); e.preventDefault(); }
  if (e.key === 'ArrowUp') { active = (active - 1 + results.length) % results.length; renderSuggestions(search.value); e.preventDefault(); }
  if (e.key === 'Enter' && active >= 0) { choose(results[active]); e.preventDefault(); }
  if (e.key === 'Escape') closeSuggestions();
});
search.addEventListener('blur', () => setTimeout(closeSuggestions, 100));

function choose(student) {
  selected = student;
  closeSuggestions();
  $('search-box').hidden = true;
  $('selected-box').hidden = false;
  $('selected-name').textContent = `${student.firstName} ${student.lastName}`;
  // Their sports are shown; "Change" opens the checkboxes. A student with no sports must pick.
  fillSportChecks($('signin-sports'), student.sportIds || []);
  $('signin-sports-text').textContent = student.sportName || 'None yet';
  const pick = !(student.sportIds || []).length;
  $('signin-sports').hidden = !pick;
  $('signin-sports-change').hidden = pick;
  $('signin-sports-change').setAttribute('aria-expanded', String(pick));
  $('signin-btn').disabled = false;
  $('signin-btn').focus();
}

function resetSignIn() {
  selected = null;
  results = [];
  search.value = '';
  $('search-box').hidden = false;
  $('selected-box').hidden = true;
  $('signin-btn').disabled = true;
  showMessage($('signin-msg'), '');
  closeSuggestions();
}
$('change-name').addEventListener('click', () => { resetSignIn(); search.focus(); });
$('signin-sports-change').addEventListener('click', () => {
  $('signin-sports').hidden = false;
  $('signin-sports-change').hidden = true;
  $('signin-sports-change').setAttribute('aria-expanded', 'true');
  $('signin-sports').querySelector('input')?.focus();
});

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selected) return;
  const btn = $('signin-btn');
  btn.disabled = true;
  try {
    const data = await api('/api/signin', {
      method: 'POST',
      // Only send sports if they opened "Change" (or had none).
      body: { studentId: selected.id, ...($('signin-sports').hidden ? {} : { sportIds: checkedSports($('signin-sports')) }) },
    });
    const first = data.name.split(' ')[0];
    showSuccess(
      data.alreadySignedIn ? `You're already in, ${first}!` : `Welcome, ${first}!`,
      data.alreadySignedIn ? `You signed in today at ${data.time}.` : `Signed in at ${data.time}. Have a great lift.`,
      data,
    );
  } catch (err) {
    showMessage($('signin-msg'), err.message);
    btn.disabled = false;
  }
});

// ---------- sign up ----------
function resetSignUp() {
  $('signup-form').reset();
  fillSportChecks($('signup-sports'), []);
  showMessage($('signup-msg'), '');
}

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    // Signing up also signs the student in for their first day.
    const data = await api('/api/signup', {
      method: 'POST',
      body: {
        firstName: $('first-name').value,
        lastName: $('last-name').value,
        sportIds: checkedSports($('signup-sports')),
      },
    });
    resetSignUp();
    resetSignIn();
    showBanner('Sign-up Successful! You are now signed in for your first day!');
    showSuccess(`Welcome, ${data.student.firstName}!`, `Signed in at ${data.time}. Have a great lift.`, data);
  } catch (err) {
    showMessage($('signup-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- success ----------
let successTimer = null;
function showSuccess(title, detail, data = {}) {
  $('success-title').textContent = title;
  $('success-detail').textContent = detail;
  const w = data.workout || { status: 'none' };
  const hasQr = Boolean(data.qrSvg);
  $('success-workout').hidden = !hasQr;
  if (hasQr) {
    if (w.status === 'complete') {
      $('workout-eyebrow').textContent = 'Program complete';
      $('workout-label').textContent = "You've finished every workout!";
      $('workout-sub').textContent = 'Scan to see your workout history.';
    } else {
      $('workout-eyebrow').textContent = `Today's workout · Day ${w.dayNumber} of ${w.totalDays}`;
      $('workout-label').textContent = w.label;
      $('workout-sub').textContent = w.restarted
        ? 'You missed more than 5 weight room days, so you are starting over at Day 1.'
        : 'Scan to open it on your phone and log your sets.';
    }
    // The SVG is generated by our own server from the student's link.
    $('workout-qr').innerHTML = data.qrSvg;
  } else {
    $('workout-qr').replaceChildren();
  }
  showPanel('success');
  clearTimeout(successTimer);
  // Leave time to scan the code.
  successTimer = setTimeout(finish, hasQr ? 45000 : 5000);
}
function finish() {
  clearTimeout(successTimer);
  showBanner('');
  resetSignIn();
  showPanel('signin');
  loadSports();
}

function showBanner(text) {
  $('top-banner').textContent = text;
  $('top-banner').hidden = !text;
}
$('success-done').addEventListener('click', finish);

loadSports();

// ---------- Admin link ----------
// Only staff and admins see it (never a kiosk/student account), and it asks for the
// password again so nobody at the kiosk can open the admin page.
let me = null;
api('/api/me').then(({ user }) => { me = user; $('admin-link').hidden = user.role === 'kiosk'; }).catch(() => {});

$('admin-open').addEventListener('click', (e) => {
  e.preventDefault();
  if (!me || me.role === 'kiosk') return;
  $('admin-who').textContent = me.name || me.email;
  $('admin-password').value = '';
  showMessage($('admin-msg'), '');
  $('admin-dialog').showModal();
  $('admin-password').focus();
});
$('admin-cancel').addEventListener('click', () => $('admin-dialog').close());
$('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await fetch('/api/confirm-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('admin-password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Wrong password');
    location.href = '/admin';
  } catch (err) {
    showMessage($('admin-msg'), err.message);
    $('admin-password').select();
  } finally {
    btn.disabled = false;
  }
});
