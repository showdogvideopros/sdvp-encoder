
'use strict';
// LOAD THE SERVICE'S ENVIRONMENT WHEN RUNNING BY HAND.
//
// [MEASURED 2026-08-21] The systemd unit reads EnvironmentFile=/root/config/
// encoder.env, so the daemon has its pCloud token and anything run from the
// command line does not. Every tool in this folder failed with "Log in failed"
// when run directly - correct behaviour, confusing symptom, and it looked
// exactly like a broken credential.
//
// The file lives OUTSIDE the working tree deliberately, so a credential can
// never be committed. This does not move it; it only reads it.
//
// ⛔ NEVER PRINTS A VALUE. It reports how many variables it loaded and nothing
// else. A tool's output is a transcript, and a transcript has no undo.
//
// Already-set variables WIN, so an operator overriding one on the command line
// is not silently overruled by the file.

const fs = require('fs');

const ENV_FILE = process.env.SDVP_ENV_FILE || '/root/config/encoder.env';

function loadEnv(opts) {
  const quiet = !!(opts && opts.quiet);
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch (e) {
    if (!quiet) console.error('note: could not read ' + ENV_FILE + ' - ' + e.code);
    return { loaded: 0, file: ENV_FILE, ok: false };
  }
  let n = 0, skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) { skipped++; continue; }
    let val = line.slice(eq + 1).trim();
    if ((val.charAt(0) === '"' && val.slice(-1) === '"') ||
        (val.charAt(0) === "'" && val.slice(-1) === "'")) val = val.slice(1, -1);
    process.env[key] = val;
    n++;
  }
  if (!quiet) {
    console.log('environment: ' + n + ' variable(s) loaded from ' + ENV_FILE +
                (skipped ? ', ' + skipped + ' already set and left alone' : ''));
  }
  return { loaded: n, file: ENV_FILE, ok: true };
}

module.exports = { loadEnv, ENV_FILE };
