'use strict';

const $ = (id) => document.getElementById(id);
const token = location.pathname.split('/').pop();
const base = `/api/w/${encodeURIComponent(token)}`;

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
  const res = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 404 ? 'This workout link is not valid. Ask your coach for a new one.' : data.error || 'Something went wrong');
  return data;
}

function showMessage(text, kind = 'error') {
  const el = $('dash-msg');
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}

const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

let dash = null;
let current = null; // the workout shown in the form
let saveTimer = null;
let saving = Promise.resolve();

async function load() {
  dash = await api('');
  const { student } = dash;
  $('student-name').textContent = `${student.firstName} ${student.lastName}`;
  $('student-sport').textContent = student.sportName || '';
  document.title = `${student.firstName}'s Workouts`;
  $('complete-banner').hidden = !dash.complete;
  renderHistory();
  if (!dash.workouts.length) {
    $('empty').hidden = false;
    return;
  }
  const open = dash.workouts.find((w) => w.current) || dash.workouts[0];
  await openWorkout(open.id);
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();
  $('history-card').hidden = dash.workouts.length < 1;
  for (const w of dash.workouts) {
    list.append(h('li', {},
      h('button', {
        type: 'button',
        className: `history-item${current && current.id === w.id ? ' active' : ''}`,
        onclick: () => openWorkout(w.id).then(() => $('workout').scrollIntoView({ behavior: 'smooth' })).catch((e) => showMessage(e.message)),
      },
      h('span', {},
        h('span', { className: 'small muted' }, `${fmtDate(w.date)} · Day ${w.dayNumber}`),
        h('span', { className: 'history-label' }, w.label)),
      h('span', { className: `pill ${w.completed ? 'ok' : ''}` }, w.completed ? 'Done' : 'Open')),
    ));
  }
}

async function openWorkout(id) {
  await flush();
  current = (await api(`/workouts/${id}`)).workout;
  renderWorkout();
  renderHistory();
}

function renderWorkout() {
  const w = current;
  $('workout').hidden = false;
  $('w-eyebrow').textContent = `Day ${w.dayNumber} of ${w.totalDays} · ${fmtDate(w.date)}`;
  $('w-label').textContent = w.label;
  $('w-note').textContent = [w.weekTitle, w.weekNote].filter(Boolean).join(' — ');
  $('w-restarted').hidden = !w.restarted;
  $('w-notes').value = w.results.notes || '';
  const box = $('w-items');
  box.replaceChildren();

  w.items.forEach((item, i) => {
    const r = w.results.items[i];
    if (w.kind === 'weights') {
      const repsHint = (item.reps.match(/^\d+(-\d+)?/) || [''])[0];
      // Timed holds ("30-45 sec", "30 sec each") are entered as a time, not reps.
      const timedGoal = /\b(sec|secs|seconds|min|mins|minutes)\b/i.test(item.reps) ? item.reps : '';
      box.append(h('div', { className: `exercise${item.priority ? ' priority' : ''}` },
        h('div', { className: 'exercise-head' },
          h('div', {},
            h('div', { className: 'exercise-name' }, item.code ? h('span', { className: 'code' }, item.code) : null, item.name,
              item.priority ? h('span', { className: 'star', title: 'Priority lift' }, ' ★') : null),
            h('div', { className: 'small muted' }, item.prescription)),
        ),
        item.lastTime ? h('div', { className: 'small last-time' }, `Last time: ${item.lastTime}`) : null,
        h('div', { className: 'sets' },
          r.sets.map((set, s) => {
            const id = `w${i}-s${s}`;
            // One block per set, top to bottom: "Set 1", then Weight and Reps side by side.
            return h('fieldset', { className: 'set' },
              h('legend', {}, r.sets.length > 1 ? `Set ${s + 1} of ${r.sets.length}` : 'Your result'),
              h('div', { className: 'set-fields' },
                h('div', { className: 'set-field' },
                  h('label', { htmlFor: `${id}-weight` }, 'Weight (lb)'),
                  h('input', {
                    id: `${id}-weight`, inputMode: 'decimal', value: set.weight, maxLength: 12,
                    oninput: (e) => { set.weight = e.target.value; queueSave(); },
                  })),
                h('div', { className: 'set-field' },
                  h('label', { htmlFor: `${id}-reps` }, timedGoal ? `Time · goal ${timedGoal}`
                    : repsHint ? `Reps · goal ${repsHint}` : 'Reps / amount'),
                  h('input', {
                    id: `${id}-reps`, inputMode: repsHint && !timedGoal ? 'numeric' : 'text', value: set.reps, maxLength: 12,
                    oninput: (e) => { set.reps = e.target.value; queueSave(); },
                  }))));
          })),
      ));
    } else {
      box.append(h('div', { className: 'exercise' },
        h('label', { className: 'drill' },
          h('input', { type: 'checkbox', checked: r.done, onchange: (e) => { r.done = e.target.checked; queueSave(); } }),
          h('span', {}, h('span', { className: 'exercise-name' }, item.name), h('span', { className: 'small muted' }, ` ${item.plan || ''}`))),
        h('div', { className: 'set-field drill-result' },
          h('label', { htmlFor: `d${i}-result` }, 'Best time / distance (optional)'),
          h('input', {
            id: `d${i}-result`, value: r.result, maxLength: 40,
            oninput: (e) => { r.result = e.target.value; queueSave(); },
          })),
      ));
    }
  });
  renderFinish();
  $('w-status').textContent = '';
}

function renderFinish() {
  const btn = $('w-finish');
  btn.textContent = current.completed ? 'Completed ✓ (tap to undo)' : 'Finish Workout';
  btn.classList.toggle('primary', !current.completed);
}

$('w-notes').addEventListener('input', (e) => { if (current) { current.results.notes = e.target.value; queueSave(); } });

function queueSave() {
  $('w-status').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 700);
}

function save(extra = {}) {
  const w = current;
  saving = saving.then(async () => {
    try {
      await api(`/workouts/${w.id}`, { method: 'PUT', body: { results: w.results, ...extra } });
      if (w === current) $('w-status').textContent = 'Saved';
    } catch (err) {
      $('w-status').textContent = '';
      showMessage(`Not saved: ${err.message}`);
    }
  });
  return saving;
}

async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await save(); }
  await saving;
}

$('w-finish').addEventListener('click', async () => {
  clearTimeout(saveTimer); saveTimer = null;
  const completed = !current.completed;
  await save({ completed });
  current.completed = completed;
  const entry = dash.workouts.find((x) => x.id === current.id);
  if (entry) entry.completed = completed;
  renderFinish();
  renderHistory();
  if (completed) $('w-status').textContent = 'Workout saved. Great job!';
});

// Save anything pending if the student closes the page.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

load().catch((err) => {
  $('student-name').textContent = 'Workout page not found';
  showMessage(err.message);
});
