'use strict';

// The control page's "how it counts" menu is shown/hidden with the `hidden`
// attribute, but its CSS gives it display:grid - which beats the browser's own
// [hidden] rule, so without an explicit override the menu stays on screen after
// it's closed (reported from a real phone). Also: hex colour boxes select their
// whole value on entry, for quick pasting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'control.html'), 'utf8');

test('count style menu: a [hidden] rule overrides its display:grid', () => {
  assert.match(html, /\.count-style-menu\s*\{[^}]*display:\s*grid/);
  assert.match(html, /\.count-style-menu\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

test('hex colour boxes select all on focus', () => {
  assert.match(html, /box\.addEventListener\('focus',[^\n]*box\.select\(\)/);
});
