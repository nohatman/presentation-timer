#!/usr/bin/env node
'use strict';

// Builds the free Foxy Timer for Windows download: a zip a crew member unzips on a
// Windows laptop and double-clicks. Nothing to install - Node is bundled.
//
//   node scripts/build-local-download.js      (run on Windows x64)
//
// Output: dist/FoxyTimer-Windows-<commit>.zip containing
//   FoxyTimer/
//     Start Foxy Timer.bat   start + open the dashboard + launcher menu
//     README.txt
//     node/node.exe          the same Node that ran this build, so the
//                            better-sqlite3 prebuilt binary matches it
//     app/                   server, pages, launcher, production node_modules
//     data/                  created on first run; kept when the app is
//                            replaced by a newer download
//
// Needs network access at build time (npm installs the production
// dependencies). The finished download never needs the internet.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FINGERPRINT_FILES } = require('../buildInfo');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'FoxyTimer');
const APP = path.join(OUT, 'app');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Build this on Windows x64: it bundles the running node.exe and Windows native modules.');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
const git = (args) => execFileSync('git', args, { cwd: ROOT, windowsHide: true }).toString().trim();

let commit = 'dev';
try {
  commit = git(['rev-parse', '--short', 'HEAD']);
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    console.warn('⚠️  Uncommitted changes: the download will contain them but be labelled ' + commit);
  }
} catch { /* not a git checkout */ }

console.log(`Building Foxy Timer for Windows (${commit}, Node ${process.version})`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// App files: every root module the server loads, the pages, and the launcher.
for (const f of FINGERPRINT_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
fs.cpSync(path.join(ROOT, 'public'), path.join(APP, 'public'), { recursive: true });
fs.cpSync(path.join(ROOT, 'tools', 'local-server'), path.join(APP, 'tools', 'local-server'), { recursive: true });

// package.json without dev dependencies / scripts, then a production install.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appPkg = { name: pkg.name, version: pkg.version, private: true, main: 'server.js', dependencies: pkg.dependencies };
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(appPkg, null, 2));
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
run(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], { cwd: APP });
// better-sqlite3 ships its C sources for building from scratch; the prebuilt
// binary in build/ is all that's needed at run time.
for (const dir of ['deps', 'src']) fs.rmSync(path.join(APP, 'node_modules', 'better-sqlite3', dir), { recursive: true, force: true });

// Bundled Node: the exact binary running this build (matches the native module ABI).
fs.mkdirSync(path.join(OUT, 'node'));
fs.copyFileSync(process.execPath, path.join(OUT, 'node', 'node.exe'));

fs.writeFileSync(path.join(OUT, 'Start Foxy Timer.bat'), [
  '@echo off',
  'rem Foxy Timer for Windows. Double-click to start the timer server on this',
  'rem laptop and open the dashboard. Uses the bundled Node; nothing to install.',
  'title Foxy Timer for Windows',
  'cd /d "%~dp0"',
  'set "DATABASE_PATH=%~dp0data\\foxy-timer.sqlite"',
  'set "FOXY_LOCAL_DATA_DIR=%~dp0data\\local-server"',
  'set "LEGACY_ROOMS_JSON_PATH=%~dp0data\\none.json"',
  `set "FOXY_BUILD_ID=${commit}"`,
  'set "ARGS=%*"',
  'if "%ARGS%"=="" set "ARGS=go"',
  '"%~dp0node\\node.exe" "%~dp0app\\tools\\local-server\\foxy-local.js" %ARGS%',
  'if errorlevel 1 pause',
  ''
].join('\r\n'));

fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'FOXY TIMER FOR WINDOWS',
  '======================',
  '',
  'Runs Foxy Timer on this Windows laptop for a show. No account, no',
  'internet connection and nothing to install.',
  '',
  'START',
  '  1. Double-click "Start Foxy Timer".',
  '  2. If Windows asks whether to allow Node.js on networks, choose Allow',
  '     for private networks. Without that, phones and displays can\'t connect.',
  '  3. The dashboard opens in your browser, with a "Main stage" room ready.',
  '     Add more rooms there, one per stage or breakout.',
  '',
  'CONNECT SCREENS AND PHONES',
  '  Put them on the same network as this laptop. In the dashboard, open a',
  '  room\'s links: send the Display link to the screen and the Control link',
  '  to the operator, or tap QR and scan it.',
  '',
  'STREAM DECK (COMPANION)',
  '  In the dashboard, press "Companion / Stream Deck". Copy the Server URL,',
  '  key and room names it shows into the Foxy Presentation Timer connection',
  '  in Companion. The Stream Deck PC must be on the same network.',
  '',
  'STOP',
  '  Closing the window leaves the timer running (on purpose, so a show',
  '  never stops by accident). Double-click "Start Foxy Timer" again and',
  '  choose [4] Stop server.',
  '',
  'UPDATING',
  '  Your rooms are kept in the "data" folder. To update, replace the other',
  '  files with a newer download and keep "data".',
  '',
  'Foxy Timer is made by Business Shows Limited - https://foxytimer.com',
  `Build ${commit}`,
  ''
].join('\r\n'));

// Zip with Windows' own bsdtar (-a picks zip from the extension). Called by full
// path: a GNU tar earlier on PATH (e.g. Git Bash's) silently writes a tar file
// with a .zip name instead.
const zipName = `FoxyTimer-Windows-${commit}.zip`;
fs.rmSync(path.join(DIST, zipName), { force: true });
const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
run(bsdtar, ['-a', '-c', '-f', zipName, 'FoxyTimer'], { cwd: DIST });
const mb = (fs.statSync(path.join(DIST, zipName)).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ dist/${zipName} (${mb} MB)`);
