'use strict';
// QUALITY PROBE — rides the verification decode, which already reads every frame.
//
// MEASURED 2026-08-19 on a 30.7-min 720p rung:
//   video decode alone ............ 22.94 s
//   decode + contact sheet ........ 23.05 s   (+0.5%, effectively free)
//   audio statistics alone ......... 4.16 s
//   all three in one pass ......... 27.16 s
// Attached to ONE rung per movie, not all six: a garbled master garbles every
// rung identically, and six sheets per movie is clutter, not coverage.
//
// WHAT IS GATED: dead channel, silent channel, sustained flatness. Facts.
// WHAT IS RECORDED ONLY: peak dB, RMS dB, channel imbalance. No corpus exists
// yet to draw honest thresholds from - run #7 showed peak +5.1 dBFS and a
// 2.9 dB channel imbalance on a file with no complaint against it. Bands get
// drawn from measurement after a run, never invented in advance.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FFMPEG = '/usr/local/bin/ffmpeg';
const SHEET_TILES_X = 8;
const SHEET_TILES_Y = 5;
const SHEET_TILE_W  = 320;
const SHEET_QUALITY = 3;

// A channel this quiet is not carrying programme audio.
const SILENT_RMS_DB = -60;
// astats flat factor: sustained identical samples. Zero on healthy audio.
const FLAT_FACTOR_MAX = 10;

// The codec MUST reach the filename. Two sheets per movie when a run requests
// both codecs; without the codec in the name the second overwrites the first -
// exactly the collision that ate fifteen of sixteen manifests on run #7.
function sheetName(srcName, codec) {
  return '_sdvp_quality_' + path.parse(srcName).name + ' - ' + String(codec) + '.jpg';
}

// Parse the astats block ffmpeg writes to stderr. Per-channel, then Overall.
function parseAstats(text) {
  const chans = [];
  let cur = null, overall = null, inOverall = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/^\[Parsed_astats[^\]]*\]\s*/, '').trim();
    if (/^Channel:\s*\d+$/.test(line)) {
      cur = { channel: Number(line.split(':')[1].trim()) };
      chans.push(cur); inOverall = false; continue;
    }
    if (/^Overall$/.test(line)) { overall = {}; cur = overall; inOverall = true; continue; }
    if (!cur) continue;
    const eq = line.indexOf(':');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = Number(line.slice(eq + 1).trim());
    if (!isFinite(v)) continue;
    if (k === 'peak level db')   cur.peak_db = v;
    if (k === 'rms level db')    cur.rms_db = v;
    if (k === 'flat factor')     cur.flat_factor = v;
    if (k === 'peak count')      cur.peak_count = v;
    if (k === 'number of samples') cur.samples = v;
  }
  if (inOverall && overall && chans.length && chans[chans.length - 1] === overall) chans.pop();
  return { channels: chans, overall: overall };
}

// Judge the parsed profile. Returns { checks: [...], ok, notes }.
function judgeAudio(profile, hasAudioStream) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: ok, detail: detail });

  if (!hasAudioStream) {
    add('audio-present', false, 'no audio stream');
    return { checks: checks, ok: false };
  }
  add('audio-present', true, null);

  const ch = (profile && profile.channels) || [];
  if (!ch.length) {
    // No statistics from a file that HAS audio is a refusal, never a pass.
    add('audio-measurable', false, 'astats produced no channel data');
    return { checks: checks, ok: false };
  }
  add('audio-measurable', true, ch.length + ' channels');

  const dead = ch.filter(c => !isFinite(c.rms_db) || c.rms_db <= SILENT_RMS_DB);
  add('audio-live', dead.length === 0,
      dead.length ? 'channel(s) at or below ' + SILENT_RMS_DB + ' dB: ' +
                    dead.map(c => c.channel).join(',')
                  : ch.map(c => c.rms_db.toFixed(1)).join(' / ') + ' dB RMS');

  const flat = ch.filter(c => isFinite(c.flat_factor) && c.flat_factor > FLAT_FACTOR_MAX);
  add('audio-not-flat', flat.length === 0,
      flat.length ? 'flat factor above ' + FLAT_FACTOR_MAX + ' on channel(s) ' +
                    flat.map(c => c.channel).join(',')
                  : 'flat factor ' + ch.map(c => c.flat_factor.toFixed(1)).join(' / '));

  // RECORDED, NOT GATED - no corpus yet.
  const rms = ch.map(c => c.rms_db).filter(isFinite);
  const flatVals = ch.map(c => c.flat_factor).filter(isFinite);
  const imbalance = rms.length > 1 ? Math.max.apply(null, rms) - Math.min.apply(null, rms) : 0;

  return {
    checks: checks,
    ok: checks.every(c => c.ok),
    recorded: {
      peak_db: ch.map(c => c.peak_db),
      rms_db: rms,
      imbalance_db: Number(imbalance.toFixed(2)),
      // WORST channel, never a mean. The gate refuses on a SINGLE flat
      // channel; averaging would hide one behind a healthy one. MEASURED
      // 2026-08-20: the record stored a literal null here for every movie
      // ever probed, so the one value the gate actually judges on was the
      // one value never kept.
      flat_max: flatVals.length ? Math.max.apply(null, flatVals) : null,
      channels: ch.length
    }
  };
}

