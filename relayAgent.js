'use strict';

// Relay agent: the Foxy Timer for Windows side of "Share over the internet".
//
// The laptop connects OUT to Foxy Timer Online (relayHub.js) using whatever
// internet it has, publishes its rooms and gets public links for them. For
// every phone that opens a public link, the hub sends "panelOpen"; this agent
// then opens an ordinary Socket.IO connection to THIS laptop's own server with
// the room's real (local) link, and passes messages both ways. So the laptop's
// server treats a public phone exactly like one on the show network: controller
// seat, observers, device names, running order, all unchanged.
//
// Two things are rewritten on the way out: connection ids (the page compares
// them with its own to know "is this me / am I in control"), and the links in
// roomInfo (so Share links and the preview use the public addresses).

const { io: ioClient } = require('socket.io-client');

// Public phones and screens at once, so a flood of them can't bog the laptop down mid-show.
const MAX_PUBLIC_PANELS = 60;

function createRelayAgent({ db, port, onlineUrl, getRooms, fetchImpl = fetch, log = () => {} }) {
  let socket = null;
  let links = {};          // local room id -> { controlUrl, displayUrl } (public)
  let state = 'off';       // off | connecting | live | offline | error
  let lastError = null;
  const proxies = new Map();      // panelKey -> { local, localId }
  const localToPanel = new Map(); // local socket id -> panelKey

  const enabled = () => db.getMeta('relay_enabled') === '1';
  const secret = () => db.getMeta('relay_secret') || null;

  function status() {
    return { enabled: enabled(), state, error: lastError, links, onlineUrl };
  }

  async function register() {
    const res = await fetchImpl(`${onlineUrl}/api/relay/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.secret) throw new Error(data.error || `Foxy Timer Online said ${res.status}`);
    db.setMeta('relay_secret', data.secret);
  }

  async function start() {
    db.setMeta('relay_enabled', '1');
    state = 'connecting'; lastError = null;
    try {
      if (!secret()) await register();
    } catch (err) {
      state = 'offline'; lastError = `Couldn't reach Foxy Timer Online (${err.message}). It will keep trying.`;
      setTimeout(() => { if (enabled() && !socket) start(); }, 15000).unref();
      return status();
    }
    connect();
    return status();
  }

  function stop() {
    db.setMeta('relay_enabled', '0');
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    closeAllProxies();
    links = {}; state = 'off'; lastError = null;
    return status();
  }

  function closeAllProxies() {
    for (const p of proxies.values()) p.local.disconnect();
    proxies.clear(); localToPanel.clear();
  }

  function connect() {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); }
    socket = ioClient(`${onlineUrl}/relay`, {
      auth: { secret: secret() }, transports: ['websocket'], reconnection: true, reconnectionDelayMax: 10000,
    });
    socket.on('connect', () => { state = 'connecting'; lastError = null; publish(); log('🌍 Connected to Foxy Timer Online for public links'); });
    socket.on('connect_error', (err) => { state = 'offline'; lastError = `No connection to Foxy Timer Online (${err.message}). Local links still work; it keeps trying.`; });
    socket.on('disconnect', () => { if (state !== 'off') state = 'offline'; closeAllProxies(); });
    socket.on('relayError', async () => {
      // Online doesn't know this laptop (e.g. its records were reset): register again once.
      db.setMeta('relay_secret', '');
      try { await register(); connect(); } catch (err) { state = 'error'; lastError = err.message; }
    });
    socket.on('panelOpen', openProxy);
    socket.on('panelEmit', (msg) => {
      const p = msg && proxies.get(msg.panelKey);
      if (!p || typeof msg.event !== 'string') return;
      const args = Array.isArray(msg.args) ? msg.args : [];
      if (msg.ackId) p.local.emit(msg.event, ...args, (...res) => socket.emit('panelAck', { panelKey: msg.panelKey, ackId: msg.ackId, args: res }));
      else p.local.emit(msg.event, ...args);
    });
    socket.on('panelClose', (msg) => closeProxy(msg && msg.panelKey));
    socket.on('backgroundGet', (msg) => {
      const bg = msg && db.getRoomBackground(Number(msg.localId));
      socket.emit('background', bg
        ? { requestId: msg.requestId, ok: true, mime: bg.mime, data: Buffer.from(bg.data).toString('base64') }
        : { requestId: msg && msg.requestId, ok: false });
    });
  }

  // Tell Online which rooms this laptop has; it answers with their public links.
  function publish() {
    if (!socket || !socket.connected) return;
    const rooms = getRooms();
    socket.emit('publish', { rooms }, (res) => {
      if (res && res.ok) { links = res.links || {}; state = 'live'; lastError = null; }
      else { state = 'error'; lastError = (res && res.error) || 'Foxy Timer Online refused the rooms.'; }
    });
  }

  function openProxy(msg) {
    if (!msg || typeof msg.panelKey !== 'string') return;
    closeProxy(msg.panelKey);
    if (proxies.size >= MAX_PUBLIC_PANELS) {
      socket.emit('panelRefused', { panelKey: msg.panelKey, message: 'Too many people are using public links for this show right now.' });
      return;
    }
    const room = db.getRoomById(Number(msg.localId));
    if (!room || !links[String(room.id)]) {
      socket.emit('panelRefused', { panelKey: msg.panelKey, message: 'This room is no longer on the show laptop.' });
      return;
    }
    const token = msg.role === 'control' ? room.control_token : room.display_token;
    const auth = { token };
    for (const k of ['deviceName', 'panelId', 'deviceId']) if (msg.auth && typeof msg.auth[k] === 'string') auth[k] = msg.auth[k];
    const local = ioClient(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    const localId = String(room.id);
    proxies.set(msg.panelKey, { local, localId });
    local.on('connect', () => localToPanel.set(local.id, msg.panelKey));
    local.onAny((event, ...args) => {
      if (socket && socket.connected) socket.emit('panelEvent', { panelKey: msg.panelKey, event, args: rewrite(args, localId) });
    });
    local.on('disconnect', (reason) => {
      localToPanel.delete(local.id);
      // The laptop's server ended it (room deleted, links renewed...): tell the phone.
      if (reason === 'io server disconnect' && proxies.get(msg.panelKey) && proxies.get(msg.panelKey).local === local) {
        proxies.delete(msg.panelKey);
        if (socket && socket.connected) socket.emit('panelRefused', { panelKey: msg.panelKey, message: 'This link has ended. Ask for a new one.' });
      }
    });
  }

  function closeProxy(panelKey) {
    const p = panelKey && proxies.get(panelKey);
    if (!p) return;
    proxies.delete(panelKey);
    localToPanel.delete(p.local.id);
    p.local.disconnect();
  }

  // Connection ids -> the phones' own ids; roomInfo links -> the public links.
  function rewrite(value, localId) {
    if (typeof value === 'string') return localToPanel.get(value) || value;
    if (Array.isArray(value)) return value.map((v) => rewrite(v, localId));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, localId);
      if (out.roomInfo && links[localId]) out.roomInfo = { ...out.roomInfo, ...links[localId] };
      return out;
    }
    return value;
  }

  if (enabled()) start();

  return { start, stop, status, publish };
}

module.exports = { createRelayAgent };
