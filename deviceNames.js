'use strict';

// Device names for control panels ("Peter's iPad is in control"). A friendly,
// self-chosen LABEL only - an honour system, not identity or auth: it grants
// nothing and is never used for any permission decision. Held in memory on the
// socket for as long as it's connected; never persisted server-side.
//
// Everything that arrives from a client goes through sanitizeDeviceName before
// it's stored or broadcast to the other panels in the room.

const MAX_DEVICE_NAME_LENGTH = 40;

// Code point ranges removed outright: C0/C1 control characters, zero-width
// characters and joiners, line/paragraph separators, bidi embeddings/overrides/
// isolates, and the BOM. (Numeric ranges rather than a regex literal so no
// invisible character ever has to appear in this source file.)
const STRIPPED_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];
const isStripped = (cp) => STRIPPED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

function sanitizeDeviceName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = Array.from(value.normalize('NFC'))
    .filter(ch => !isStripped(ch.codePointAt(0)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  // Truncate by code points, not UTF-16 units, so an emoji is never cut in half.
  return Array.from(cleaned).slice(0, MAX_DEVICE_NAME_LENGTH).join('').trim();
}

module.exports = { sanitizeDeviceName, MAX_DEVICE_NAME_LENGTH };
