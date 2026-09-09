'use strict';

// Manual CDEther frame sender for rig bring-up. No Presentation Timer needed.
//
//   node tools/send-frame.js <MM:SS> <green|red|amber|off> [--count N] [--interval MS]
//   node tools/send-frame.js off
//
// Examples:
//   node tools/send-frame.js 12:34 green
//   node tools/send-frame.js 12:34 red
//   node tools/send-frame.js 12:34 amber
//   node tools/send-frame.js 00:00 off
//   node tools/send-frame.js 01:00 green --count 60 --interval 1000   (fake 1s countdown start frame, repeated)
//
// Destination:
//   --interface <adapter name>   derives + binds to that NIC (preferred)
//   --broadcast <addr>           explicit directed broadcast (BROADCAST_ADDRESS env)
//   --port <n>                   CDETHER_PORT env, default 36700
//   node tools/send-frame.js --list-adapters

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

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));

  if (flags['list-adapters']) {
    for (const i of net.listInterfaces()) {
      console.log(`  ${i.name}  ${i.cidr}  -> broadcast ${i.broadcast || '(n/a)'}`);
    }
    return;
  }

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
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);

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

  const buf = encodeFrame({ minutes, seconds, colour });
  const sender = new UdpSender({ address, port, bindAddress });
  sender.onError = (err) => console.error(`UDP error: ${err.message}`);
  await sender.ready;

  console.log(`-> ${address}:${port}${bindAddress ? ` (via ${interfaceName} ${bindAddress})` : ''}  ${describeFrame(buf)}  x${count}`);
  for (let i = 0; i < count; i++) {
    await sender.send(buf);
    if (i < count - 1) await new Promise((r) => setTimeout(r, interval));
  }
  await sender.close();
  console.log('done');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
