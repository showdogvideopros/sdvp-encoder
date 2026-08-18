'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pc = require('/root/build/lib/pcloud.js');
const { probe } = require('/root/build/lib/probe.js');
const P = require('/root/build/lib/planner.js');
const E = require('/root/build/lib/encoder.js');
const V = require('/root/build/lib/verifier.js');

const FILEID = 89850766198;
const DEST = '/Miscellaneous/_ENCODER_TEST/encodes';
const SCRATCH = '/var/lib/sdvp-encoder/scratch/_uptest';
const SLICE_S = 90;
const preset = JSON.parse(fs.readFileSync('/root/build/presets/h264-standard.json', 'utf8'));

function sh(bin, args) {
  return new Promise((res, rej) => execFile(bin, args, { maxBuffer: 8e6 },
    (e, so, se) => e ? rej(new Error((se || e.message).trim())) : res(so)));
}
const mb = n => (n / 1e6).toFixed(1) + ' MB';

(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const src = path.join(SCRATCH, 'source.mp4');
  const outDir = path.join(SCRATCH, 'out'); fs.mkdirSync(outDir, { recursive: true });

  console.log('── 1. PULL + SLICE + ENCODE ──');
  const d = await pc.download(FILEID, src, null, null);
  const info = await probe(src);
  const slice = path.join(SCRATCH, 'slice.mp4');
  await sh(E.FFMPEG, ['-hide_banner','-loglevel','error','-y','-i',src,
                      '-t',String(SLICE_S),'-c','copy','-movflags','+faststart',slice]);
  const sInfo = await probe(slice);
  const plan = P.planRungs(sInfo, { codec:'h264', rungs:[1080,720,540,480,360,240] });
  const planned = plan.rungs.filter(r => r.state === 'PLANNED');
  const enc = await E.runEncode({ src: slice, plannedRungs: planned, preset,
    outDir, srcName: d.name, durationS: sInfo.duration_s });
  console.log('  ' + enc.outputs.length + ' rungs in ' + enc.wall_s.toFixed(1) +
              's at ' + enc.speed_x.toFixed(2) + 'x');

  console.log('');
  console.log('── 2. VERIFY ──');
  for (const o of enc.outputs) {
    const v = await V.verifyRung(o.final, o.height, sInfo.duration_s);
    console.log('  ' + (v.ok ? 'ok  ' : 'FAIL') + '  ' + String(o.height).padStart(4) +
                'p  ' + mb(v.bytes).padStart(9) + '  ' + v.mbps.toFixed(2) + ' Mbps' +
                (v.ok ? '' : '  failed: ' + V.failedNames(v)));
    if (!v.ok) { console.error('  ABORTING - a rung failed verification'); process.exit(1); }
  }

  console.log('');
  console.log('── 3. KNOWN-POSITIVE: truncated file must be REJECTED ──');
  const good = enc.outputs[enc.outputs.length - 1].final;
  const bad = path.join(SCRATCH, 'truncated.mp4');
  const whole = fs.readFileSync(good);
  fs.writeFileSync(bad, whole.slice(0, Math.floor(whole.length * 0.4)));
  const bv = await V.verifyRung(bad, 240, sInfo.duration_s);
  console.log('  verdict: ' + (bv.ok ? 'PASSED  <- VERIFIER IS BLIND' : 'rejected'));
  console.log('  failed checks: ' + (V.failedNames(bv) || '(none)'));
  if (bv.ok) { console.error('  ABORTING - verifier cannot detect a truncated file'); process.exit(1); }

  console.log('');
  console.log('── 4. CREATE TEST FOLDER ──');
  const cf = await pc.createFolderIfNotExists(DEST);
  console.log('  ' + DEST + '   folderid=' + cf.folderid + '   created=' + cf.created);

  console.log('');
  console.log('── 5. UPLOAD + CHECKSUM ──');
  let totalBytes = 0, totalSecs = 0, bad2 = 0;
  const stored = [];
  for (const o of enc.outputs) {
    const localSha = await pc.sha1File(o.final);
    const t = Date.now();
    const up = await pc.withRetry('upload ' + o.height, () => pc.upload(o.final, DEST, null),
                                  n => console.log('    ' + n));
    const secs = (Date.now() - t) / 1000;
    const rk = await pc.checksum(up.fileid);
    const match = rk.sha1 === localSha;
    if (!match) bad2++;
    totalBytes += up.size; totalSecs += secs;
    stored.push({ h: o.height, size: up.size });
    console.log('  ' + (match ? 'ok  ' : 'FAIL') + '  ' + String(o.height).padStart(4) +
                'p  ' + mb(up.size).padStart(9) + '  ' + secs.toFixed(1) + 's  (' +
                ((up.size * 8) / secs / 1e6).toFixed(0) + ' Mbps)  sha1:' +
                (match ? 'match' : 'MISMATCH'));
  }
  console.log('  total ' + mb(totalBytes) + ' in ' + totalSecs.toFixed(1) + 's  = ' +
              ((totalBytes * 8) / totalSecs / 1e6).toFixed(0) + ' Mbps aggregate');

  console.log('');
  console.log('── 6. RE-LIST FROM OUTSIDE ──');
  const listed = await pc.listFolder(DEST);
  const files = listed.filter(x => !x.isfolder);
  console.log('  ' + files.length + ' files in ' + DEST);
  for (const f of files.sort((a,b) => b.size - a.size)) {
    console.log('    ' + mb(f.size).padStart(9) + '  ' + f.name);
  }

  console.log('');
  console.log('── 7. CLEAN LOCAL SCRATCH ──');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log('  removed: ' + (fs.existsSync(SCRATCH) ? 'NO' : 'yes'));
  console.log('  (remote test files left in place deliberately)');

  console.log('');
  const ok = (bad2 === 0 && files.length === enc.outputs.length);
  console.log('  RESULT: ' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAILED: ' + pc.redact(e.message)); process.exit(1); });
