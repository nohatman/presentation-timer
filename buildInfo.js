'use strict';

// Build identity for stale-server detection.
//
// The problem this solves: `node server.js` keeps running the code it started
// with, while the browser is served the *current* files from disk. After an
// update the two silently disagree. So the server records a fingerprint of its
// own server-side source files when it starts, and can recompute it from disk at
// any time; a difference means "this process is running older code than the
// files on disk". The commit id (git) is for humans - it is not what detects
// staleness, because uncommitted edits would not change it.
//
// Used by server.js (/api/health) and the Local Show Server launcher.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Server-side code only: changing a page under public/ never needs a restart.
const FINGERPRINT_FILES = ['server.js', 'auth.js', 'db.js', 'urls.js', 'bridgeStatus.js', 'timerModes.js', 'deviceNames.js', 'enquiries.js', 'demoRooms.js', 'buildInfo.js'];

// -> { fingerprint: '10 hex chars', missing: [names] }. Deterministic: depends only
// on the file names and bytes (line endings normalised so a git autocrlf
// checkout does not look like a code change).
function computeFingerprint(rootDir = __dirname, files = FINGERPRINT_FILES) {
  const hash = crypto.createHash('sha1');
  const missing = [];
  for (const name of files) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(rootDir, name), 'utf8').replace(/\r\n/g, '\n');
    } catch {
      missing.push(name);
      hash.update(`${name}\0MISSING\0`);
      continue;
    }
    hash.update(`${name}\0${bytes}\0`);
  }
  return { fingerprint: hash.digest('hex').slice(0, 10), missing };
}

// Best effort; never throws. Falls back to the platform's commit env var
// (Railway sets RAILWAY_GIT_COMMIT_SHA) or FOXY_BUILD_ID, else null.
function gitInfo(rootDir = __dirname) {
  const run = (args) => execFileSync('git', args, { cwd: rootDir, timeout: 2500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const commit = run(['rev-parse', '--short', 'HEAD']);
    let dirty = false;
    try { dirty = run(['status', '--porcelain', '--untracked-files=no']).length > 0; } catch { /* unknown => not flagged */ }
    return { commit, dirty };
  } catch {
    const env = process.env.FOXY_BUILD_ID || process.env.RAILWAY_GIT_COMMIT_SHA || '';
    return { commit: env ? env.slice(0, 7) : null, dirty: false };
  }
}

function formatLabel({ commit, dirty, fingerprint }) {
  return `${commit || 'no-git'}${dirty ? '+edits' : ''} / ${fingerprint}`;
}

function getBuildInfo(rootDir = __dirname) {
  const { commit, dirty } = gitInfo(rootDir);
  const { fingerprint, missing } = computeFingerprint(rootDir);
  const info = { commit, dirty, fingerprint, missing };
  info.label = formatLabel(info);
  return info;
}

// Are two fingerprints "the same build" for stale-detection purposes?
// Unknown (missing/empty) is never treated as a match: better a false alarm than silence.
function fingerprintsMatch(running, disk) {
  return typeof running === 'string' && typeof disk === 'string' && running.length > 0 && running === disk;
}

module.exports = { FINGERPRINT_FILES, computeFingerprint, gitInfo, formatLabel, getBuildInfo, fingerprintsMatch };
