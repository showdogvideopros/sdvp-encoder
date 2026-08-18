'use strict';
// Fabricated cases with stated expectations. Harness must be able to go RED.
const P = require('/root/build/lib/planner.js');

const H264_1080 = { height: 1080, video_codec: 'h264' };
const H264_720  = { height: 720,  video_codec: 'h264' };
const FIVE = [1080, 720, 540, 480, 360, 240];

function plannedHeights(res) {
  return res.rungs.filter(r => r.state === 'PLANNED').map(r => r.height).join(',');
}

const cases = [
  ['1080 h264 master, h264 ladder', H264_1080, { codec:'h264', rungs:FIVE }, '720,540,480,360,240'],
  ['1080 h264 master, hevc ladder', H264_1080, { codec:'hevc', rungs:FIVE }, '1080,720,540,480,360,240'],
  ['720 legacy master, h264',       H264_720,  { codec:'h264', rungs:FIVE }, '540,480,360,240'],
  ['720 legacy master, hevc',       H264_720,  { codec:'hevc', rungs:FIVE }, '720,540,480,360,240'],
  ['rung above source only',        H264_720,  { codec:'h264', rungs:[1080] }, ''],
  ['single low rung',               H264_1080, { codec:'h264', rungs:[360] }, '360'],
  ['empty rung list',               H264_1080, { codec:'h264', rungs:[] }, ''],
  ['unsorted input sorts desc',     H264_1080, { codec:'h264', rungs:[360,720,240] }, '720,360,240'],
  ['duplicate rung dropped once',   H264_1080, { codec:'h264', rungs:[720,720,480] }, '720,480'],
  ['flushing spaniel: 720 + 360',   H264_1080, { codec:'h264', rungs:[720,360] }, '720,360'],
  ['fall: hevc 1080 only',          H264_1080, { codec:'hevc', rungs:[1080] }, '1080'],
];

function run(label, cases) {
  let pass = 0, fail = 0;
  console.log('── ' + label + ' ──');
  for (const [name, src, out, expect] of cases) {
    const got = plannedHeights(P.planRungs(src, out));
    const ok = got === expect;
    if (ok) pass++; else fail++;
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(32) +
                '  got[' + got + ']' + (ok ? '' : '  want[' + expect + ']'));
  }
  console.log('  ' + pass + ' pass, ' + fail + ' fail');
  return fail;
}

// KNOWN-POSITIVE: one case wired to a deliberately wrong expectation.
const inverted = [['INVERTED control (must FAIL)', H264_1080,
                   { codec:'h264', rungs:FIVE }, '1080,720,540,480,360,240']];
const invFail = run('HARNESS POWER CHECK', inverted);
console.log('  harness can go RED: ' + (invFail === 1 ? 'YES' : 'NO  ← HARNESS IS BLIND'));
console.log('');

const realFail = run('PLANNER CASES', cases);
console.log('');
console.log('  naming: ' + P.outputName('BEST OF BREED DOG GROUPS BMDCA2026.mp4', 720, 'h264'));
console.log('  naming: ' + P.outputName('BEST OF BREED DOG GROUPS BMDCA2026.mp4', 1080, 'hevc'));
console.log('');
console.log('  RESULT: ' + ((invFail === 1 && realFail === 0) ? 'PASS' : 'FAIL'));
process.exit((invFail === 1 && realFail === 0) ? 0 : 1);
