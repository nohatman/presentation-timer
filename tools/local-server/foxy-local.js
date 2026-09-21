#!/usr/bin/env node
'use strict';

// FOXY LOCAL SHOW SERVER - launcher / supervisor.
//
// The single canonical implementation; Foxy-Local-Show-Server.bat just calls it.
//
//   node tools/local-server/foxy-local.js                 interactive menu
//   node tools/local-server/foxy-local.js status [--json]
//   ... start | stop [--force-unmanaged] | restart
//   ... open-control [--room slug] | open-display [--room slug] | links
//   options: --port N (default 3000, or FOXY_PORT)
//
// This runs the server as an explicit LOCAL show-day process (FOXY_MODE=local).
// It has nothing to do with the hosted/Railway deployment.

const path = require('path');
const readline = require('readline');

const sup = require('./lib/supervisor');
const { formatStatusLines } = require('./lib/format');
const rooms = require('./lib/rooms');
const { openUrl } = require('./lib/osproc');
const fs = require('fs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : undefined; };
const command = args.find((a) => !a.startsWith('--') && a !== opt('port') && a !== opt('room')) || 'menu';

const cfg = sup.makeConfig({ port: opt('port') });
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (c, s) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : s);
const STATE_COLOR = { RUNNING: 32, STOPPED: 33, STALE_BUILD: 31, UNHEALTHY: 31, UNMANAGED: 31, PORT_CONFLICT: 31 };

function printStatus(st) {
  const lines = formatStatusLines(st);
  lines[0] = lines[0].replace(/^(Status:\s+)(.*)$/, (_, a, b) => a + color(STATE_COLOR[st.state] || 0, b));
  console.log(lines.join('\n'));
}

// ---- last-used room (only a convenience) ----
const prefsFile = path.join(cfg.dataDir, 'launcher.json');
const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; } };
const savePrefs = (p) => { try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(prefsFile, JSON.stringify(p)); } catch { /* not important */ } };

// Line-queue prompter: unlike readline/promises' question(), lines that arrive before a
// prompt is shown (piped/scripted input) are kept, and end-of-input yields null.
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const queue = []; const waiters = []; let closed = false;
  rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return {
    ask(q) { process.stdout.write(q); return new Promise((res) => { if (queue.length) res(queue.shift()); else if (closed) res(null); else waiters.push(res); }); },
    close() { rl.close(); },
  };
}

