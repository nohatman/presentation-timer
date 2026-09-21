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
// Accepted times: M:SS / MM:SS / MMM:SS (seconds 00-59), or plain minutes
// ("20", "7.5"). A line with no comma keeps the historical default duration.
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
      const comma = line.lastIndexOf(',');
      let name = line;
      let durationMs = DEFAULT_MS;
      if (comma !== -1) {
        name = line.slice(0, comma).trim();
        const timeStr = line.slice(comma + 1).trim();
        if (timeStr) {
          const parsed = parseDuration(timeStr);
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
      if (name.length > MAX_NAME) {
        result.warnings.push({ line: lineNo, message: `name longer than ${MAX_NAME} characters was shortened` });
        name = name.slice(0, MAX_NAME);
      }
      result.items.push({ name, durationMs });
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
        return { ok: false, errors: [{ line: 0, text: '', message: 'No rundown lines found - refusing to replace the rundown with nothing.' }], warnings: [] };
      }
      return { ok: true, items: parsed.items, added: parsed.items.length, removed: (existing || []).length, warnings: parsed.warnings };
    }
    return { ok: true, items: (existing || []).concat(parsed.items), added: parsed.items.length, removed: 0, warnings: parsed.warnings };
  }

  return { DEFAULT_MS, MAX_NAME, formatDuration, parseDuration, format, parse, planImport };
}));
