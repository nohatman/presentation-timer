'use strict';

// Passive CDEther frame sniffer. READ-ONLY: binds UDP :36700 and logs every
// frame it receives; it never sends anything. Investigation instrument for the
// P1.1 protocol study - see P1.1-PROTOCOL-INVESTIGATION.md. Does not touch the
// bridge or any supported CDEther behaviour.
//
//   node tools/sniff.js                 log every frame
//   node tools/sniff.js --diff          log only when the bytes change (+ the first)
//   node tools/sniff.js --port 36700    default
//   node tools/sniff.js --bind 0.0.0.0  default (all interfaces; best for broadcast)
//   Ctrl+C                              print a distinct-frame summary and exit
//
// Note: to receive a directed broadcast the socket should stay bound to all
// interfaces (the default). Some stacks will NOT deliver broadcast to a socket
// bound to a single interface address.

const dgram = require('node:dgram');
const { describeFrame } = require('../lib/cdether');

function parseArgs(argv) {
  const o = { diff: false, port: 36700, bind: '0.0.0.0', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--diff') o.diff = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--bind') o.bind = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function decode(buf) {
  if (buf.length === 3) {
    try { return describeFrame(buf); } catch { return '(3 bytes, undecodable)'; }
  }
  return `(${buf.length} bytes, non-standard)`;
}

/** Which 1-indexed byte positions differ between two hex strings. */
function changedBytes(prevHex, curHex) {
  if (!prevHex) return [];
  const p = prevHex.split(' ');
  const c = curHex.split(' ');
  const out = [];
  for (let i = 0; i < Math.max(p.length, c.length); i++) {
    if (p[i] !== c[i]) out.push('b' + (i + 1));
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node tools/sniff.js [--diff] [--port 36700] [--bind 0.0.0.0]');
    return;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error(`bad --port: ${opts.port}`);
    process.exit(1);
  }

  const seen = new Map();
  let prevHex = null;
  let total = 0;

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    console.error(`socket error: ${err.message}`);
    process.exit(1);
  });

  sock.on('message', (msg, rinfo) => {
    total++;
    const h = hex(msg);
    const changed = changedBytes(prevHex, h);
    seen.set(h, (seen.get(h) || 0) + 1);
    if (!opts.diff || !prevHex || changed.length) {
      const mark = changed.length ? `  CHANGED:${changed.join(',')}` : (!prevHex ? '  (first)' : '');
      console.log(`${new Date().toISOString()}  ${String(rinfo.address).padEnd(15)}  [${h}]  ${decode(msg)}${mark}`);
    }
    prevHex = h;
  });

  function summary() {
    console.log(`\n--- ${total} frame(s) received, ${seen.size} distinct ---`);
    [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([h, n]) => {
        const buf = Buffer.from(h.split(' ').map((x) => parseInt(x, 16)));
        console.log(`  ${String(n).padStart(6)}  [${h}]  ${decode(buf)}`);
      });
  }

  let closing = false;
  function stop(sig) {
    if (closing) return;
    closing = true;
    console.log(`\n${sig}`);
    summary();
    sock.close(() => process.exit(0));
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => stop('SIGBREAK'));

  const done = () => {
    try { sock.setBroadcast(true); } catch { /* not needed to receive */ }
    const a = sock.address();
    console.log(`sniffing udp ${a.address}:${a.port} — passive, never sends. Ctrl+C for a distinct-frame summary.`);
  };
  if (!opts.bind || opts.bind === '0.0.0.0') sock.bind(opts.port, done);
  else sock.bind(opts.port, opts.bind, done);
}

module.exports = { parseArgs, hex, decode, changedBytes };

if (require.main === module) main();
