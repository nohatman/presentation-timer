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
//   Output windows Irisdown-style: a room's Display, full screen with no frame
//                  or pointer. Each screen is set separately in the Output menu
//                  (a room, or nothing), so two extra monitors can show two
//                  rooms - or the same room twice. First run: the first extra
//                  screen shows the first room. Follows monitors being plugged
//                  in or out; remembered. Identify screens puts a big number
//                  on each one.
//   Also           keeps the laptop and screens awake; asks before closing;
//                  one copy only; offers a restart if the engine stops.
//
// Packaged layout (see scripts/build-local-download.js):
//   Foxy Timer.exe  (this app)   node\node.exe   app\ (engine)   resources\app\ (this folder)
// Development: `npm start` in desktop/ uses the system Node and the repo.

const { app, BrowserWindow, Menu, dialog, screen, shell, powerSaveBlocker, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
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

// ---------------------------------------------------------------- graphics
// Laptops with two graphics chips (e.g. Intel + NVIDIA) can show this app's
// windows fuzzy when screens use different scaling (100% laptop + 300%
// monitor): Windows copies each frame between the chips and stretches it.
// Running on the built-in chip fixes it. That is Windows' own per-app setting
// (Settings > System > Display > Graphics), which View > Sharper text sets.
const GPU_PREFS_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
function readGpuPrefs() {
  try {
    const out = execFileSync('reg', ['query', GPU_PREFS_KEY, '/v', process.execPath], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_SZ\s+(.*)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
let powerSavingGpu = /(^|;)GpuPreference=1;/.test(readGpuPrefs());
let hasTwoGpus = false; // set once Electron has listed the graphics chips

// Keeps any other Windows graphics options already set for this app.
function setPowerSavingGpu(on) {
  const others = readGpuPrefs().split(';').filter((p) => p && !p.startsWith('GpuPreference='));
  const data = [...(on ? ['GpuPreference=1'] : []), ...others].map((p) => `${p};`).join('');
  try {
    if (data) execFileSync('reg', ['add', GPU_PREFS_KEY, '/v', process.execPath, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true, stdio: 'ignore' });
    else execFileSync('reg', ['delete', GPU_PREFS_KEY, '/v', process.execPath, '/f'], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function toggleSharperText(item) {
  if (!setPowerSavingGpu(item.checked)) {
    item.checked = !item.checked;
    dialog.showErrorBox('Foxy Timer', 'Windows did not accept the change. You can set it yourself in Settings > System > Display > Graphics.');
    return;
  }
  powerSavingGpu = item.checked;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: 'Foxy Timer', buttons: ['Reopen windows now', 'Later'], defaultId: 0, cancelId: 1,
    message: 'Reopen Foxy Timer\'s windows to apply this?',
    detail: 'The timer keeps running and phones stay connected. Screens showing the timer go blank for a couple of seconds while the windows reopen.\n\nChoose Later to apply it the next time Foxy Timer opens.',
  });
  if (response !== 0) return;
  quitting = true;
  app.relaunch();
  app.exit(0); // the engine is a separate process and keeps running
}

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
// outputs: { [display id]: room id, or null for nothing } - a screen not in it
// yet gets the default (see screenRoomId). outputEnabled switches them all off.
let settings = { outputEnabled: true, outputs: {} };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }
// Settings from the one-output version: carry its screen + room across.
if (settings.outputDisplayId != null && !Object.keys(settings.outputs).length) {
  settings.outputs[settings.outputDisplayId] = settings.outputRoomId || null;
}
delete settings.outputDisplayId;
delete settings.outputRoomId;
function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* not fatal */ }
}

// ---------------------------------------------------------------- windows
let mainWindow = null;
const outputWindows = new Map(); // display id -> BrowserWindow
let rooms = [];
let quitting = false;

const isOurs = (url) => {
  try { const u = new URL(url); return String(u.port || '80') === String(PORT) && u.protocol === 'http:'; } catch { return false; }
};
const toLocal = (url) => { const u = new URL(url); return `${LOCAL}${u.pathname}${u.search}${u.hash}`; };

// Mixed-scaling screens (e.g. a 100% laptop with a 300% portable monitor): a
// window that lands on a screen with a different scale can stay fuzzy - a
// stretched copy - until something makes it redraw. A one-pixel resize there
// and back forces that redraw at the new scale. Maximised and full-screen
// windows can't be resized without un-maximising, so they just repaint.
function keepSharp(win) {
  let lastScale = null;
  let timer = null;
  const scaleNow = () => screen.getDisplayMatching(win.getBounds()).scaleFactor;
  const redraw = () => {
    if (win.isDestroyed()) return;
    if (!win.isMaximized() && !win.isFullScreen()) {
      const [w, h] = win.getSize();
      win.setSize(w + 1, h);
      setTimeout(() => { if (!win.isDestroyed()) { win.setSize(w, h); win.webContents.invalidate(); } }, 60);
    } else {
      win.webContents.invalidate();
    }
  };
  const check = () => {
    if (win.isDestroyed()) return;
    const scale = scaleNow();
    if (lastScale !== null && scale !== lastScale) redraw();
    lastScale = scale;
  };
  win.once('ready-to-show', () => { lastScale = scaleNow(); if (lastScale !== screen.getPrimaryDisplay().scaleFactor) setTimeout(redraw, 300); });
  win.on('move', () => { clearTimeout(timer); timer = setTimeout(check, 250); });
  win.on('moved', check);
  win.on('show', check);
}
app.on('browser-window-created', (e, win) => keepSharp(win));

function wireLinks(win) {
  // Our own pages (Control, Display, Help) open as app windows; anything else
  // (foxytimer.com, Companion docs...) goes to the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOurs(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, width: 1100, height: 800, show: !HIDDEN } };
  });
  win.webContents.on('did-create-window', (child) => wireLinks(child));
  win.webContents.on('will-navigate', (e, url) => { if (!isOurs(url)) { e.preventDefault(); shell.openExternal(url); } });
}

