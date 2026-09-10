'use strict';

// Manual CDEther frame sender for rig bring-up and the P1.1 protocol
// investigation. No Presentation Timer needed. Investigation tool only - does
// not touch the bridge or any supported CDEther behaviour.
//
//   node tools/send-frame.js <MM:SS> <green|red|amber|off> [--count N] [--interval MS]
//   node tools/send-frame.js off
//   node tools/send-frame.js --raw "10 32 05"          (send an arbitrary 3-byte frame)
//   node tools/send-frame.js --list-adapters
//
// Examples:
//   node tools/send-frame.js 12:34 green --interface Ethernet
//   node tools/send-frame.js --raw "10 32 05" --interface Ethernet
//   node tools/send-frame.js --raw "1b 32 01" --interface Ethernet --count 5 --interval 1000
//
// Destination:
//   --interface <adapter name>   derives + binds to that NIC (preferred)
//   --broadcast <addr>           explicit directed broadcast (BROADCAST_ADDRESS env)
//   --port <n>                   CDETHER_PORT env, default 36700
//
// --raw takes precedence over the MM:SS / colour arguments. Bytes are hex,
// space- or comma-separated, optional "0x" prefix (e.g. "10 32 05" or
// "0x10,0x32,0x05"). Exactly three, each 00-ff.

const { encodeFrame, describeFrame, UdpSender } = require('../lib/cdether');
const net = require('../lib/net');

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = 'true';
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * Parse a --raw value into a 3-byte Buffer. Hex, space/comma separated, optional
 * "0x" prefix. Throws a clear message on anything else.
 */
function parseRawFrame(str) {
  const tokens = String(str == null ? '' : str).trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length !== 3) {
    throw new Error(`--raw needs exactly three bytes, e.g. --raw "10 32 05" (got ${tokens.length})`);
  }
  const bytes = tokens.map((tok) => {
    const h = tok.replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,2}$/i.test(h)) {
      throw new Error(`--raw: "${tok}" is not a hex byte (00-ff)`);
    }
    return parseInt(h, 16);
  });
  return Buffer.from(bytes);
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));

  if (flags['list-adapters']) {
    for (const i of net.listInterfaces()) {
      console.log(`  ${i.name}  ${i.cidr}  -> broadcast ${i.broadcast || '(n/a)'}`);
    }
    return;
  }

  // --- build the frame ---
  let buf;
  let label;
  if (flags.raw !== undefined) {
    if (flags.raw === 'true') throw new Error('--raw needs a value, e.g. --raw "10 32 05"');
    buf = parseRawFrame(flags.raw);
    label = `RAW ${describeFrame(buf)}`;
  } else {
    let time = '00:00';
    let colour = 'green';
    const COLOURS = ['green', 'red', 'amber', 'off'];
    if (positional.length === 1 && COLOURS.includes(positional[0])) {
      colour = positional[0];
    } else {
      if (positional[0]) time = positional[0];
      if (positional[1]) colour = positional[1];
    }
    if (!COLOURS.includes(colour)) throw new Error(`colour must be one of ${COLOURS.join('|')} (got "${colour}")`);
    const m = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!m) throw new Error(`time must be MM:SS (got "${time}")`);
    buf = encodeFrame({ minutes: Number(m[1]), seconds: Number(m[2]), colour });
    label = describeFrame(buf);
  }

  // --- resolve destination ---
  const interfaceName = flags.interface || process.env.CDETHER_INTERFACE || null;
  let address = flags.broadcast || process.env.BROADCAST_ADDRESS || null;
  let bindAddress = null;
  if (interfaceName) {
    const iface = net.resolveInterface({ name: interfaceName });
    if (!iface) throw new Error(`--interface "${interfaceName}" not found (try --list-adapters)`);
    if (!iface.broadcast) throw new Error(`adapter "${interfaceName}" has no directed broadcast`);
    bindAddress = iface.address;
    if (!address) address = iface.broadcast;
  }
  const port = Number(flags.port || process.env.CDETHER_PORT || 36700);
  if (!address) throw new Error('Set --interface <name>, or BROADCAST_ADDRESS / --broadcast <addr>');

  const count = Math.max(1, Number(flags.count || 1));
  const interval = Math.max(0, Number(flags.interval || 1000));

  const sender = new UdpSender({ address, port, bindAddress });
  sender.onError = (err) => console.error(`UDP error: ${err.message}`);
  await sender.ready;

  console.log(`-> ${address}:${port}${bindAddress ? ` (via ${interfaceName} ${bindAddress})` : ''}  ${label}  x${count}`);
  for (let i = 0; i < count; i++) {
    await sender.send(buf);
    if (i < count - 1) await new Promise((r) => setTimeout(r, interval));
  }
  await sender.close();
  console.log('done');
}

module.exports = { parse, parseRawFrame };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
