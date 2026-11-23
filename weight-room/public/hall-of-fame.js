'use strict';

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null && v !== false) el[k] = v;
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const fmtLb = (n) => (n == null ? '—' : n.toLocaleString());
const fmtPct = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const cls = (n) => `num ${n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : ''}`;

const COLUMNS = ['Student Name', 'Bench Max', 'Squat Max', 'Deadlift Max', '% Bench Increase', '% Squat Increase', '% Deadlift Increase'];

function renderTable(table, rows) {
  table.replaceChildren(
    h('thead', {}, h('tr', {}, COLUMNS.map((c, i) => h('th', { scope: 'col', className: i ? 'num' : '' }, c)))),
    h('tbody', {}, rows.length
      ? rows.map((r, i) => h('tr', {},
        h('th', { scope: 'row' }, h('span', { className: 'rank' }, `${i + 1}.`), r.name,
          r.sportName ? h('div', { className: 'small muted' }, r.sportName) : null),
        h('td', { className: 'num' }, fmtLb(r.benchMax)),
        h('td', { className: 'num' }, fmtLb(r.squatMax)),
        h('td', { className: 'num' }, fmtLb(r.deadliftMax)),
        h('td', { className: cls(r.benchPercent) }, fmtPct(r.benchPercent)),
        h('td', { className: cls(r.squatPercent) }, fmtPct(r.squatPercent)),
        h('td', { className: cls(r.deadliftPercent) }, fmtPct(r.deadliftPercent))))
      : h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, 'No strength tests logged yet.'))),
  );
}

async function load() {
  const res = await fetch('/api/admin/hall-of-fame');
  if (res.status === 401) { location.replace('/login?next=/hall-of-fame'); return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not load the Hall of Fame');
  renderTable($('hof-boys'), data.boys);
  renderTable($('hof-girls'), data.girls);
  if (data.notSet) {
    const n = data.notSet;
    $('hof-notset').textContent = `${n} tested student${n === 1 ? ' is' : 's are'} in a sport that isn't set to Boys or Girls, so `
      + `${n === 1 ? "they aren't" : "they aren't"} listed. Set it on the admin page under Sports, Seasons & Coaches.`;
    $('hof-notset').hidden = false;
  }
}

load().catch((err) => {
  $('hof-msg').textContent = err.message;
  $('hof-msg').className = 'message error';
  $('hof-msg').hidden = false;
});