// The dashboard window opens maximised the first time, then where it was left
// (if that screen is still connected).
function savedMainBounds() {
  const saved = settings.mainWindow && settings.mainWindow.bounds;
  if (!saved) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 && saved.y >= a.y - 20 && saved.y < a.y + a.height - 100;
  });
  return onScreen ? saved : null;
}

function rememberMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  settings.mainWindow = { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
  saveSettings();
}

function createMainWindow() {
  const bounds = savedMainBounds();
  mainWindow = new BrowserWindow({
    ...(bounds || { width: 1280, height: 860 }), minWidth: 420, minHeight: 500,
    title: 'Foxy Timer', icon: ICON, backgroundColor: '#0a0a0a', show: false,
    // preload.js: lets the dashboard show and change which screen each room is on
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  wireLinks(mainWindow);
  mainWindow.loadURL(`${LOCAL}/dashboard`);
  mainWindow.once('ready-to-show', () => {
    if (!bounds || settings.mainWindow.maximized) mainWindow.maximize();
    if (!HIDDEN) mainWindow.show();
  });
  let rememberTimer = null;
  const rememberSoon = () => { clearTimeout(rememberTimer); rememberTimer = setTimeout(rememberMainWindow, 500); };
  mainWindow.on('resize', rememberSoon);
  mainWindow.on('move', rememberSoon);
  mainWindow.on('maximize', rememberSoon);
  mainWindow.on('unmaximize', rememberSoon);
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

// Screens in desk order: the laptop's own screen is 1, then the others left to
// right (top to bottom when stacked), matching Identify screens.
function orderedDisplays() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id)
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y));
  return [primary, ...others].map((d, i) => ({ display: d, number: i + 1, primary: i === 0 }));
}

function screenLabel({ display, number, primary }) {
  const size = `${display.size.width}×${display.size.height}`;
  return primary ? `Screen 1 · this laptop (${size})` : `Screen ${number} (${size})`;
}

