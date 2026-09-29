#!/usr/bin/env node
'use strict';

// Builds Foxy Timer for Windows: an installer and a portable zip that turn a
// Windows laptop into the timer server for a show. Nothing else to install -
// Node is bundled - and no window or text menu for the operator.
//
//   node scripts/build-local-download.js      (run on Windows x64)
//
// Output (dist/):
//   FoxyTimerSetup-<commit>.exe    the installer (Inno Setup, if installed):
//                                  Program Files, Start menu / desktop icon,
//                                  Windows Firewall rule, uninstaller
//   FoxyTimer-Windows-<commit>.zip the same files, portable
// Both contain FoxyTimer/:
//   Foxy Timer.exe   the desktop app (desktop/, Electron): dashboard window + second-screen output
//   README.txt, build.txt
//   node/node.exe    the same Node that ran this build, so the better-sqlite3
//                    prebuilt binary matches it
//   app/             server, pages, launcher, production node_modules
//   support/         text-menu .bat, for troubleshooting only
// Rooms are kept per Windows user in %LOCALAPPDATA%\Foxy Timer\data.
//
// Needs network access at build time (npm installs the production
// dependencies). What it builds never needs the internet.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FINGERPRINT_FILES } = require('../buildInfo');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'FoxyTimer');
const APP = path.join(OUT, 'app');
const ICON = path.join(ROOT, 'tools', 'windows', 'foxy-timer.ico');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Build this on Windows x64: it bundles the running node.exe and Windows native modules.');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
const git = (args) => execFileSync('git', args, { cwd: ROOT, windowsHide: true }).toString().trim();
const winDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';

let commit = 'dev';
try {
  commit = git(['rev-parse', '--short', 'HEAD']);
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    console.warn('⚠️  Uncommitted changes: the build will contain them but be labelled ' + commit);
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

// "Foxy Timer.exe": the desktop app (desktop/, Electron) - its own window for
// the dashboard, the display full screen on the second monitor. Packaged with
// @electron/packager into OUT alongside node/ and app/. Needs `npm install` in
// desktop/ once (Electron is a dev dependency there, not of the server).
const DESKTOP = path.join(ROOT, 'desktop');
if (!fs.existsSync(path.join(DESKTOP, 'node_modules', '@electron', 'packager'))) {
  console.error('desktop/ has no node_modules - run: cd desktop && npm install');
  process.exit(1);
}
const stage = path.join(DIST, 'desktop-stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(DESKTOP, 'main.js'), path.join(stage, 'main.js'));
fs.copyFileSync(ICON, path.join(stage, 'foxy-timer.ico'));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'foxy-timer', productName: 'Foxy Timer', version: pkg.version, main: 'main.js', private: true,
  description: desktopPkg.description,
}, null, 2));
const electronVersion = require(path.join(DESKTOP, 'node_modules', 'electron', 'package.json')).version;
const packagerScript = `
  const { packager } = await import('@electron/packager'); // ESM-only; resolved from desktop/
  await packager({
    dir: ${JSON.stringify(stage)}, out: ${JSON.stringify(path.join(DIST, 'desktop-out'))}, overwrite: true,
    name: 'Foxy Timer', executableName: 'Foxy Timer', platform: 'win32', arch: 'x64',
    electronVersion: ${JSON.stringify(electronVersion)}, icon: ${JSON.stringify(ICON)}, asar: true, prune: false,
    appCopyright: 'Business Shows Limited',
    win32metadata: { CompanyName: 'Business Shows Limited', ProductName: 'Foxy Timer', FileDescription: 'Foxy Timer for Windows' },
  }).then((dirs) => console.log(dirs[0]));`;
const packaged = execFileSync(process.execPath, ['--input-type=module', '-e', packagerScript], { cwd: DESKTOP, windowsHide: true }).toString().trim().split(/\r?\n/).pop();
fs.cpSync(packaged, OUT, { recursive: true });
// Chromium's own UI languages: English only (the pages are English anyway) - saves ~40 MB.
for (const f of fs.readdirSync(path.join(OUT, 'locales'))) {
  if (!/^en-(GB|US)\.pak$/.test(f)) fs.rmSync(path.join(OUT, 'locales', f));
}
fs.rmSync(path.join(DIST, 'desktop-out'), { recursive: true, force: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, 'build.txt'), commit + '\r\n');

