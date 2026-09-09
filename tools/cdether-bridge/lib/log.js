'use strict';

// Bounded in-memory event log. The bridge writes here *and* to stdout, so
// terminal use is unchanged and a later UI can render tail()/toText() without
// the core needing to know a UI exists.

const DEFAULT_CAPACITY = 500;

class RingLog {
  constructor({ capacity = DEFAULT_CAPACITY } = {}) {
    this.capacity = Math.max(1, capacity);
    this._entries = [];
  }

  /** level: 'info' | 'warn' | 'error' */
  push(level, message) {
    const entry = { t: Date.now(), level, message: String(message) };
    this._entries.push(entry);
    if (this._entries.length > this.capacity) {
      this._entries.splice(0, this._entries.length - this.capacity);
    }
    return entry;
  }

  /** Most recent n entries (default: all held). */
  tail(n) {
    if (n == null || n >= this._entries.length) return this._entries.slice();
    return this._entries.slice(this._entries.length - n);
  }

  toText(n) {
    return this.tail(n)
      .map((e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.message}`)
      .join('\n');
  }

  clear() {
    this._entries = [];
  }

  get size() {
    return this._entries.length;
  }
}

module.exports = { RingLog, DEFAULT_CAPACITY };