const roomById = (id) => rooms.find((r) => r.id === id) || null;

// The room a screen shows, or null. Screens never set before: the first extra
// screen shows the first room, every other screen shows nothing (an extra
// monitor may be for slides). Automated tests can put it on the main screen.
function screenRoomId(entry) {
  const key = String(entry.display.id);
  if (Object.prototype.hasOwnProperty.call(settings.outputs, key)) {
    const id = settings.outputs[key];
    return id && roomById(id) && !roomById(id).licenceLocked ? id : null;
  }
  if (Object.values(settings.outputs).some((v) => v)) return null;
  const all = orderedDisplays();
  const defaultScreen = all.find((e) => !e.primary) || (process.env.FOXY_APP_OUTPUT_ON_MAIN === '1' ? all[0] : null);
  return defaultScreen && defaultScreen.display.id === entry.display.id && rooms[0] ? rooms[0].id : null;
}

function setScreenRoom(entry, roomId) {
  // Keep what the other screens show now (e.g. the first-run default) before
  // this choice changes which defaults apply.
  for (const other of orderedDisplays()) {
    const key = String(other.display.id);
    if (!Object.prototype.hasOwnProperty.call(settings.outputs, key)) settings.outputs[key] = screenRoomId(other);
  }
  settings.outputs[String(entry.display.id)] = roomId;
  saveSettings();
  syncOutput();
  buildMenu();
}

// Pointer hidden until the mouse moves, then shown for 2 s. On the laptop's
// own screen only - where the output covers the dashboard - Esc takes the
// timer off it, and a note saying so shows on opening and with the pointer.
// External screens ignore Esc: a stray key must never blank what the
// audience sees; they're changed from the dashboard or the Output menu.
const OUTPUT_CSS = `
  html.foxy-still, html.foxy-still * { cursor: none !important; }
  #foxyEscHint { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647;
    background: rgba(20,20,20,0.92); color: #fff; border: 1px solid #555; border-radius: 10px; padding: 10px 18px;
    font: 600 16px 'Segoe UI', sans-serif; pointer-events: none; transition: opacity 0.3s; }
  html.foxy-still #foxyEscHint { opacity: 0; }`;
const outputScript = (onLaptopScreen) => `(() => {
  if (window.__foxyOutput) return; window.__foxyOutput = true;
  if (${onLaptopScreen}) {
    const hint = document.createElement('div');
    hint.id = 'foxyEscHint';
    hint.textContent = 'Press Esc to stop showing the timer on this screen';
    document.body.appendChild(hint);
  }
  const root = document.documentElement;
  let t = null;
  const wake = (ms) => { root.classList.remove('foxy-still'); clearTimeout(t); t = setTimeout(() => root.classList.add('foxy-still'), ms); };
  root.classList.add('foxy-still');
  addEventListener('mousemove', () => wake(2000));
  if (${onLaptopScreen}) wake(5000);
})();`;

function openOutputWindow(display, url, onLaptopScreen, onEscape) {
  const win = new BrowserWindow({
    ...display.bounds, frame: false, show: false, skipTaskbar: true, autoHideMenuBar: true,
    backgroundColor: '#000000', icon: ICON, title: 'Foxy Timer output',
    webPreferences: { contextIsolation: true },
  });
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.insertCSS(OUTPUT_CSS);
    win.webContents.executeJavaScript(outputScript(onLaptopScreen)).catch(() => {});
  });
  // Laptop screen only: Esc = "show nothing here" (the same as unticking it).
  if (onLaptopScreen) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); onEscape(); }
    });
  }
  win.loadURL(url);
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.setBounds(display.bounds);
    if (HIDDEN) return;
    // On the laptop's own screen take the keyboard, so Esc works straight away.
    if (onLaptopScreen) win.show(); else win.showInactive();
    win.setFullScreen(true);
  });
  return win;
}

