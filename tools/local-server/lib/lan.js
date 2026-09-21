'use strict';

// Which address should another device on the show LAN use?
//
// Pure functions over the shape of os.networkInterfaces(), so they are testable.
// No subnet is assumed: any RFC 1918 private IPv4 is a candidate (10/8,
// 172.16/12, 192.168/16). Loopback, link-local (169.254/16, a "no DHCP" address),
// IPv6 and public addresses are never offered as *the* LAN URL. Adapters that are
// obviously virtual (Hyper-V/WSL, VirtualBox, VMware, Docker, VPN/tunnel) are kept
// in the list but ranked below real ones, since a tablet on the show Wi-Fi cannot
// normally reach them.

const os = require('os');

const VIRTUAL_NAME = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|vmnet|Docker|docker|veth|br-|virbr|Loopback|Pseudo|Bluetooth|Tailscale|ZeroTier|OpenVPN|WireGuard|TAP-|TAP |TUN|Npcap|VPN/i;

function parseIPv4(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateIPv4(address) {
  const o = parseIPv4(address);
  if (!o) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

function isLinkLocal(address) {
  const o = parseIPv4(address);
  return !!o && o[0] === 169 && o[1] === 254;
}

function isVirtualAdapter(name) { return VIRTUAL_NAME.test(String(name)); }

// interfaces: os.networkInterfaces() shape. -> { primary, candidates, ignored }
//   candidates: usable private IPv4s, best first: [{ name, address, virtual }]
//   ignored:    [{ name, address, reason }] so the operator can see what was skipped
function selectLanAddresses(interfaces = os.networkInterfaces()) {
  const real = []; const virtual = []; const ignored = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const a of list || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4) continue; // IPv6 is not offered
      if (a.internal) { ignored.push({ name, address: a.address, reason: 'loopback' }); continue; }
      if (isLinkLocal(a.address)) { ignored.push({ name, address: a.address, reason: 'link-local (no network/DHCP)' }); continue; }
      if (!isPrivateIPv4(a.address)) { ignored.push({ name, address: a.address, reason: 'not a private LAN address' }); continue; }
      (isVirtualAdapter(name) ? virtual : real).push({ name, address: a.address, virtual: isVirtualAdapter(name) });
    }
  }
  const candidates = real.concat(virtual);
  return { primary: candidates.length ? candidates[0] : null, candidates, ignored };
}

module.exports = { isPrivateIPv4, isLinkLocal, isVirtualAdapter, selectLanAddresses };