async function chooseRoom(rl, slug) {
  const { rooms: list, error } = rooms.readRooms(cfg.rootDir);
  if (!list.length) return { room: null, error: error || 'There are no rooms yet. Create one from the dashboard first.' };
  const prefs = loadPrefs();
  const pick = rooms.pickRoom(list, { slug, lastSlug: prefs.lastRoom });
  if (pick.room) { savePrefs({ ...prefs, lastRoom: pick.room.slug }); return { room: pick.room }; }
  if (pick.notFound) return { room: null, error: `No room called "${pick.notFound}". Rooms: ${list.map((r) => r.slug).join(', ')}` };
  if (!rl) return { room: null, error: `Several rooms exist - pass --room <name>. Rooms: ${list.map((r) => r.slug).join(', ')}` };
  list.forEach((r, i) => console.log(`  [${i + 1}] ${r.slug}`));
  const n = Number(((await rl.ask('Which room? ')) || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > list.length) return { room: null, error: 'No room chosen.' };
  savePrefs({ ...prefs, lastRoom: list[n - 1].slug });
  return { room: list[n - 1] };
}

async function openPage(kind, rl, slug) {
  const st = await sup.gatherStatus(cfg);
  if (st.state === 'STOPPED' || st.state === 'PORT_CONFLICT') { console.log('The server is not running - start it first.'); return 1; }
  const { room, error } = await chooseRoom(rl, slug);
  if (!room) { console.log(error); return 1; }
  const links = rooms.linksFor(room, `http://localhost:${cfg.port}`);
  const url = kind === 'control' ? links.controlUrl : links.displayUrl;
  console.log(`${kind === 'control' ? 'Control' : 'Display'} page for "${room.slug}": ${url}`);
  if (!openUrl(url)) console.log('(browser not opened - FOXY_NO_BROWSER is set)');
  return 0;
}

async function showLinks(rl, slug) {
  const st = await sup.gatherStatus(cfg);
  if (!st.lanUrl) { console.log('No private LAN address found - is this PC on the show network?'); return 1; }
  const { rooms: list, error } = rooms.readRooms(cfg.rootDir);
  if (!list.length) { console.log(error || 'No rooms yet.'); return 1; }
  console.log(`Links for OTHER devices (base ${st.lanUrl}):`);
  for (const r of list.filter((x) => !slug || x.slug === slug)) {
    const l = rooms.linksFor(r, st.lanUrl);
    console.log(`  ${r.slug}\n    Control: ${l.controlUrl}\n    Display: ${l.displayUrl}`);
  }
  return 0;
}

async function doStart() { const r = await sup.start(cfg); console.log(r.message); return r.ok ? 0 : 1; }
async function doStop(force) { const r = await sup.stop(cfg, { forceUnmanaged: force }); console.log(r.message); return r.ok ? 0 : 1; }
async function doRestart() { const r = await sup.restart(cfg); console.log(r.message); return r.ok ? 0 : 1; }

async function menu() {
  const rl = makePrompter();
  for (;;) {
    console.log('\n' + color(1, '=== FOXY LOCAL SHOW SERVER ==='));
    let st = await sup.gatherStatus(cfg, { full: true });
    printStatus(st);
    const running = st.state !== 'STOPPED' && st.state !== 'PORT_CONFLICT';
    console.log('');
    console.log('  [1] Open Control page');
    console.log('  [2] Open Display page');
    console.log(`  [3] ${running ? 'Restart server' : 'Start server'}`);
    console.log('  [4] Stop server');
    console.log('  [5] Refresh status');
    console.log('  [6] Show links for other devices');
    if (st.state === 'PORT_CONFLICT' || st.state === 'UNMANAGED') console.log('  [K] Stop the OTHER server holding the port (asks first)');
    console.log('  [Q] Quit  (the server keeps running)');
    const answer = await rl.ask('> ');
    if (answer === null) break; // input ended
    const choice = answer.trim().toLowerCase();
    if (choice === 'q') break;
    if (choice === '1') await openPage('control', rl);
    else if (choice === '2') await openPage('display', rl);
    else if (choice === '3') console.log((running ? await sup.restart(cfg) : await sup.start(cfg)).message);
    else if (choice === '4') await doStop(false);
    else if (choice === '6') await showLinks(rl);
    else if (choice === 'k' && st.portOwner) {
      console.log(`About to stop PID ${st.portOwner.pid}: ${st.portOwner.commandLine || '(command line unavailable)'}`);
      if (((await rl.ask('Type YES to stop it: ')) || '').trim() === 'YES') await doStop(true); else console.log('Cancelled.');
    }
  }
  rl.close();
  return 0;
}

(async () => {
  let code = 0;
  switch (command) {
    case 'status': {
      const st = await sup.gatherStatus(cfg, { full: true });
      if (flag('json')) { const { _record, _processInfo, _health, _ownerInfo, ...pub } = st; console.log(JSON.stringify(pub, null, 2)); } else printStatus(st);
      code = st.state === 'RUNNING' ? 0 : st.state === 'STOPPED' ? 3 : 2; // 0 healthy, 3 stopped, 2 problem
      break;
    }
    case 'start': code = await doStart(); break;
    case 'stop': code = await doStop(flag('force-unmanaged')); break;
    case 'restart': code = await doRestart(); break;
    case 'open-control': code = await openPage('control', null, opt('room')); break;
    case 'open-display': code = await openPage('display', null, opt('room')); break;
    case 'links': code = await showLinks(null, opt('room')); break;
    case 'menu': code = await menu(); break;
    default:
      console.log('Usage: foxy-local.js [status|start|stop|restart|open-control|open-display|links] [--port N] [--room name] [--json]');
      code = 1;
  }
  process.exit(code);
})().catch((e) => { console.error('Launcher error:', e.message); process.exit(1); });
