
'use strict';
// AUDIO GATE CONTROL - proves the gate BOTH WAYS against synthesized defects.
//
// [MEASURED 2026-08-21] Across every run in the record the audio gate has only
// ever returned OK. A gate that has never refused anything is not a gate that
// has been shown to work; it is a gate that has never been asked. flat_max came
// back 0 on all sixteen films of run 30 - correct for healthy audio, and
// indistinguishable from a parser that cannot produce anything else.
//
// Uses the REAL probe and the REAL judge. No reimplementation, or the control
// tests a copy of the thing instead of the thing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Q = require('/root/build/lib/quality.js');
const P = require('/root/build/lib/probe.js');

const FFMPEG = '/usr/local/bin/ffmpeg';
const DIR = '/var/lib/sdvp-encoder/scratch/_audiogate';
const D = 20;

function build(name, audioFilter, acodec) {
  const out = path.join(DIR, name + '.mp4');
  const args = ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=' + D];
  if (audioFilter) args.push('-f', 'lavfi', '-i', audioFilter);
  if (audioFilter && arguments[3]) {
    args.push('-f', 'lavfi', '-i',
              'aevalsrc=0.30*sin(2*PI*440*t)|0.30*sin(2*PI*554*t):s=48000:d=12',
              '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[aout]', '-map', '0:v:0', '-map', '[aout]');
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p');
  if (audioFilter) {
    if (acodec === 'pcm') args.push('-c:a', 'pcm_s16le');
    else args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-t', String(D), '-shortest', out);
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

const SIN440 = '0.30*sin(2*PI*440*t)';
const SIN554 = '0.30*sin(2*PI*554*t)';
const CASES = [
  { name: 'healthy',      af: 'aevalsrc=' + SIN440 + '|' + SIN554 + ':s=48000:d=' + D,
    expect_ok: true,  expect_check: null,
    why: 'two live channels, ordinary programme audio' },
  { name: 'noaudio',      af: null,
    expect_ok: false, expect_check: 'audio-present',
    why: 'no audio stream at all - a silent master' },
  { name: 'deadright',    af: 'aevalsrc=' + SIN440 + '|0:s=48000:d=' + D,
    expect_ok: false, expect_check: 'audio-live',
    why: 'right channel is digital zero' },
  { name: 'dcflat_aac',   af: 'aevalsrc=0.5|0.5:s=48000:d=' + D,
    expect_ok: true,  expect_check: null,
    why: 'constant value, compressed the way a real master is' },
  { name: 'dcflat_pcm',   af: 'aevalsrc=0.5|0.5:s=48000:d=' + D, acodec: 'pcm',
    expect_ok: true,  expect_check: null,
    why: 'constant value, uncompressed - isolates codec ripple' },
  { name: 'dropout',      af: 'aevalsrc=0*t|0*t:s=48000:d=8', concat: true,
    expect_ok: true,  expect_check: null,
    why: '8 s of true digital silence then 12 s of tone - a pulled microphone' },
  { name: 'imbalance3db', af: 'aevalsrc=' + SIN440 + '|0.212*sin(2*PI*440*t):s=48000:d=' + D,
    expect_ok: true,  expect_check: null,
    why: 'right channel 3 dB down - recorded, not gated' }
];

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  console.log('FLAT_FACTOR_MAX = ' + Q.FLAT_FACTOR_MAX + '   SILENT_RMS_DB = ' + Q.SILENT_RMS_DB);
  console.log('');

  let matched = 0;
  for (const c of CASES) {
    let file;
    try { file = build(c.name, c.af, c.acodec, c.concat); }
    catch (e) { console.log(c.name + ' : BUILD FAILED ' + String(e.message).slice(0, 120)); continue; }

    const pr = await P.probe(file);
    const res = await Q.runProbe(file, pr.duration_s || D, DIR, c.name + '.mp4', 'h264', { audio: true });
    const j = Q.judgeAudio(res.audio, pr.has_audio);
    const failed = (j.checks || []).filter(x => !x.ok).map(x => x.name);
    const ch = (res.audio && res.audio.channels) || [];
    const rms  = ch.map(x => (x.rms_db  != null ? x.rms_db.toFixed(1)  : '-')).join('/');
    const flat = ch.map(x => (x.flat_factor != null ? x.flat_factor.toFixed(1) : '-')).join('/');
    const imb  = j.recorded ? j.recorded.imbalance_db : '-';
    const sil = res.silence;
    const silTxt = sil
      ? (sil.n + ' stretch(es), ' + sil.total_s.toFixed(1) + ' s total' +
         (sil.pct != null ? ' (' + sil.pct + '%)' : '') +
         (sil.longest_s != null ? ', longest ' + sil.longest_s.toFixed(1) +
          ' s at ' + sil.longest_at_s.toFixed(1) + ' s' : '') +
         (sil.ends_at_end ? ', ENDS AT FILM END' : ''))
      : 'not measured';
    const fmax = j.recorded ? j.recorded.flat_max : '-';

    const okMatch = (j.ok === c.expect_ok);
    const chkMatch = c.expect_check ? failed.indexOf(c.expect_check) >= 0 : failed.length === 0;
    const verdict = (okMatch && chkMatch) ? 'AS PREDICTED' : '*** DIFFERS ***';
    if (okMatch && chkMatch) matched++;

    console.log(c.name);
    console.log('   ' + c.why);
    console.log('   probe exit ' + res.exit_code + '   has_audio=' + pr.has_audio +
                '   channels=' + ch.length);
    console.log('   silence   ' + silTxt);
    console.log('   RMS ' + (rms || '-') + ' dB   flat ' + (flat || '-') +
                '   flat_max ' + fmax + '   imbalance ' + imb + ' dB');
    console.log('   predicted ok=' + c.expect_ok + (c.expect_check ? ' failing ' + c.expect_check : ' failing nothing'));
    console.log('   actual    ok=' + j.ok + '  failed: ' + (failed.join(',') || 'nothing'));
    console.log('   ' + verdict);
    console.log('');
  }

  console.log(matched + ' of ' + CASES.length + ' matched the prediction');
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('working folder removed: ' + (fs.existsSync(DIR) ? 'NO' : 'yes'));
})();
