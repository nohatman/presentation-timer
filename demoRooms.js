'use strict';

// "Try it now" demo rooms from the landing page. Anyone can create one without
// signing up; it belongs to a dedicated demo client (no users, so nobody can
// log in to it) and is deleted when it expires. The route and the expiry sweep
// live in server.js; this module holds the settings and the seeded state.
//
// Env vars (all optional):
//   DEMO_TTL_MIN         minutes a demo room lives            (default 120)
//   DEMO_MAX_ACTIVE      unexpired demo rooms allowed at once (default 100)
//   DEMO_PER_IP_PER_HOUR demo rooms one IP can create an hour (default 3)
//   DEMO_SWEEP_MS        how often expired rooms are deleted  (default 60000)

const DEMO_CLIENT_NAME = 'Demo rooms (auto-expiring)';

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getDemoConfig(env = process.env) {
  return {
    ttlMs: Math.round(positiveNumber(env.DEMO_TTL_MIN, 120) * 60 * 1000),
    maxActive: positiveInt(env.DEMO_MAX_ACTIVE, 100),
    perIpPerHour: positiveInt(env.DEMO_PER_IP_PER_HOUR, 3),
    sweepMs: positiveInt(env.DEMO_SWEEP_MS, 60 * 1000)
  };
}

// A short sample programme so the display shows a speaker and "up next" straight
// away. Short durations so the warning colours are reachable in a demo.
const SAMPLE_RUNDOWN = [
  { name: 'Welcome - Sam Rivers', durationMs: 3 * 60 * 1000 },
  { name: 'Keynote - Dr Priya Shah', durationMs: 10 * 60 * 1000 },
  { name: 'Panel & audience Q&A', durationMs: 8 * 60 * 1000 },
  { name: 'Closing remarks', durationMs: 2 * 60 * 1000 }
];

// Seeds a default timer state: first rundown item loaded (stopped, ready to
// Start), with warning thresholds scaled to the short items.
function seedDemoState(defaultState, loadRundownItem) {
  const state = {
    ...defaultState,
    rundown: SAMPLE_RUNDOWN.map((item) => ({ ...item })),
    amberThresholdMs: 60 * 1000,
    redThresholdMs: 30 * 1000
  };
  loadRundownItem(state, 0, false, Date.now());
  return state;
}

// Sliding one-hour window per key (IP). Same in-memory approach as the login
// and contact limiters.
function createHourlyLimiter(limit, windowMs = 60 * 60 * 1000) {
  const hits = new Map();
  return {
    // true = allowed (and counted); false = over the limit
    take(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      return true;
    }
  };
}

module.exports = { DEMO_CLIENT_NAME, SAMPLE_RUNDOWN, getDemoConfig, seedDemoState, createHourlyLimiter };
