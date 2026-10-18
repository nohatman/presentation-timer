'use strict';

// Relay hub: the Foxy Timer Online side of "Share over the internet".
//
// A Foxy Timer for Windows laptop connects OUT to this server (Socket.IO
// namespace /relay, authenticated by its relay secret) and publishes its rooms.
// Each published room gets public control/display tokens here. A phone that
// opens a public link connects to this server like any other panel; this hub
// passes everything it sends to the laptop and everything the laptop sends
// back to it. The laptop does all the timer work (see relayAgent.js), so this
// side holds no timer state and needs no knowledge of the events themselves.
//
//   laptop -> hub:  publish {rooms:[{localId, slug}]} (ack -> {links})
//                   panelEvent {panelKey, event, args}   (to one public panel)
//                   panelAck {panelKey, ackId, args}
//                   panelRefused {panelKey, message}
//                   background {requestId, ok, mime, data(base64)}
//   hub -> laptop:  panelOpen {panelKey, localId, role, auth}
//                   panelEmit {panelKey, event, args, ackId?}
//                   panelClose {panelKey}
//                   backgroundGet {requestId, localId}
//
// panelKey is the public panel's own socket id on this server.

const crypto = require('crypto');

function createRelayHub({ io, db, buildPublicLinks, log = () => {} }) {
  const laptops = new Map(); // relay session id -> relay socket
  const panels = new Map();  // panelKey -> { socket, sessionId, localId, role, auth, acks: Map }
  const pendingBackgrounds = new Map(); // requestId -> resolve


  function openOnLaptop(panel) {
    const laptop = laptops.get(panel.sessionId);
    if (!laptop) { panel.socket.emit('relayNotice', { offline: true }); return; }
    panel.socket.emit('relayNotice', { offline: false });
    laptop.emit('panelOpen', { panelKey: panel.socket.id, localId: panel.localId, role: panel.role, auth: panel.auth });
  }

  // ---- the laptops ----
  const ns = io.of('/relay');
  ns.on('connection', (laptop) => {
    const session = db.getRelaySessionBySecret(laptop.handshake.auth && laptop.handshake.auth.secret);
    if (!session) { laptop.emit('relayError', { message: 'This laptop is not registered for public links.' }); laptop.disconnect(true); return; }
    const sessionId = Number(session.id);
    const previous = laptops.get(sessionId);
    if (previous && previous.id !== laptop.id) previous.disconnect(true); // one connection per laptop
    laptops.set(sessionId, laptop);
    db.touchRelaySession(sessionId);
    log(`🌍 Relay laptop ${sessionId} connected`);

    laptop.on('publish', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const rooms = Array.isArray(payload && payload.rooms) ? payload.rooms.slice(0, 200)
        .filter((r) => r && (typeof r.localId === 'string' || typeof r.localId === 'number') && typeof r.slug === 'string')
        .map((r) => ({ localId: String(r.localId).slice(0, 40), slug: r.slug.slice(0, 100) })) : [];
      const rows = db.syncRelayRooms(sessionId, rooms);
      const links = {};
      for (const row of rows) links[row.local_room_id] = buildPublicLinks(row, laptop.handshake);
      reply({ ok: true, links });
      // Panels waiting for this laptop (it was offline) get connected now.
      for (const panel of panels.values()) if (panel.sessionId === sessionId) openOnLaptop(panel);
    });

    laptop.on('panelEvent', (msg) => {
      const panel = msg && panels.get(msg.panelKey);
      if (!panel || panel.sessionId !== sessionId || typeof msg.event !== 'string') return;
      panel.socket.emit(msg.event, ...(Array.isArray(msg.args) ? msg.args : []));
    });
    laptop.on('panelAck', (msg) => {
      const panel = msg && panels.get(msg.panelKey);
      if (!panel || panel.sessionId !== sessionId) return;
      const fn = panel.acks.get(msg.ackId);
      panel.acks.delete(msg.ackId);
      if (fn) fn(...(Array.isArray(msg.args) ? msg.args : []));
    });
    laptop.on('panelRefused', (msg) => {
      const panel = msg && panels.get(msg.panelKey);
      if (!panel || panel.sessionId !== sessionId) return;
      panel.socket.emit('authError', { message: msg.message || 'This link is not available right now.' });
      panel.socket.disconnect(true);
    });
    laptop.on('background', (msg) => {
      const done = msg && pendingBackgrounds.get(msg.requestId);
      if (done) { pendingBackgrounds.delete(msg.requestId); done(msg); }
    });

    laptop.on('disconnect', () => {
      if (laptops.get(sessionId) !== laptop) return;
      laptops.delete(sessionId);
      db.touchRelaySession(sessionId);
      log(`🌍 Relay laptop ${sessionId} disconnected`);
      // Public panels stay connected and wait; they're told the laptop is offline.
      for (const panel of panels.values()) if (panel.sessionId === sessionId) panel.socket.emit('relayNotice', { offline: true });
    });
  });

  // ---- the public panels ----
  // Called from the main connection handler when a socket's token is a public one.
  function handlePanelSocket(socket, found) {
    const { relayRoom, role } = found;
    const a = socket.handshake.auth || {};
    const auth = {
      deviceName: typeof a.deviceName === 'string' ? a.deviceName.slice(0, 40) : undefined,
      panelId: typeof a.panelId === 'string' ? a.panelId.slice(0, 64) : undefined,
      deviceId: typeof a.deviceId === 'string' ? a.deviceId.slice(0, 64) : undefined,
    };
    const panel = { socket, sessionId: Number(relayRoom.session_id), localId: relayRoom.local_room_id, role, auth, acks: new Map() };
    panels.set(socket.id, panel);
    openOnLaptop(panel);

    socket.onAny((event, ...args) => {
      const laptop = laptops.get(panel.sessionId);
      let ackId;
      if (args.length && typeof args[args.length - 1] === 'function') {
        const fn = args.pop();
        if (!laptop) { fn({ ok: false, reason: 'offline' }); return; }
        ackId = crypto.randomBytes(6).toString('hex');
        panel.acks.set(ackId, fn);
        if (panel.acks.size > 50) panel.acks.delete(panel.acks.keys().next().value);
      }
      if (laptop) laptop.emit('panelEmit', { panelKey: socket.id, event, args, ...(ackId ? { ackId } : {}) });
    });
    socket.on('disconnect', () => {
      panels.delete(socket.id);
      const laptop = laptops.get(panel.sessionId);
      if (laptop) laptop.emit('panelClose', { panelKey: socket.id });
    });
  }

  // The display's background image, fetched from the laptop. -> {ok, mime, data} | null
  function fetchBackground(relayRoom, timeoutMs = 8000) {
    const laptop = laptops.get(Number(relayRoom.session_id));
    if (!laptop) return Promise.resolve(null);
    const requestId = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingBackgrounds.delete(requestId); resolve(null); }, timeoutMs);
      pendingBackgrounds.set(requestId, (msg) => { clearTimeout(timer); resolve(msg && msg.ok ? msg : null); });
      laptop.emit('backgroundGet', { requestId, localId: relayRoom.local_room_id });
    });
  }

  function isLaptopOnline(sessionId) { return laptops.has(Number(sessionId)); }

  return { handlePanelSocket, fetchBackground, isLaptopOnline };
}

module.exports = { createRelayHub };
