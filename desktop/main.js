'use strict';

// Foxy Timer for Windows - the desktop app (Electron).
//
// Electron is only the windows. The timer engine is unchanged: the bundled
// Node runs server.js via the launcher (tools/local-server/foxy-local.js), so
// phones, screens, Companion and CDEther keep working exactly as before, and
// the engine can keep running after this app closes.
//
//   Main window    the dashboard (no login on the laptop itself); Control,
//                  Display and Help open as app windows, other sites in the
//                  normal browser.
//   Output window  Irisdown-style: the chosen room's Display, full screen with
//                  no frame or pointer, on the second monitor - automatically,
//                  and following monitors being plugged in or out. Chosen from
//                  the Output menu; remembered.
//   Also           keeps the laptop and screens awake; asks before closing;
//                  one copy only; offers a restart if the engine stops.
//
// Packaged layout (see scripts/build-local-download.js):
//   Foxy Timer.exe  (this app)   node\node.exe   app\ (engine)   resources\app\ (this folder)
// Development: `npm start` in desktop/ uses the system Node and the repo.

const { app, BrowserWindow, Menu, dialog, screen, shell, powerSaveBlocker } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.FOXY_PORT || 3000);
const LOCAL = `http://localhost:${PORT}`;
const HIDDEN = process.env.FOXY_APP_HIDDEN === '1'; // automated tests: create windows but never show them

// ---------------------------------------------------------------- engine
const BASE = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const NODE = app.isPackaged ? path.join(BASE, 'node', 'node.exe') : (process.env.FOXY_NODE || 'node');
const LAUNCHER = app.isPackaged
  ? path.join(BASE, 'app', 'tools', 'local-server', 'foxy-local.js')
  : path.join(BASE, 'tools', 'local-server', 'foxy-local.js');
const DATA_DIR = process.env.FOXY_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Foxy Timer', 'data');
const RESULT_FILE = path.join(DATA_DIR, 'last-launch-message.txt');
const ICON = [path.join(__dirname, 'foxy-timer.ico'), path.join(BASE, 'tools', 'windows', 'foxy-timer.ico')].find((p) => fs.existsSync(p));

function buildId() {
  try { return fs.readFileSync(path.join(BASE, 'build.txt'), 'utf8').trim(); } catch { return undefined; }
}

// Runs a launcher command and resolves with its exit code. stdio is ignored on
// purpose: the engine it starts is detached and could otherwise keep a pipe
// open; messages come back through FOXY_RESULT_FILE instead.
function runLauncher(command) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.unlinkSync(RESULT_FILE); } catch { /* none */ }
  const env = {
    ...process.env,
    DATABASE_PATH: path.join(DATA_DIR, 'foxy-timer.sqlite'),
    FOXY_LOCAL_DATA_DIR: path.join(DATA_DIR, 'local-server'),
    LEGACY_ROOMS_JSON_PATH: path.join(DATA_DIR, 'none.json'),
    FOXY_RESULT_FILE: RESULT_FILE,
    FOXY_NO_BROWSER: '1', // this app shows the dashboard itself
    FOXY_PORT: String(PORT),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const id = buildId();
  if (id) env.FOXY_BUILD_ID = id;
  return new Promise((resolve) => {
    const child = spawn(NODE, [LAUNCHER, command], { cwd: BASE, env, stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code == null ? 1 : code));
  });
}

const resultMessage = () => { try { return fs.readFileSync(RESULT_FILE, 'utf8').trim(); } catch { return ''; } };