// Troubleshooting only: the text menu, same data folder as the icon.
fs.mkdirSync(path.join(OUT, 'support'));
fs.writeFileSync(path.join(OUT, 'support', 'Foxy Timer text menu.bat'), [
  '@echo off',
  'rem Troubleshooting only: the text menu (status, start/stop, links).',
  'rem Everyday use is the Foxy Timer icon.',
  'title Foxy Timer - text menu',
  'set "BASE=%~dp0.."',
  'set "DATA=%LOCALAPPDATA%\\Foxy Timer\\data"',
  'if not exist "%DATA%" mkdir "%DATA%"',
  'set "DATABASE_PATH=%DATA%\\foxy-timer.sqlite"',
  'set "FOXY_LOCAL_DATA_DIR=%DATA%\\local-server"',
  'set "LEGACY_ROOMS_JSON_PATH=%DATA%\\none.json"',
  'set /p FOXY_BUILD_ID=<"%BASE%\\build.txt"',
  '"%BASE%\\node\\node.exe" "%BASE%\\app\\tools\\local-server\\foxy-local.js" %*',
  'if errorlevel 1 pause',
  ''
].join('\r\n'));

fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'FOXY TIMER FOR WINDOWS',
  '======================',
  '',
  'Runs Foxy Timer on this Windows laptop for a show. No account and no',
  'internet connection needed.',
  '',
  'START',
  '  Click the Foxy Timer icon. The Foxy Timer window opens with the dashboard',
  '  and a "Main stage" room ready; add more rooms there, one per stage or',
  '  breakout. If a second screen is connected, the timer appears on it full',
  '  screen automatically - choose the room and screen from the Output menu.',
  '',
  'CONNECT SCREENS AND PHONES',
  '  Put them on the same network as this laptop. On a room, press',
  '  "Share links & QR" and scan the QR code, or send the links.',
  '  If the dashboard says Windows Firewall is blocking other devices, press',
  '  "Allow through firewall" and answer Yes. (The installer does this for you.)',
  '',
  'STREAM DECK (COMPANION)',
  '  On the dashboard, press "Companion / Stream Deck" and copy the three',
  '  settings it shows into the Foxy Presentation Timer connection in',
  '  Companion.',
  '',
  'STOP',
  '  Close the Foxy Timer window and choose "Stop Foxy Timer and close", or',
  '  "Close, keep the timer running" to leave phones and screens working.',
  '',
  'HELP',
  '  The dashboard\'s Help button: connecting devices, Companion, show-day tips.',
  '',
  'Your rooms are kept in %LOCALAPPDATA%\\Foxy Timer\\data and survive updates.',
  '',
  'Foxy Timer is made by Business Shows Limited - https://foxytimer.com',
  `Build ${commit}`,
  ''
].join('\r\n'));

const mb = (name) => (fs.statSync(path.join(DIST, name)).size / 1024 / 1024).toFixed(1);

// Portable zip, with Windows' own bsdtar (-a picks zip from the extension).
// Called by full path: a GNU tar earlier on PATH (e.g. Git Bash's) silently
// writes a tar file with a .zip name instead.
const zipName = `FoxyTimer-Windows-${commit}.zip`;
fs.rmSync(path.join(DIST, zipName), { force: true });
run(path.join(winDir, 'System32', 'tar.exe'), ['-a', '-c', '-f', zipName, 'FoxyTimer'], { cwd: DIST });
console.log(`\n✅ dist/${zipName} (${mb(zipName)} MB)`);

// Installer, with Inno Setup (free; https://jrsoftware.org). Skipped with a
// note if it isn't on the build machine.
const iscc = [
  process.env.ISCC,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean).find((p) => fs.existsSync(p));

