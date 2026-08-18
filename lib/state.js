'use strict';
const fs = require('fs');
const path = require('path');

const ROOT  = process.env.SDVP_ENC_ROOT || '/var/lib/sdvp-encoder';
const STATE = path.join(ROOT, 'state.json');
const EVENTS= path.join(ROOT, 'events.ndjson');
const STATE_VERSION = 1;
const MIN_WRITE_MS  = 500;

function ensureDirs() {
  for (const d of [ROOT, path.join(ROOT,'jobs'), path.join(ROOT,'scratch')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

function emptyState() {
  return {
    state_version: STATE_VERSION,
    updated_at: new Date().toISOString(),
    daemon: { pid: null, started_at: null, current_item: null },
    runs: []
  };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (s.state_version !== STATE_VERSION) {
      throw new Error('state_version ' + s.state_version + ' != ' + STATE_VERSION);
    }
    return s;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
}

// temp -> fsync -> rename -> fsync(dir). A reader sees old or new, never torn.
function writeAtomic(file, text) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

function saveNow(state) {
  state.updated_at = new Date().toISOString();
  writeAtomic(STATE, JSON.stringify(state, null, 2) + '\n');
}

let pendingState = null, timer = null, lastWrite = 0;

function save(state, opts) {
  const force = !!(opts && opts.force);
  if (force) {
    if (timer) { clearTimeout(timer); timer = null; }
    pendingState = null;
    lastWrite = Date.now();
    return saveNow(state);
  }
  const now = Date.now();
  pendingState = state;
  if (now - lastWrite >= MIN_WRITE_MS) {
    lastWrite = now;
    const s = pendingState; pendingState = null;
    return saveNow(s);
  }
  if (!timer) {
    timer = setTimeout(function () {
      timer = null; lastWrite = Date.now();
      const s = pendingState; pendingState = null;
      if (s) saveNow(s);
    }, MIN_WRITE_MS - (now - lastWrite));
  }
}

function event(obj) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)) + '\n';
  fs.appendFileSync(EVENTS, line, { mode: 0o600 });
}

module.exports = {
  ROOT, STATE, EVENTS, STATE_VERSION,
  ensureDirs, emptyState, load, save, saveNow, writeAtomic, event
};