// One request on its own connection (see supervisor.localRequest for why).
function getJson(urlPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.request(`${LOCAL}${urlPath}`, { agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Start the engine (or find it running). Handles "another copy is running".
async function ensureEngine() {
  let code = await runLauncher('open');
  if (code === 3) {
    const folder = (resultMessage().split('\n')[1] || 'another folder').trim();
    const { response } = await dialog.showMessageBox({
      type: 'question', title: 'Foxy Timer', buttons: ['Stop it and start this one', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'Another copy of Foxy Timer is already running.',
      detail: `It was started from:\n${folder}\n\nStopping it disconnects anything connected to it.`,
    });
    if (response !== 0) return false;
    await runLauncher('stop-other');
    code = await runLauncher('open');
  }
  if (code !== 0) {
    dialog.showErrorBox('Foxy Timer could not start', resultMessage() || 'Try again, or restart the laptop.');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let settings = { outputEnabled: true, outputRoomId: null, outputDisplayId: null };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }
function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* not fatal */ }
}

// ---------------------------------------------------------------- windows
let mainWindow = null;
let outputWindow = null;
let rooms = [];
let quitting = false;

const isOurs = (url) => {
  try { const u = new URL(url); return String(u.port || '80') === String(PORT) && u.protocol === 'http:'; } catch { return false; }
};
const toLocal = (url) => { const u = new URL(url); return `${LOCAL}${u.pathname}${u.search}${u.hash}`; };

function wireLinks(win) {
  // Our own pages (Control, Display, Help) open as app windows; anything else
  // (foxytimer.com, Companion docs...) goes to the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOurs(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, width: 1100, height: 800, show: !HIDDEN } };
  });
  win.webContents.on('did-create-window', (child) => wireLinks(child));
  win.webContents.on('will-navigate', (e, url) => { if (!isOurs(url)) { e.preventDefault(); shell.openExternal(url); } });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 500,
    title: 'Foxy Timer', icon: ICON, backgroundColor: '#0a0a0a', show: false,
    webPreferences: { contextIsolation: true },
  });
  wireLinks(mainWindow);
  mainWindow.loadURL(`${LOCAL}/dashboard`);
  mainWindow.once('ready-to-show', () => { if (!HIDDEN) mainWindow.show(); });
  mainWindow.on('close', async (e) => {
    if (quitting) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: 'Close Foxy Timer',
      buttons: ['Stop Foxy Timer and close', 'Close, keep the timer running', 'Cancel'], defaultId: 2, cancelId: 2,
      message: 'Close Foxy Timer?',
      detail: 'Stopping disconnects every display, control page and Stream Deck.\n\nIf you keep it running, phones, screens and Stream Decks carry on working; open Foxy Timer again to get this window back.',
    });
    if (response === 2) return;
    quitting = true;
    if (response === 0) await runLauncher('stop');
    app.quit();
  });
}

function outputTarget() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (!settings.outputEnabled) return null;
  const chosen = displays.find((d) => d.id === settings.outputDisplayId);
  if (chosen) return chosen;
  if (process.env.FOXY_APP_OUTPUT_ON_MAIN === '1') return primary; // automated tests on a one-screen PC
  return displays.find((d) => d.id !== primary.id) || null; // no second screen: no output window
}

function outputRoom() {
  return rooms.find((r) => r.id === settings.outputRoomId) || rooms[0] || null;
}

// Create, move or close the output window to match monitors + settings.
function syncOutput() {
  const target = outputTarget();
  const room = outputRoom();
  if (!target || !room) {
    if (outputWindow) { outputWindow.destroy(); outputWindow = null; }
    return;
  }
  const url = toLocal(room.displayUrl);
  if (!outputWindow) {
    outputWindow = new BrowserWindow({
      ...target.bounds, frame: false, show: false, skipTaskbar: true, autoHideMenuBar: true,
      backgroundColor: '#000000', icon: ICON, title: 'Foxy Timer output',
      webPreferences: { contextIsolation: true },
    });
    outputWindow.webContents.on('did-finish-load', () => outputWindow && outputWindow.webContents.insertCSS('* { cursor: none !important; }'));
    outputWindow.on('closed', () => { outputWindow = null; });
    outputWindow.loadURL(url);
    outputWindow.once('ready-to-show', () => {
      if (!outputWindow) return;
      outputWindow.setBounds(target.bounds);
      if (!HIDDEN) { outputWindow.showInactive(); outputWindow.setFullScreen(true); }
    });
  } else {
    if (outputWindow.webContents.getURL() !== url) outputWindow.loadURL(url);
    outputWindow.setFullScreen(false);
    outputWindow.setBounds(target.bounds);
    if (!HIDDEN) outputWindow.setFullScreen(true);
  }
}

async function refreshRooms() {
  const list = await getJson('/api/rooms');
  if (Array.isArray(list)) rooms = list;
  return rooms;
}

