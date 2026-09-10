'use strict';

// cdether-bridge — terminal entry point (P1).
//
//   Presentation Timer room
//     -> read-only Socket.IO (DISPLAY token)
//     -> BridgeEngine (lib/engine.js)
//     -> UDP broadcast, bound to the chosen NIC
//     -> CDEther -> XLR -> Hive display
//
// This file is deliberately thin: parse config, build the pieces, wire the
// engine's events to stdout, handle signals. All orchestration lives in
// lib/engine.js so a later UI can drive the same core.

const { loadConfig, adapterHint } = require('./lib/config');
const { listInterfaces } = require('./lib/net');
const { deriveFrame } = require('./lib/state');
const { UdpSender } = require('./lib/cdether');
const { PtClient } = require('./lib/ptClient');
const { StatusModel } = require('./lib/status');
const { RingLog } = require('./lib/log');
const { BridgeEngine } = require('./lib/engine');
const { generateBridgeId } = require('./lib/bridgeId');
const { version: BRIDGE_VERSION } = require('./package.json');

function line(level, msg) {
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);
}

async function main() {
  if (process.argv.includes('--list-adapters')) {
    console.log('Network adapters:\n' + adapterHint());
    return;
  }

  let cfg;
  try {
    cfg = loadConfig(process.env, process.argv.slice(2));
  } catch (err) {
    line('error', err.message);
    process.exit(1);
  }

  // P2.1: a fresh id per process run - not yet persisted (that's a later
  // configuration-storage slice); purely a log/support correlation label,
  // never used for identity or authorization.
  const bridgeId = generateBridgeId();

  line('info', 'cdether-bridge starting');
  line('info', `  server       ${cfg.serverUrl}`);
  if (cfg.dryRun) {
    line('info', '  destination  (dry run - no UDP)');
  } else {
    line('info', `  destination  ${cfg.broadcastAddress}:${cfg.cdetherPort} (broadcast)`);
    line('info', `  interface    ${cfg.interfaceName || '(unmatched)'}  bind ${cfg.bindAddress || '0.0.0.0 (unbound)'}`);
    if (!cfg.bound) {
      line('warn', 'UDP socket will be UNBOUND - on a multi-homed PC the broadcast may leave the wrong adapter. Set CDETHER_INTERFACE.');
    }
    if (cfg.broadcastOverridden) {
      line('warn', `BROADCAST_ADDRESS overrides the address computed from ${cfg.interfaceName}`);
    }
  }
  line('info', `  interval     ${cfg.frameIntervalMs} ms`);
  line('info', `  bridge id    ${bridgeId}  (v${BRIDGE_VERSION}) - reported to the Presentation Timer for the Control page's compact status indicator`);
  line('info', `  idle         ${cfg.idleBehaviour}`);
  line('warn', 'CDEther protocol here is EMPIRICAL (rig-derived), not an official Hive spec.');

  // --- UDP transport ---
  let sender;
  if (cfg.dryRun) {
    sender = { send: async () => ({ ok: true, error: null }), close: async () => {} };
  } else {
    sender = new UdpSender({ address: cfg.broadcastAddress, port: cfg.cdetherPort, bindAddress: cfg.bindAddress });
    let lastErrLog = 0;
    sender.onError = (err) => {
      const now = Date.now();
      if (now - lastErrLog > 10000) {
        lastErrLog = now;
        line('error', `UDP error: ${err.message}`);
      }
    };
    try {
      await sender.ready;
    } catch (err) {
      line('error', `Cannot open/bind UDP socket (${cfg.bindAddress || 'unbound'}): ${err.message}`);
      process.exit(1);
    }
  }

  // --- core ---
  const status = new StatusModel();
  const log = new RingLog();
  const pt = new PtClient({ serverUrl: cfg.serverUrl, displayToken: cfg.displayToken });
  const engine = new BridgeEngine({
    ptClient: pt,
    sender,
    status,
    log,
    deriveFrame,
    options: {
      frameIntervalMs: cfg.frameIntervalMs,
      idleBehaviour: cfg.idleBehaviour,
      bridgeId,
      bridgeVersion: BRIDGE_VERSION,
      getInterfaceName: () => cfg.interfaceName || null,
    },
  });

  engine.on('log', ({ level, message }) => line(level, message));

  let lastOverall = null;
  engine.on('status', (snap) => {
    if (snap.overall.state !== lastOverall) {
      lastOverall = snap.overall.state;
      line('info', `STATUS ${snap.overall.state.toUpperCase()} - ${snap.overall.reason}`);
    }
  });

  let lastFrameKey = null;
  let unchanged = 0;
  engine.on('frame', ({ decoded, frame, ok }) => {
    const key = decoded + ok;
    if (key !== lastFrameKey || unchanged >= 30) {
      line('info', `TX ${decoded}${ok ? '' : ' (SEND FAILED)'} <- ${frame.reason || frame.colour}`);
      unchanged = 0;
    } else {
      unchanged++;
    }
    lastFrameKey = key;
  });

  engine.on('fatal', async () => {
    await sender.close();
    process.exit(2);
  });

  // --- signals: intentional stop -> one OFF, then exit 0 ---
  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    line('info', `${sig} - sending OFF and shutting down`);
    await engine.dispose();
    await sender.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // Graceful stop for a parent process (P2's UI host, and CI). On Windows a
  // spawned child cannot be sent a catchable signal, so an explicit request is
  // the reliable path; `{ cmd: 'shutdown' }` over an IPC channel, or the line
  // "shutdown" / "quit" on stdin.
  if (typeof process.on === 'function') {
    process.on('message', (m) => {
      if (m && (m === 'shutdown' || m.cmd === 'shutdown')) shutdown('IPC shutdown');
    });
  }
  if (process.stdin && process.stdin.readable) {
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      if (/\b(shutdown|quit)\b/i.test(buf)) shutdown('stdin');
    });
    if (process.stdin.unref) process.stdin.unref(); // don't keep the process alive on stdin alone
  }

  // Terminal tool: connect and start output immediately.
  engine.connect();
  engine.start();
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} [fatal] ${err.stack || err}`);
  process.exit(1);
});
