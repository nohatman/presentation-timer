'use strict';

// Makes the Ed25519 key pair for Foxy Timer for Windows trial licences.
//   node scripts/make-licence-keys.js <private-key-output-file>
// Writes the private key to that file (keep it out of git, back it up) and
// puts the public key into trials.js. Then set Railway's
// FOXY_LICENCE_PRIVATE_KEY to the one-line value this prints.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/make-licence-keys.js <private-key-output-file>');
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`${out} already exists - not overwriting a private key.`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, privatePem, { mode: 0o600 });

const trialsPath = path.join(__dirname, '..', 'trials.js');
const src = fs.readFileSync(trialsPath, 'utf8');
const updated = src.replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/, publicPem.trim());
fs.writeFileSync(trialsPath, updated);

console.log(`Private key written to ${out}`);
console.log('Public key written into trials.js');
console.log('\nRailway FOXY_LICENCE_PRIVATE_KEY value (one line):\n');
console.log(privatePem.trim().replace(/\n/g, '\\n'));