if (!iscc) {
  console.log('ℹ️  Inno Setup not found - installer skipped (winget install JRSoftware.InnoSetup).');
} else {
  const setupName = `FoxyTimerSetup-${commit}`;
  const iss = path.join(DIST, 'FoxyTimer.iss');
  const nodeInApp = '{app}\\node\\node.exe';
  const deleteRule = `advfirewall firewall delete rule name=""Foxy Timer"" program=""${nodeInApp}""`;
  const addRule = `advfirewall firewall add rule name=""Foxy Timer"" dir=in action=allow program=""${nodeInApp}"" enable=yes profile=any`;
  fs.writeFileSync(iss, [
    '; Generated by scripts/build-local-download.js - edit that, not this.',
    '[Setup]',
    'AppId={{8C3F6A52-4F0B-4B8E-9E0D-6A1F2C7D9B11}',
    'AppName=Foxy Timer',
    `AppVersion=${pkg.version}+${commit}`,
    `AppVerName=Foxy Timer for Windows (${commit})`,
    'AppPublisher=Business Shows Limited',
    'AppPublisherURL=https://foxytimer.com',
    'DefaultDirName={autopf}\\Foxy Timer',
    'DefaultGroupName=Foxy Timer',
    'DisableProgramGroupPage=yes',
    'PrivilegesRequired=admin',
    'ArchitecturesAllowed=x64compatible',
    'ArchitecturesInstallIn64BitMode=x64compatible',
    `OutputDir=${DIST}`,
    `OutputBaseFilename=${setupName}`,
    `SetupIconFile=${ICON}`,
    'UninstallDisplayIcon={app}\\Foxy Timer.exe',
    'UninstallDisplayName=Foxy Timer for Windows',
    'Compression=lzma2/max',
    'SolidCompression=yes',
    'WizardStyle=modern',
    'CloseApplications=yes', // the app window is closed (with the user's OK) before files are replaced
    '',
    '[Tasks]',
    'Name: "desktopicon"; Description: "Put a Foxy Timer icon on the desktop"; GroupDescription: "Shortcuts:"',
    '',
    '[InstallDelete]',
    '; old program files only - rooms live in %LOCALAPPDATA%\\Foxy Timer and are kept',
    'Type: filesandordirs; Name: "{app}\\app"',
    '',
    '[Files]',
    `Source: "${OUT}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion`,
    '',
    '[Icons]',
    'Name: "{autoprograms}\\Foxy Timer"; Filename: "{app}\\Foxy Timer.exe"',
    'Name: "{autodesktop}\\Foxy Timer"; Filename: "{app}\\Foxy Timer.exe"; Tasks: desktopicon',
    '',
    '[Run]',
    '; Let phones, screens and Stream Decks reach the laptop on any network type',
    '; (venue Wi-Fi is often a "Public" network in Windows).',
    `Filename: "{sys}\\netsh.exe"; Parameters: "${deleteRule}"; Flags: runhidden`,
    `Filename: "{sys}\\netsh.exe"; Parameters: "${addRule}"; Flags: runhidden; StatusMsg: "Letting phones and screens connect (Windows Firewall)..."`,
    'Filename: "{app}\\Foxy Timer.exe"; Description: "Start Foxy Timer now"; Flags: postinstall nowait skipifsilent runasoriginaluser',
    '',
    '[UninstallRun]',
    'Filename: "{app}\\Foxy Timer.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopFoxyTimer"',
    `Filename: "{sys}\\netsh.exe"; Parameters: "${deleteRule}"; Flags: runhidden; RunOnceId: "RemoveFirewallRule"`,
    '',
    '[Code]',
    '// Updating: stop a running Foxy Timer first so its files can be replaced.',
    'function PrepareToInstall(var NeedsRestart: Boolean): String;',
    'var',
    '  ResultCode: Integer;',
    'begin',
    "  if FileExists(ExpandConstant('{app}\\Foxy Timer.exe')) then",
    "    Exec(ExpandConstant('{app}\\Foxy Timer.exe'), '--stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);",
    "  Result := '';",
    'end;',
    ''
  ].join('\r\n'));
  run(iscc, ['/Q', iss]);
  console.log(`✅ dist/${setupName}.exe (${mb(setupName + '.exe')} MB)`);
}