// ONE ffmpeg pass: full video decode (the frame count's own work is separate),
// audio statistics, and a contact sheet. Returns paths and the audio profile.
// opts.audio - run astats. TRUE on the top H.264 rung only: the mezzanine's
// audio is the same AAC from the same source, so measuring it twice buys
// nothing but four seconds. The SHEET runs per codec, because HEVC has its own
// artifact vocabulary (ringing from cheap x265 presets, motion smearing) that
// neither the frame count nor the bitrate band can see.
//
// The two sheets are a CONTROLLED COMPARISON with the master as shared
// reference: present in both means the master; present in one means that
// codec's encoder.
// CONFOUND, and it is real: the sheets come from rungs of different heights,
// so the HEVC tiles carry more detail for reasons unrelated to codec. Sharpness
// is NOT comparable between them. Structure is - blue frames, gray frames,
// dropouts, repeating overlays, gross blocking survive the scale difference.
function runProbe(file, durationS, outDir, srcName, codec, opts) {
  const wantAudio = !opts || opts.audio !== false;
  const sheet = path.join(outDir, sheetName(srcName, codec));
  const tiles = SHEET_TILES_X * SHEET_TILES_Y;
  const rate  = (durationS > 0) ? (tiles / durationS) : 1;

  // ⛔ TWO PASSES, NEVER ONE. MEASURED 2026-08-20 on TOTAL DOG CHALLENGE
  // (56 min): audio alone read RMS -28.34 dB; the SAME file with the sheet
  // built in the same pass read -50.69 dB. The sheet's fps filter samples
  // 40 frames across the whole movie, and the audio decode is dragged to
  // that cadence, so astats sees a starved fraction of the samples. The
  // error scales with duration: short films looked right BY ACCIDENT.
  // Seven films in run 13 recorded one identical wrong value.
  // Cost of separating: ~4 s per movie, measured and accepted at design.
  function pass(args) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', c => { err += c.toString(); });
      child.on('error', e => resolve({ code: -1, err: 'spawn failed: ' + e.message,
                                       wall: (Date.now() - t0) / 1000 }));
      child.on('close', code => resolve({ code: code, err: err,
                                          wall: (Date.now() - t0) / 1000 }));
    });
  }

  return (async () => {
    let profile = null, audioWall = 0, audioCode = 0, audioErr = '';
    if (wantAudio) {
      const a = await pass([
        '-hide_banner', '-v', 'info', '-nostdin', '-nostats',
        '-i', file,
        '-map', '0:a:0?', '-af', 'astats=reset=0', '-f', 'null', '-'
      ]);
      audioWall = a.wall; audioCode = a.code; audioErr = a.err;
      profile = parseAstats(a.err);
    }

    const s = await pass([
      '-hide_banner', '-v', 'info', '-nostdin', '-nostats',
      '-i', file,
      '-an',
      '-map', '0:v:0',
      '-vf', 'fps=' + rate.toFixed(8) + ',scale=' + SHEET_TILE_W + ':-2,tile=' +
             SHEET_TILES_X + 'x' + SHEET_TILES_Y,
      '-frames:v', '1', '-q:v', String(SHEET_QUALITY), '-y', sheet
    ]);

    const sheetOk = fs.existsSync(sheet) && fs.statSync(sheet).size > 0;
    const failedErr = s.code !== 0 ? s.err : (audioCode !== 0 ? audioErr : '');
    return {
      ok: s.code === 0 && audioCode === 0,
      exit_code: s.code !== 0 ? s.code : audioCode,
      wall_s: s.wall + audioWall,
      audio_wall_s: audioWall,
      sheet_wall_s: s.wall,
      sheet: sheetOk ? sheet : null,
      sheet_name: sheetOk ? sheetName(srcName, codec) : null,
      codec: codec,
      audio_measured: wantAudio,
      sheet_bytes: sheetOk ? fs.statSync(sheet).size : 0,
      audio: profile,
      stderr_tail: failedErr ? failedErr.trim().split('\n').slice(-3).join(' | ').slice(0, 300) : null
    };
  })();
}

module.exports = {
  runProbe, judgeAudio, parseAstats, sheetName,
  SILENT_RMS_DB, FLAT_FACTOR_MAX, SHEET_TILES_X, SHEET_TILES_Y, SHEET_TILE_W
};
