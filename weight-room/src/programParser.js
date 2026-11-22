'use strict';

/**
 * Turns an uploaded workout document (PDF or Word .docx) into a list of days.
 *
 * Both formats are first reduced to "rows": arrays of non-empty cell strings in reading
 * order (a table row, or a paragraph as a one-cell row). The parser then walks the rows:
 *
 *   Week 1: Foundation (Mini Cycle 1)        -> week heading
 *   Week 1 of this phase: ...                -> note for the week
 *   Monday: Weights | Sets x Reps | Set 1..  -> new weights day
 *   A1 | High pull* | 5 x 3 (heavy)          -> exercise (code optional, * = priority)
 *   Tuesday: Run (Speed + Power) | Plan | .. -> new running day
 *   Form work | 8 min                        -> drill
 *
 * Days are numbered in the order they appear (Day 1 = first day in the document).
 */

const WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day\\s*\\d+)';
const DAY_RE = new RegExp(`^${WEEKDAY}\\s*[:\\-–]\\s*(.+)$`, 'i');
const WEEK_RE = /^week\s+(\d+)\s*[:\-–]\s*(.*)$/i;
const CODE_RE = /^[A-Z]\d{1,2}$/;
const PRESCRIPTION_RE = /^(\d{1,2})\s*[x×]\s*(.+)$/i;
const MAX_SETS = 10;

function clean(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ---------- PDF ----------
async function rowsFromPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, verbosity: 0,
  }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [, , , height] = page.view;
    const { items } = await page.getTextContent();
    const lines = [];
    for (const it of items) {
      const str = clean(it.str);
      if (!str) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      // Skip the running header and footer bands.
      if (y < 40 || y > height - 60) continue;
      let line = lines.find((l) => Math.abs(l.y - y) <= 3);
      if (!line) { line = { y, items: [] }; lines.push(line); }
      line.items.push({ x, str, w: it.width });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      // Join pieces of text that touch (one cell split into several runs), split on gaps.
      const cells = [];
      let prevEnd = -Infinity;
      for (const it of line.items) {
        if (cells.length && it.x - prevEnd < 4) cells[cells.length - 1] += ` ${it.str}`;
        else cells.push(it.str);
        prevEnd = it.x + (it.w || 0);
      }
      rows.push(cells.map(clean).filter(Boolean));
    }
  }
  await doc.destroy();
  return rows;
}

// ---------- Word (.docx) ----------
function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e]))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const textOf = (html) => clean(decodeEntities(html.replace(/<[^>]+>/g, ' ')));

async function rowsFromDocx(buffer) {
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const rows = [];
  // Walk top-level blocks: tables become rows of cells, everything else one-cell rows.
  const blockRe = /<table[\s\S]*?<\/table>|<(p|h[1-6]|li)[^>]*>[\s\S]*?<\/\1>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[0];
    if (block.startsWith('<table')) {
      for (const tr of block.match(/<tr[\s\S]*?<\/tr>/g) || []) {
        const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(textOf).filter(Boolean);
        if (cells.length) rows.push(cells);
      }
    } else {
      const t = textOf(block);
      if (t) rows.push([t]);
    }
  }
  return rows;
}

function detectType(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'docx'; // zip container
  return null;
}

async function extractRows(buffer) {
  const type = detectType(buffer);
  if (type === 'pdf') return rowsFromPdf(buffer);
  if (type === 'docx') return rowsFromDocx(buffer);
  const err = new Error('Please upload a PDF or a Word .docx file. (Older .doc files: open in Word and save as .docx.)');
  err.userFacing = true;
  throw err;
}

// ---------- rows -> days ----------
function parseRows(rows) {
  const days = [];
  const warnings = [];
  let week = null; // { number, title, note }
  let day = null;

  const endDay = () => { day = null; };

  for (const cells of rows) {
    if (!cells.length) continue;
    const first = cells[0];

    const wk = first.match(WEEK_RE);
    if (wk) {
      const number = Number(wk[1]);
      // "Name: ____ Dates: ____" blanks share the heading line; drop them.
      const title = clean([wk[2], ...cells.slice(1)].join(' ').replace(/\b(name|dates?)\s*:\s*_*/gi, '').replace(/_+/g, ''));
      if (!week || week.number !== number) { week = { number, title, note: '' }; endDay(); }
      continue;
    }

    const dh = first.match(DAY_RE);
    if (dh) {
      const header = cells.join(' | ');
      const kind = /sets?\s*[x×]\s*reps?/i.test(header) ? 'weights'
        : /\bplan\b/i.test(header) ? 'run' : 'other';
      const weekday = dh[1].replace(/\s+/g, ' ');
      day = {
        dayNumber: days.length + 1,
        week: week?.number ?? null,
        weekTitle: week?.title ?? '',
        weekNote: week?.note ?? '',
        weekday: weekday[0].toUpperCase() + weekday.slice(1).toLowerCase(),
        title: clean(dh[2]),
        kind,
        items: [],
      };
      days.push(day);
      continue;
    }

    if (day) {
      if (day.kind === 'weights') {
        let rest = cells;
        let code = '';
        if (CODE_RE.test(rest[0])) { code = rest[0]; rest = rest.slice(1); }
        // "5 x 3 (heavy)" -> 5 sets of "3 (heavy)"; "3 passes" (no sets) -> 1 entry of "3 passes".
        const prescription = rest.length >= 2 && /^\d/.test(rest[1]) ? rest[1] : null;
        if (prescription) {
          const pm = prescription.match(PRESCRIPTION_RE);
          const name = rest[0];
          day.items.push({
            code,
            name: name.replace(/\*+\s*$/, '').trim(),
            priority: /\*\s*$/.test(name),
            prescription,
            sets: pm ? Math.max(1, Math.min(MAX_SETS, Number(pm[1]))) : 1,
            reps: pm ? clean(pm[2]) : prescription,
          });
          continue;
        }
      } else if (cells.length === 2 && !/^week notes/i.test(first)) {
        day.items.push({ name: cells[0], plan: cells[1] });
        continue;
      }
      endDay();
    }

    // A one-line note right under a week heading ("Week 1 of this phase: ...").
    if (week && !week.note && !day && cells.length === 1 && /^week\s+\d+\s+of\b/i.test(first)) {
      week.note = first;
    }
  }

  for (const d of days) {
    if (!d.items.length) warnings.push(`Day ${d.dayNumber} (${label(d)}) has no exercises.`);
  }
  return { days, warnings };
}

function label(d) {
  const day = d.weekday ? `${d.weekday}: ${d.title}` : d.title;
  return [d.week != null ? `Week ${d.week}` : null, day].filter(Boolean).join(' · ');
}

async function parseProgramFile(buffer) {
  const rows = await extractRows(buffer);
  const result = parseRows(rows);
  if (!result.days.length) {
    const err = new Error("Couldn't find any workouts in that file. Each workout needs a heading like \"Monday: Weights\" above its table.");
    err.userFacing = true;
    throw err;
  }
  return result;
}

module.exports = { parseProgramFile, parseRows, extractRows, label };
