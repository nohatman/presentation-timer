'use strict';

// Network-interface enumeration and directed-broadcast maths.
//
// Pure except for reading os.networkInterfaces(). No logging, no side effects.
// Used to let the operator pick which adapter CDEther traffic leaves by, and to
// bind the UDP socket to that adapter (a multi-homed venue PC otherwise sends
// broadcasts out whatever interface the OS routing table prefers, which is
// usually the internet NIC, not the isolated CDEther LAN).

const os = require('node:os');

/**
 * IPv4 dotted-quad <-> uint32.
 */
function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) throw new Error(`Not an IPv4 address: "${ip}"`);
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Not an IPv4 address: "${ip}"`);
    }
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

function intToIp(n) {
  n = n >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/**
 * Directed (subnet) broadcast address for an interface: host bits all set.
 * ('192.168.8.238', '255.255.255.0') -> '192.168.8.255'
 * Throws on a nonsensical mask (non-contiguous, or /31–/32 which has no
 * usable broadcast).
 */
function directedBroadcast(address, netmask) {
  const addr = ipToInt(address);
  const mask = ipToInt(netmask);

  // Mask must be a run of 1s followed by a run of 0s.
  const inverted = (~mask) >>> 0;
  if (((inverted + 1) & inverted) !== 0) {
    throw new Error(`Netmask "${netmask}" is not contiguous`);
  }
  const prefix = 32 - Math.log2(inverted + 1);
  if (prefix >= 31) {
    throw new Error(`Netmask "${netmask}" (/${prefix}) has no directed broadcast address`);
  }

  return intToIp((addr & mask) | inverted);
}

/**
 * CIDR prefix length for a mask, for display ("192.168.8.238/24").
 */
function prefixLength(netmask) {
  const inverted = (~ipToInt(netmask)) >>> 0;
  return 32 - Math.log2(inverted + 1);
}

/**
 * List usable IPv4 interfaces.
 * @param {{includeInternal?: boolean}} opts
 * @returns {Array<{name,address,netmask,mac,internal,cidr,broadcast}>}
 */
function listInterfaces({ includeInternal = false } = {}) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      // Node <18 used the number 4; >=18 uses the string 'IPv4'. Accept both.
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4) continue;
      if (a.internal && !includeInternal) continue;

      let broadcast = null;
      try {
        broadcast = a.internal ? null : directedBroadcast(a.address, a.netmask);
      } catch {
        broadcast = null; // odd mask - still list the adapter, just no computed broadcast
      }

      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac || null,
        internal: !!a.internal,
        cidr: a.cidr || `${a.address}/${prefixLength(a.netmask)}`,
        broadcast,
      });
    }
  }
  return out;
}

/**
 * Re-resolve a saved adapter. Match by NAME first (a venue DHCP lease can hand
 * the same adapter a different address between sessions), then by address as a
 * fallback. Returns the current interface record or null.
 * @param {{name?: string, address?: string}} sel
 */
function resolveInterface(sel = {}) {
  const list = listInterfaces({ includeInternal: true });
  if (sel.name) {
    const byName = list.find((i) => i.name === sel.name && !i.internal);
    if (byName) return byName;
  }
  if (sel.address) {
    const byAddr = list.find((i) => i.address === sel.address);
    if (byAddr) return byAddr;
  }
  return null;
}

module.exports = {
  directedBroadcast,
  prefixLength,
  listInterfaces,
  resolveInterface,
  ipToInt,
  intToIp,
};
