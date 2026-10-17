'use strict';

// Rundown <-> plain text. Shared by the control page (browser, as a global
// `RundownText`) and the tests (Node, via require).
//
// Data model: a rundown item is { name, durationMs }. Text format, one item per
// line - the same format the Paste box has always accepted:
//
//     Jane Smith, 20:00
//     Panel Discussion, 45:00
//
// The time is the LAST comma-separated part, so names may contain commas.
// Accepted times: M:SS / MM:SS / MMM:SS (seconds 00-59), H:MM:SS, or plain
// minutes ("20", "7.5"). A line with no comma keeps the historical default.
//
// Spreadsheets: cells copied from Excel / Google Sheets arrive tab-separated,
// and CSV / Excel files arrive as rows of cells. For those, the time is the
// right-most cell that reads as a time and the name is the cells before it.
// A first row that is plainly a heading ("Name, Duration") is skipped.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundownText = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_MS = 30 * 60 * 1000;
  const MAX_NAME = 100; // server.js setRundown truncates to this
  const MAX_MINUTES = 9999;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatDuration(ms) {
    const total = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  }

  // -> ms, or null if not a valid time
  function parseDuration(text) {
    const t = String(text).trim();
    let m = /^(\d{1,4}):(\d{2})$/.exec(t);
    if (m) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      return sec > 59 ? null : (min * 60 + sec) * 1000;
    }
    m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(t); // H:MM:SS
    if (m) {
      const h = Number(m[1]), min = Number(m[2]), sec = Number(m[3]);
      return min > 59 || sec > 59 ? null : ((h * 60 + min) * 60 + sec) * 1000;
    }
    m = /^\d+(\.\d+)?$/.exec(t);
    if (m) {
      const mins = parseFloat(t);
      if (!(mins > 0) || mins > MAX_MINUTES) return null;
      return Math.round(mins * 60) * 1000;
    }
    return null;
  }

  // Whole rundown -> text. Newlines inside a name (never produced by the UI, but
  // possible via other clients) are flattened so one item is always one line.
  function format(items) {
    return (items || []).map((it) => {
      const name = String(it.name || '').replace(/[\r\n]+/g, ' ').trim();
      return `${name}, ${formatDuration(it.durationMs)}`;
    }).join('\n');
  }

  // A heading row, e.g. "Name, Duration" or "Speaker | Time": only words a
  // heading would use, so a real first item is never dropped by mistake.
  const HEAD_NAME = /^(name|names|speaker|speakers|session|sessions|item|items|title|talk|who|presenter)$/i;
  const HEAD_TIME = /^(time|times|duration|durations|length|mins?|minutes|slot|running time)$/i;
  function isHeading(nameCell, timeCell) {
    return HEAD_NAME.test(String(nameCell).trim()) || HEAD_TIME.test(String(timeCell).trim());
  }

  function addItem(result, lineNo, name, durationMs) {
    if (name.length > MAX_NAME) {
      result.warnings.push({ line: lineNo, message: `name longer than ${MAX_NAME} characters was shortened` });
      name = name.slice(0, MAX_NAME);
    }
    result.items.push({ name, durationMs });
  }

  // One spreadsheet row (array of cells) into result.
  function addRow(result, cells, lineNo) {
    const c = cells.map((x) => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
    if (!c.length) { result.blankLines += 1; return; }
    let at = -1, durationMs = DEFAULT_MS;
    for (let i = c.length - 1; i >= 1; i--) {
      const ms = parseDuration(c[i]);
      if (ms !== null) { at = i; durationMs = ms; break; }
    }
    if (at === -1 && c.length > 1) {
      if (!result.items.length && !result.errors.length && isHeading(c[0], c[c.length - 1])) {
        result.warnings.push({ line: lineNo, message: 'skipped the heading row' });
        return;
      }
      result.errors.push({ line: lineNo, text: c.join(' | '), message: `no time found in "${c.join(' | ')}" - put the time (MM:SS or minutes) in the column after the name` });
      return;
    }
    addItem(result, lineNo, (at === -1 ? c : c.slice(0, at)).join(' - '), durationMs);
  }

  // Rows of cells (a CSV or Excel file) -> same result shape as parse().
  function parseRows(rows) {
    const result = { items: [], errors: [], warnings: [], blankLines: 0 };
    (rows || []).forEach((row, i) => addRow(result, Array.isArray(row) ? row : [row], i + 1));
    return result;
  }

  // CSV text -> rows of cells. Handles quoted fields ("Smith, John"), doubled
  // quotes, CRLF and a BOM. Semicolons are the separator when a file uses them
  // instead of commas (Excel does in many European locales).
  function csvRows(text) {
    const t = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const firstLine = t.split(/\r\n|\r|\n/, 1)[0] || '';
    const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (quoted) {
        if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Rundown -> CSV with a heading row, for spreadsheets.
  function toCsv(items) {
    const q = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return ['Name,Duration'].concat((items || []).map((it) =>
      `${q(String(it.name || '').replace(/[\r\n]+/g, ' ').trim())},${formatDuration(it.durationMs)}`)).join('\r\n') + '\r\n';
  }

  // Text -> { items, errors, warnings, blankLines }. Never throws. `errors` are
  // per-line ({ line, text, message }, line is 1-based in the pasted text); a
  // caller must treat any error as "do not apply".
  function parse(text) {
    const result = { items: [], errors: [], warnings: [], blankLines: 0 };
    const lines = String(text == null ? '' : text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line) { result.blankLines += 1; return; }
      const lineNo = i + 1;
      if (line.includes('\t')) { addRow(result, line.split('\t'), lineNo); return; } // cells copied from a spreadsheet
      const comma = line.lastIndexOf(',');
      let name = line;
      let durationMs = DEFAULT_MS;
      if (comma !== -1) {
        name = line.slice(0, comma).trim();
        const timeStr = line.slice(comma + 1).trim();
        if (timeStr) {
          const parsed = parseDuration(timeStr);
          if (parsed === null && !result.items.length && !result.errors.length && isHeading(name, timeStr)) {
            result.warnings.push({ line: lineNo, message: 'skipped the heading row' });
            return;
          }
          if (parsed === null) {
            result.errors.push({
              line: lineNo,
              text: line,
              message: `"${timeStr}" is not a valid time - use MM:SS or minutes (if the name contains a comma, put the time last, e.g. "Smith, John, 20:00")`,
            });
            return;
          }
          durationMs = parsed;
        }
      }
      addItem(result, lineNo, name, durationMs);
    });
    return result;
  }

  // Decide what an import does, without touching anything. mode: 'append' | 'replace'.
  // -> { ok:false, errors:[...] } or { ok:true, items, added, removed }.
  // Replace is deliberately strict: any bad line, or no lines at all, means
  // nothing changes (an empty paste must never wipe the rundown).
  function planImport(existing, text, mode) {
    const parsed = parse(text);
    if (parsed.errors.length) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
    if (mode === 'replace') {
      if (!parsed.items.length) {
        return { ok: false, errors: [{ line: 0, text: '', message: 'No running order lines found - refusing to replace the running order with nothing.' }], warnings: [] };
      }
      return { ok: true, items: parsed.items, added: parsed.items.length, removed: (existing || []).length, warnings: parsed.warnings };
    }
    return { ok: true, items: (existing || []).concat(parsed.items), added: parsed.items.length, removed: 0, warnings: parsed.warnings };
  }

  // Where "Add" should insert a new item: immediately after the currently
  // active/selected rundown line (the same index the control page uses to
  // highlight a row and to drive Take/Prev/Next), or at the end when nothing is
  // active/selected - the previous, still-correct behaviour for that case.
  // Any index that isn't currently a real row (none selected, stale, out of
  // range) falls back to the end rather than guessing.
  function insertionIndex(activeIndex, length) {
    return Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < length ? activeIndex + 1 : length;
  }

  return { DEFAULT_MS, MAX_NAME, formatDuration, parseDuration, format, parse, parseRows, csvRows, toCsv, planImport, insertionIndex };
}));
