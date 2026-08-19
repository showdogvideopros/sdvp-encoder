'use strict';
const fs = require('fs');
const { probe } = require('./probe.js');

// Bitrate bands are DERIVED from the rung's own declared maxrate cap, never a
// fixed table. MEASURED 2026-08-17..19 across both codecs and six heights: every
// finished file landed between 48.8 and 86.6 percent of its rung's own declared
// [CORRECTED 2026-08-19 against all 157 rungs in the record. An earlier comment
// said 49 to 75, taken from a hand-assembled subset; 360p reaches 86.6.]
// cap. Range by rung: 720p 54.0-74.5, 540p 56.5-73.7, 480p 60.3-78.0,
// 360p 66.5-86.6, 240p 60.2-79.8, hevc 1080p 48.8-76.4. Original note:
// cap (240p at 0.47 against 900k; 720p
// 2.93-3.71 of 5500k; 1080p hevc 2.93-3.88 of 6M). Floor at a tenth of cap,
// ceiling a quarter above it: fires on a catastrophic encode, cannot fire on
// legitimate content variation. A 2027 HEVC ladder is covered on the day its
// preset is written, 240p included, with no constant to remember.
//
// WHY NOT TIGHTER: the old fixed 1080 floor of 3.0 was drawn from H.264
// reasoning and then exercised ONLY by HEVC (H.264 always skips 1080 as the
// master's own rung). It failed two good mezzanines on run #7, the second by
// seven hundredths of one percent.
// Bitrate cannot detect truncation - that is the frame count, a separate and
// far stronger check - so this band exists only to catch absurdity.
const BAND_FLOOR_FRAC = 0.10;
const BAND_CEIL_FRAC  = 1.25;

// "9M" | "5500k" | "1800k" | number(bps) -> Mbps, or null if unparseable.
function parseRate(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return (isFinite(v) && v > 0) ? v / 1e6 : null;
  const m = String(v).trim().match(/^([0-9]*\.?[0-9]+)\s*([kKmM]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const u = m[2].toLowerCase();
  if (u === 'm') return n;
  if (u === 'k') return n / 1000;
  return n / 1e6;
}

// null means NO BAND, which is a refusal at the call site - never a pass.
function bandFor(rungSpec) {
  if (!rungSpec || typeof rungSpec !== 'object') return null;
  const cap = parseRate(rungSpec.maxrate);
  if (cap === null) return null;
  return [cap * BAND_FLOOR_FRAC, cap * BAND_CEIL_FRAC];
}

const REQUIRED_CHECKS = ['non-empty','openable','height','audio','duration','frames','bitrate'];

function countFrames(file) {
  return new Promise((resolve) => {
    require('child_process').execFile(
      '/usr/local/bin/ffprobe',
      ['-v','error','-select_streams','v:0','-count_frames',
       '-show_entries','stream=nb_read_frames','-of','csv=p=0', file],
      { maxBuffer: 4e6, timeout: 900000 },
      (err, so) => {
        const n = Number(String(so).trim());
        resolve(isFinite(n) && n > 0 ? n : 0);
      });
  });
}

// Same exhaustive decode as countFrames(), but NARRATES.
// ffprobe -count_frames is silent until it finishes; ffmpeg -f null with
// -progress emits frame= and out_time_us several times a second, which is
// what makes a moving bar and a real ETA possible.
function countFramesDecode(file, durationS, onProgress) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn('/usr/local/bin/ffmpeg',
      ['-hide_banner', '-v', 'error', '-nostdin',
       '-progress', 'pipe:1', '-nostats',
       '-i', file, '-map', '0:v:0', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = '', frames = 0, outTime = 0, updates = 0, err = '';
    child.stdout.on('data', (c) => {
      buf += c.toString();
      const cut = buf.lastIndexOf('\n');
      if (cut < 0) return;
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 1);
      for (const line of chunk.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
        if (k === 'frame') { const n = Number(v); if (isFinite(n) && n > 0) frames = n; }
        else if (k === 'out_time_us') { const n = Number(v); if (isFinite(n) && n >= 0) outTime = n / 1e6; }
      }
      updates++;
      if (onProgress && durationS > 0) {
        onProgress({ pct: Math.min(100, (outTime / durationS) * 100),
                     frames: frames, out_time_s: outTime, updates: updates });
      }
    });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', () => resolve({ frames: 0, updates: 0, error: 'spawn failed' }));
    child.on('close', (code) => {
      resolve({ frames: code === 0 ? frames : 0, updates: updates,
                error: code === 0 ? null : (err.trim().split('\n')[0] || 'exit ' + code) });
    });
  });
}

async function verifyRung(file, expectHeight, sourceDurationS, rungSpec, onProgress) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  if (!fs.existsSync(file)) {
    return { ok: false, checks: [{ name: 'exists', ok: false, detail: 'missing' }],
             coverage_ok: false, missing_checks: REQUIRED_CHECKS.slice() };
  }
  const bytes = fs.statSync(file).size;
  add('non-empty', bytes > 0, bytes + ' bytes');

  let info = null;
  try { info = await probe(file); add('openable', true, null); }
  catch (e) {
    add('openable', false, String(e.message).split('\n')[0].slice(0, 100));
    return finish(checks, { bytes });
  }

  add('height', info.height === Number(expectHeight),
      info.width + 'x' + info.height + ' want ' + expectHeight);
  add('audio', !!info.has_audio, info.audio_codec || 'none');

  const dd = Math.abs(info.duration_s - sourceDurationS);
  add('duration', dd < 0.5, dd.toFixed(2) + 's drift');

  // FRAME COUNT vs HEADER CLAIM. A truncated file keeps its header but
  // cannot produce frames it does not contain. Costs a full decode pass.
  const dec = await countFramesDecode(file, info.duration_s, onProgress);
  const actual = dec.frames;
  const expected = (info.fps && info.duration_s) ? info.fps * info.duration_s : 0;
  const ratio = expected > 0 ? actual / expected : 0;
  add('frames', ratio >= 0.98 && ratio <= 1.02,
      actual + ' of ~' + Math.round(expected) + ' (' + (ratio * 100).toFixed(1) + '%)');

  const mbps = (bytes * 8) / info.duration_s / 1e6;
  const band = bandFor(rungSpec);
  if (!band) {
    // A check with nothing to compare against is a FAILURE, never a silent pass.
    add('bitrate', false, mbps.toFixed(2) +
        ' Mbps - NO BAND: rung spec absent or maxrate unparseable');
  } else {
    add('bitrate', mbps >= band[0] && mbps <= band[1],
        mbps.toFixed(2) + ' Mbps band ' +
        band[0].toFixed(2) + '-' + band[1].toFixed(2));
  }

  return finish(checks, { bytes, mbps, height: info.height, duration_s: info.duration_s });
}

// A declared check that did not run is a FAILURE, never a silent pass.
function finish(checks, extra) {
  const ran = new Set(checks.map(c => c.name));
  const missing = REQUIRED_CHECKS.filter(n => !ran.has(n));
  const allPassed = checks.every(c => c.ok);
  return Object.assign({
    ok: allPassed && missing.length === 0,
    coverage_ok: missing.length === 0,
    missing_checks: missing,
    checks
  }, extra || {});
}

function failedNames(v) { return v.checks.filter(c => !c.ok).map(c => c.name).join(','); }

module.exports = { verifyRung, failedNames, bandFor, parseRate,
                   BAND_FLOOR_FRAC, BAND_CEIL_FRAC,
                   REQUIRED_CHECKS, countFrames, countFramesDecode };
