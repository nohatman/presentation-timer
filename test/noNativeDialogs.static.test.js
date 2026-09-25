'use strict';

// Every confirmation/notice in the web UI is an in-page dialog matching the rest
// of the interface (dark card, Escape/click-outside = Cancel) - never the
// browser's own confirm()/alert()/prompt() boxes, which look like a system
// warning, block the page (a live countdown included) and can't be styled.
// Comments are stripped first, so explaining the rule in a comment is fine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1'); // line comments (not "https://")
}

for (const file of fs.readdirSync(publicDir).filter(f => f.endsWith('.html'))) {
  test(`${file}: no native confirm()/alert()/prompt()`, () => {
    const src = stripComments(fs.readFileSync(path.join(publicDir, file), 'utf8'));
    const hits = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(?<![\w.$])(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(line));
    assert.deepEqual(hits, [], 'use the page\'s in-page dialog (uiConfirm / uiNotice) instead');
  });
}
