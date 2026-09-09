'use strict';

// Config from environment variables, with optional --flag overrides for quick
// rig testing. No dotenv dependency - use Node 20's native `node --env-file=.env`.

const net = require('./net');

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
      else { out[a.slice(2)] = 'true'; }
    }
  }
  return out;
}

function truthy(v) {
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function adapterHint() {
  const list = net.listInterfaces();
  if (!list.length) return '  (no external IPv4 adapters found)';
  return list.map((i) => `  - ${i.name}  ${i.cidr}  -> broadcast ${i.broadcast || '(n/a)'}`).join('\n');
}

/**
 * Resolve the CDEther destination.
 *
 * CDETHER_INTERFACE (adapter name) is preferred: the directed broadcast and the
 * socket bind address are both derived from it. BROADCAST_ADDRESS still works;
 * if an adapter with that exact directed broadcast exists, its address is used
 * as the bind address, otherwise the socket is left unbound (old POC behaviour,
 * with a warning surfaced by the caller).
 */
function resolveDestination({ interfaceName, broadcastAddress }) {
  if (interfaceName) {
    const iface = net.resolveInterface({ name: interfaceName });
    if (!iface) {
      throw new Error(
        `CDETHER_INTERFACE "${interfaceName}" not found. Available adapters:\n${adapterHint()}`,
      );
    }
    if (!iface.broadcast) {
      throw new Error(`Adapter "${interfaceName}" (${iface.cidr}) has no usable directed broadcast address`);
    }
    return {
      interfaceName,
      bindAddress: iface.address,
      broadcastAddress: broadcastAddress || iface.broadcast,
      broadcastOverridden: !!broadcastAddress && broadcastAddress !== iface.broadcast,
      bound: true,
    };
  }

  // Address-only: best-effort match to an adapter for the bind address.
  const match = net.listInterfaces().find((i) => i.broadcast === broadcastAddress);
  return {
    interfaceName: match ? match.name : null,
    bindAddress: match ? match.address : null,
    broadcastAddress,
    broadcastOverridden: false,
    bound: !!match,
  };
}

function loadConfig(env = process.env, argv = []) {
  const flags = parseFlags(argv);
  const pick = (envKey, flagKey) => {
    const f = flags[flagKey];
    if (f !== undefined) return f;
    return env[envKey];
  };

  const serverUrl = pick('SERVER_URL', 'server');
  const displayToken = pick('DISPLAY_TOKEN', 'token');
  const broadcastAddress = pick('BROADCAST_ADDRESS', 'broadcast') || null;
  const interfaceName = pick('CDETHER_INTERFACE', 'interface') || null;
  const cdetherPort = Number(pick('CDETHER_PORT', 'port') ?? 36700);
  const frameIntervalMs = Number(pick('FRAME_INTERVAL_MS', 'interval') ?? 1000);
  const idleBehaviour = String(pick('IDLE_BEHAVIOUR', 'idle') ?? 'duration').toLowerCase();
  const dryRun = truthy(pick('DRY_RUN', 'dry-run'));
  const logLevel = String(pick('LOG_LEVEL', 'log-level') ?? 'info').toLowerCase();

  const missing = [];
  if (!serverUrl) missing.push('SERVER_URL');
  if (!displayToken) missing.push('DISPLAY_TOKEN');
  if (!broadcastAddress && !interfaceName && !dryRun) {
    missing.push('CDETHER_INTERFACE or BROADCAST_ADDRESS (one is required unless DRY_RUN=true)');
  }
  if (missing.length) {
    let msg = `Missing required config: ${missing.join(', ')}. See .env.example.`;
    if (missing.some((m) => m.startsWith('CDETHER_INTERFACE'))) {
      msg += `\nAvailable network adapters:\n${adapterHint()}`;
    }
    throw new Error(msg);
  }

  if (!['duration', 'off'].includes(idleBehaviour)) {
    throw new Error(`IDLE_BEHAVIOUR must be "duration" or "off" (got "${idleBehaviour}")`);
  }
  if (!Number.isInteger(cdetherPort) || cdetherPort < 1 || cdetherPort > 65535) {
    throw new Error(`CDETHER_PORT must be 1..65535 (got "${cdetherPort}")`);
  }
  if (!Number.isFinite(frameIntervalMs) || frameIntervalMs < 100) {
    throw new Error(`FRAME_INTERVAL_MS must be >= 100 (got "${frameIntervalMs}")`);
  }

  let destination = null;
  if (!dryRun) {
    destination = resolveDestination({ interfaceName, broadcastAddress });
  }

  return {
    serverUrl,
    displayToken,
    cdetherPort,
    frameIntervalMs,
    idleBehaviour,
    dryRun,
    logLevel,
    // destination (null in dry-run):
    interfaceName: destination ? destination.interfaceName : interfaceName,
    broadcastAddress: destination ? destination.broadcastAddress : broadcastAddress,
    bindAddress: destination ? destination.bindAddress : null,
    bound: destination ? destination.bound : false,
    broadcastOverridden: destination ? destination.broadcastOverridden : false,
  };
}

module.exports = { loadConfig, parseFlags, truthy, resolveDestination, adapterHint };