// Create, move, change or close output windows to match monitors + settings.
function syncOutput() {
  const wanted = new Map(); // display id -> { display, url, primary }
  if (settings.outputEnabled) {
    for (const entry of orderedDisplays()) {
      const room = roomById(screenRoomId(entry));
      if (room) wanted.set(entry.display.id, { display: entry.display, url: toLocal(room.displayUrl), primary: entry.primary });
    }
  }
  for (const [id, win] of outputWindows) {
    if (!wanted.has(id) || win.isDestroyed()) { if (!win.isDestroyed()) win.destroy(); outputWindows.delete(id); }
  }
  for (const [id, { display, url, primary }] of wanted) {
    const win = outputWindows.get(id);
    if (!win) {
      const escape = () => {
        const entry = orderedDisplays().find((e) => e.display.id === id);
        if (entry) setScreenRoom(entry, null);
        if (primary && mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
      };
      const created = openOutputWindow(display, url, primary, escape);
      created.on('closed', () => { if (outputWindows.get(id) === created) outputWindows.delete(id); });
      outputWindows.set(id, created);
      continue;
    }
    if (win.webContents.getURL() !== url) win.loadURL(url);
    const b = win.getBounds();
    const t = display.bounds;
    if (b.x !== t.x || b.y !== t.y || b.width !== t.width || b.height !== t.height) {
      win.setFullScreen(false);
      win.setBounds(t);
      if (!HIDDEN) win.setFullScreen(true);
    }
  }
}

// A big number on every screen for a few seconds, so "Screen 3" in the menu
// can be matched to a monitor on the desk.
const IDENTIFY_MS = 4000;
let identifyWindows = [];
function identifyScreens() {
  for (const w of identifyWindows) if (!w.isDestroyed()) w.destroy();
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  identifyWindows = orderedDisplays().map((entry) => {
    const { x, y, width, height } = entry.display.workArea;
    const w = Math.min(520, width);
    const h = Math.min(360, height);
    const win = new BrowserWindow({
      x: Math.round(x + (width - w) / 2), y: Math.round(y + (height - h) / 2), width: w, height: h,
      frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false,
      backgroundColor: '#141414', show: false, webPreferences: { contextIsolation: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    const room = settings.outputEnabled ? roomById(screenRoomId(entry)) : null;
    const showing = room ? `Showing: ${room.slug}` : 'Showing: nothing';
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#141414;color:#fff;font-family:Segoe UI,sans-serif;border:6px solid #ff6a1a;box-sizing:border-box;cursor:none">
      <div style="font-size:200px;font-weight:800;line-height:1;color:#ff6a1a">${entry.number}</div>
      <div style="font-size:26px;margin-top:12px">${esc(screenLabel(entry))}</div>
      <div style="font-size:20px;margin-top:8px;color:#aaa">${esc(showing)}</div></body>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.once('ready-to-show', () => { if (!HIDDEN && !win.isDestroyed()) win.showInactive(); });
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, IDENTIFY_MS);
    return win;
  });
}

async function refreshRooms() {
  const list = await getJson('/api/rooms');
  if (Array.isArray(list)) rooms = list;
  return rooms;
}

// ---------------------------------------------------------------- dashboard
// What the dashboard needs to show "🖥 Screen 2" on each room and change it
// (desktop/preload.js). Sent again whenever the menu is rebuilt - that is,
// after every routing, room or monitor change.
function outputsSnapshot() {
  return {
    enabled: settings.outputEnabled,
    screens: orderedDisplays().map((entry) => ({
      id: entry.display.id,
      number: entry.number,
      label: screenLabel(entry),
      primary: entry.primary,
      roomId: settings.outputEnabled ? screenRoomId(entry) : null,
    })),
  };
}

ipcMain.handle('outputs:get', () => outputsSnapshot());
ipcMain.handle('outputs:set', (event, displayId, roomId) => {
  const entry = orderedDisplays().find((e) => e.display.id === Number(displayId));
  const room = roomId == null ? null : roomById(String(roomId));
  if (entry && (roomId == null || (room && !room.licenceLocked))) {
    if (!settings.outputEnabled) settings.outputEnabled = true; // choosing a screen switches outputs on
    setScreenRoom(entry, room ? room.id : null);
  }
  return outputsSnapshot();
});
ipcMain.handle('outputs:identify', () => { identifyScreens(); });

// ---------------------------------------------------------------- menu
function buildMenu() {
  const entries = orderedDisplays();
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
        { label: 'Show timers on other screens', type: 'checkbox', checked: settings.outputEnabled,
          click: (item) => { settings.outputEnabled = item.checked; saveSettings(); syncOutput(); buildMenu(); } },
        { label: 'Identify screens', click: identifyScreens },
        { type: 'separator' },
        ...entries.map((entry) => {
          const current = screenRoomId(entry);
          const room = roomById(current);
          return {
            label: `${screenLabel(entry)}  →  ${room ? room.slug : 'nothing'}`,
            enabled: settings.outputEnabled,
            submenu: [
              { label: 'Nothing', type: 'radio', checked: !current, click: () => setScreenRoom(entry, null) },
              { type: 'separator' },
              ...(rooms.length
                ? rooms.map((r) => ({
                  label: r.licenceLocked ? `${r.slug} (not in the free version)` : r.slug,
                  type: 'radio', checked: current === r.id, enabled: !r.licenceLocked,
                  click: () => setScreenRoom(entry, r.id),
                }))
                : [{ label: 'No rooms yet', enabled: false }]),
            ],
          };
        }),
        ...(entries.length === 1 ? [{ type: 'separator' }, { label: 'No other screen connected', enabled: false }] : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        ...(hasTwoGpus || powerSavingGpu ? [
          { type: 'separator' },
          { label: 'Sharper text on mixed screens (use built-in graphics)', type: 'checkbox', checked: powerSavingGpu, click: toggleSharperText },
        ] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Foxy Timer help', click: () => { const w = new BrowserWindow({ width: 900, height: 800, icon: ICON, show: !HIDDEN }); wireLinks(w); w.loadURL(`${LOCAL}/help`); } },
        { label: 'foxytimer.com', click: () => shell.openExternal('https://foxytimer.com') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('outputs:changed', outputsSnapshot());
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
    // Two real graphics chips (not counting Windows' basic display driver)?
    app.getGPUInfo('basic').then((info) => {
      hasTwoGpus = (info.gpuDevice || []).filter((d) => d.vendorId !== 0x1414).length > 1;
      if (hasTwoGpus) buildMenu();
    }).catch(() => {});
    await refreshRooms();
    createMainWindow();
    buildMenu();
    syncOutput();

    screen.on('display-added', () => { syncOutput(); buildMenu(); });
    screen.on('display-removed', () => { syncOutput(); buildMenu(); });
    screen.on('display-metrics-changed', () => { syncOutput(); buildMenu(); for (const w of BrowserWindow.getAllWindows()) w.emit('moved'); });

    // Keep the Output > Room list current, and notice if the engine stops
    // (e.g. Stop Foxy Timer on the dashboard, or a crash).
    let engineDownSince = null;
    let asking = false;
    setInterval(async () => {
      const before = rooms.map((r) => r.id + r.slug + r.licenceLocked).join();
      const health = await getJson('/api/health', 3000);
      if (health && health.ok) {
        engineDownSince = null;
        await refreshRooms();
        if (rooms.map((r) => r.id + r.slug + r.licenceLocked).join() !== before) { buildMenu(); syncOutput(); }
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
      if (response === 0 && (await ensureEngine())) { engineDownSince = null; mainWindow.loadURL(`${LOCAL}/dashboard`); for (const w of outputWindows.values()) w.reload(); }
      else if (response === 1) { quitting = true; app.quit(); }
    }, 5000);
  });

  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
