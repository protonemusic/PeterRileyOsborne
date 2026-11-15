'use strict';

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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
  fillSportSelect($('signup-sport'), null);
}

function fillSportSelect(select, current) {
  const list = [...sports];
  if (current && !list.some((s) => s.id === current.id)) list.push(current);
  select.replaceChildren();
  if (!current) select.append(new Option('Choose your sport…', ''));
  for (const s of list) select.append(new Option(s.name, s.id, false, current?.id === s.id));
}

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
  fillSportSelect($('signin-sport'), student.sportId ? { id: student.sportId, name: student.sportName } : null);
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

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selected) return;
  const btn = $('signin-btn');
  btn.disabled = true;
  try {
    const data = await api('/api/signin', {
      method: 'POST',
      body: { studentId: selected.id, sportId: $('signin-sport').value || null },
    });
    const first = data.name.split(' ')[0];
    showSuccess(
      data.alreadySignedIn ? `You're already in, ${first}!` : `Welcome, ${first}!`,
      data.alreadySignedIn ? `You signed in today at ${data.time}.` : `Signed in at ${data.time}. Have a great lift.`,
    );
  } catch (err) {
    showMessage($('signin-msg'), err.message);
    btn.disabled = false;
  }
});

// ---------- sign up ----------
function resetSignUp() {
  $('signup-form').reset();
  fillSportSelect($('signup-sport'), null);
  showMessage($('signup-msg'), '');
}

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const { student } = await api('/api/signup', {
      method: 'POST',
      body: {
        firstName: $('first-name').value,
        lastName: $('last-name').value,
        sportId: $('signup-sport').value,
      },
    });
    resetSignUp();
    resetSignIn();
    showPanel('signin');
    choose(student);
    showMessage($('signin-msg'), "You're signed up! Now tap Sign In.", 'ok');
  } catch (err) {
    showMessage($('signup-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- success ----------
let successTimer = null;
function showSuccess(title, detail) {
  $('success-title').textContent = title;
  $('success-detail').textContent = detail;
  showPanel('success');
  clearTimeout(successTimer);
  successTimer = setTimeout(finish, 5000);
}
function finish() {
  clearTimeout(successTimer);
  resetSignIn();
  showPanel('signin');
  loadSports();
}
$('success-done').addEventListener('click', finish);

loadSports();
