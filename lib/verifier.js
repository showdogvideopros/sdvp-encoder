'use strict';
const fs = require('fs');
const { probe } = require('./probe.js');

// Bitrate bands, Mbps. Floor/ceiling wide enough to pass every measured show
// (Purina pristine .. BTCA worst) and narrow enough that a broken encode reds.
const BANDS = {
  1080: [3.0, 12.0], 720: [1.6, 6.0], 540: [1.0, 4.0],
  480:  [0.7, 3.0],  360: [0.45, 2.0], 240: [0.20, 1.2]
};

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

async function verifyRung(file, expectHeight, sourceDurationS) {
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
  const actual = await countFrames(file);
  const expected = (info.fps && info.duration_s) ? info.fps * info.duration_s : 0;
  const ratio = expected > 0 ? actual / expected : 0;
  add('frames', ratio >= 0.98 && ratio <= 1.02,
      actual + ' of ~' + Math.round(expected) + ' (' + (ratio * 100).toFixed(1) + '%)');

  const mbps = (bytes * 8) / info.duration_s / 1e6;
  const band = BANDS[Number(expectHeight)];
  const inBand = band ? (mbps >= band[0] && mbps <= band[1]) : true;
  add('bitrate', inBand, mbps.toFixed(2) + ' Mbps' +
      (band ? ' band ' + band[0] + '-' + band[1] : ' no band'));

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

module.exports = { verifyRung, failedNames, BANDS, REQUIRED_CHECKS, countFrames };