// ---------------------------------------------------------------- menu
function buildMenu() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const target = outputTarget();
  const room = outputRoom();
  const displayLabel = (d, i) => `${d.id === primary.id ? 'Main screen' : `Screen ${i + 1}`} (${d.size.width}×${d.size.height})`;
  const template = [
    {
      label: 'Foxy Timer',
      submenu: [
        { label: 'Dashboard', click: () => { mainWindow.loadURL(`${LOCAL}/dashboard`); mainWindow.show(); } },
        { type: 'separator' },
        { label: 'Close', role: 'close' },
      ],
    },
    {
      label: 'Output',
      submenu: [
        { label: 'Show the timer on a second screen', type: 'checkbox', checked: settings.outputEnabled,
          click: (item) => { settings.outputEnabled = item.checked; saveSettings(); syncOutput(); buildMenu(); } },
        { type: 'separator' },
        { label: 'Screen', enabled: settings.outputEnabled, submenu: displays.map((d, i) => ({
          label: displayLabel(d, i), type: 'radio', checked: !!target && target.id === d.id,
          click: () => { settings.outputDisplayId = d.id; saveSettings(); syncOutput(); buildMenu(); },
        })) },
        { label: 'Room', enabled: settings.outputEnabled && rooms.length > 0, submenu: rooms.length ? rooms.map((r) => ({
          label: r.slug, type: 'radio', checked: !!room && room.id === r.id,
          click: () => { settings.outputRoomId = r.id; saveSettings(); syncOutput(); buildMenu(); },
        })) : [{ label: 'No rooms yet', enabled: false }] },
        { type: 'separator' },
        { label: target ? `Showing "${room ? room.slug : '-'}" on ${displayLabel(target, displays.indexOf(target))}` : 'No second screen connected', enabled: false },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Foxy Timer help', click: () => { const w = new BrowserWindow({ width: 900, height: 800, icon: ICON, autoHideMenuBar: true, show: !HIDDEN }); wireLinks(w); w.loadURL(`${LOCAL}/help`); } },
        { label: 'foxytimer.com', click: () => shell.openExternal('https://foxytimer.com') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- lifecycle
// `Foxy Timer.exe --stop` (the installer, before an upgrade and on uninstall):
// stop the engine, no windows, no single-instance hand-off.
if (process.argv.includes('--stop')) {
  app.whenReady().then(async () => { await runLauncher('stop'); app.exit(0); });
} else if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running copy brings its window forward (second-instance)
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

  app.whenReady().then(async () => {
    if (!(await ensureEngine())) { app.quit(); return; }
    powerSaveBlocker.start('prevent-display-sleep'); // no screen blanking or sleep mid-show
    await refreshRooms();
    createMainWindow();
    buildMenu();
    syncOutput();

    screen.on('display-added', () => { syncOutput(); buildMenu(); });
    screen.on('display-removed', () => { syncOutput(); buildMenu(); });
    screen.on('display-metrics-changed', () => syncOutput());

    // Keep the Output > Room list current, and notice if the engine stops
    // (e.g. Stop Foxy Timer on the dashboard, or a crash).
    let engineDownSince = null;
    let asking = false;
    setInterval(async () => {
      const before = rooms.map((r) => r.id + r.slug).join();
      const health = await getJson('/api/health', 3000);
      if (health && health.ok) {
        engineDownSince = null;
        await refreshRooms();
        if (rooms.map((r) => r.id + r.slug).join() !== before) { buildMenu(); syncOutput(); }
        return;
      }
      engineDownSince = engineDownSince || Date.now();
      if (asking || quitting || Date.now() - engineDownSince < 6000) return;
      asking = true;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Foxy Timer', buttons: ['Start it again', 'Close Foxy Timer'], defaultId: 0, cancelId: 1,
        message: 'Foxy Timer\'s timer engine has stopped.',
        detail: 'Displays, control pages and Stream Decks are disconnected until it runs again.',
      });
      asking = false;
      if (response === 0 && (await ensureEngine())) { engineDownSince = null; mainWindow.loadURL(`${LOCAL}/dashboard`); if (outputWindow) outputWindow.reload(); }
      else if (response === 1) { quitting = true; app.quit(); }
    }, 5000);
  });

  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
