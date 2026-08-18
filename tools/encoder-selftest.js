'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pc = require('/root/build/lib/pcloud.js');
const { probe, FFPROBE } = require('/root/build/lib/probe.js');
const P = require('/root/build/lib/planner.js');
const E = require('/root/build/lib/encoder.js');

const FILEID = 89850766198;
const SCRATCH = '/var/lib/sdvp-encoder/scratch/_enctest';
const SLICE_S = 90;
const RUNGS = [1080, 720, 540, 480, 360, 240];
const preset = JSON.parse(fs.readFileSync('/root/build/presets/h264-standard.json', 'utf8'));

function sh(bin, args) {
  return new Promise((res, rej) => execFile(bin, args, { maxBuffer: 8e6 },
    (e, so, se) => e ? rej(new Error((se || e.message).trim())) : res(so)));
}
function gb(n) { return (n / 1e9).toFixed(2) + ' GB'; }
function mb(n) { return (n / 1e6).toFixed(1) + ' MB'; }

(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const src = path.join(SCRATCH, 'source.mp4');

  console.log('── 1. PULL ──');
  let t = Date.now();
  const d = await pc.download(FILEID, src, null, null);
  let secs = (Date.now() - t) / 1000;
  console.log('  ' + d.name + '  ' + gb(d.bytes) + ' in ' + secs.toFixed(1) + 's  (' +
              ((d.bytes * 8) / secs / 1e6).toFixed(0) + ' Mbps)');

  console.log('');
  console.log('── 2. PROBE THE REAL MASTER ──');
  const info = await probe(src);
  console.log('  ' + info.width + 'x' + info.height + '  ' + info.video_codec +
              '  ' + info.fps_ratio + ' (' + info.fps.toFixed(2) + ' fps)');
  console.log('  duration ' + (info.duration_s / 60).toFixed(1) + ' min   ' +
              (info.bit_rate / 1e6).toFixed(2) + ' Mbps   audio: ' +
              (info.has_audio ? info.audio_codec : 'NONE'));

  console.log('');
  console.log('── 3. KNOWN-POSITIVE: bad encoder must REFUSE ──');
  const badDir = path.join(SCRATCH, 'bad'); fs.mkdirSync(badDir, { recursive: true });
  try {
    await E.runEncode({ src, plannedRungs: [{ height: 240 }], preset, outDir: badDir,
      srcName: d.name, durationS: info.duration_s,
      overrides: { encoder: 'libx264_definitely_not_real' } });
    console.log('  ⛔ SUCCEEDED — error path is BLIND');
  } catch (e) {
    console.log('  refused: ' + String(e.message).split('\n')[0].slice(0, 120));
    console.log('  leftover files: ' + fs.readdirSync(badDir).length + ' (want 0)'); var onTarget = /unknown encoder|encoder not found|libx264_definitely_not_real/i.test(String(e.message)); console.log('  refused ON THE ENCODER: ' + (onTarget ? 'YES' : 'NO  <- CONTROL IS BLIND, red for an unrelated reason')); if (!onTarget) { console.error('  ABORTING - control cannot test what it claims'); process.exit(1); }
  }

  console.log('');
  console.log('── 4. SLICE ' + SLICE_S + 's ──');
  const slice = path.join(SCRATCH, 'slice.mp4');
  await sh(E.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
                      '-t', String(SLICE_S), '-c', 'copy', '-movflags', '+faststart', slice]);
  const sInfo = await probe(slice);
  console.log('  ' + mb(fs.statSync(slice).size) + '  ' + sInfo.duration_s.toFixed(1) + 's');

  console.log('');
  console.log('── 5. PLAN FROM THE REAL PROBE ──');
  const plan = P.planRungs(sInfo, { codec: 'h264', preset: 'h264-standard', rungs: RUNGS });
  for (const r of plan.rungs) {
    console.log('  ' + String(r.height).padStart(4) + 'p  ' + r.state.padEnd(8) +
                (r.reason ? '  ' + r.reason : ''));
  }

  console.log('');
  console.log('── 6. ENCODE ──');
  const outDir = path.join(SCRATCH, 'out'); fs.mkdirSync(outDir, { recursive: true });
  const planned = plan.rungs.filter(r => r.state === 'PLANNED');
  let last = 0;
  const res = await E.runEncode({
    src: slice, plannedRungs: planned, preset, outDir, srcName: d.name,
    durationS: sInfo.duration_s,
    onSpawn: (args) => console.log('  argv recorded: ' + args.length + ' tokens'),
    onProgress: (p) => {
      if (p.pct - last >= 20) { last = p.pct;
        console.log('    ' + p.pct.toFixed(0) + '%  ' + p.speed_x.toFixed(2) + 'x  eta ' +
                    (p.eta_s === null ? '-' : p.eta_s.toFixed(0) + 's')); }
    }
  });
  console.log('  wall ' + res.wall_s.toFixed(1) + 's   speed ' + res.speed_x.toFixed(2) +
              'x   progress updates ' + res.updates + '   peak ' + res.peak_pct.toFixed(1) + '%');

  console.log('');
  console.log('── 7. VERIFY BY PROBING THE OUTPUTS ──');
  let bad = 0;
  for (const o of res.outputs) {
    const oi = await probe(o.final);
    const sz = fs.statSync(o.final).size;
    const mbps = (sz * 8) / oi.duration_s / 1e6;
    const okH = oi.height === o.height;
    const okA = oi.has_audio;
    const okD = Math.abs(oi.duration_s - sInfo.duration_s) < 0.5;
    if (!(okH && okA && okD)) bad++;
    console.log('  ' + (okH && okA && okD ? 'ok  ' : 'FAIL') + '  ' +
                String(o.height).padStart(4) + 'p  ' + oi.width + 'x' + oi.height +
                '  ' + mb(sz).padStart(9) + '  ' + mbps.toFixed(2) + ' Mbps  ' +
                'audio:' + (okA ? 'y' : 'N') + '  dur:' + (okD ? 'y' : 'N'));
  }

  console.log('');
  console.log('── 8. CLEAN ──');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log('  scratch removed: ' + (fs.existsSync(SCRATCH) ? 'NO' : 'yes'));
  console.log('');
  console.log('  RESULT: ' + ((bad === 0 && res.updates > 0) ? 'PASS' : 'FAIL'));
  process.exit((bad === 0 && res.updates > 0) ? 0 : 1);
})().catch(e => { console.error('FAILED: ' + pc.redact(e.message)); process.exit(1); });
