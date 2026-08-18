'use strict';
// READ-ONLY. Lists, stats, checksums, and pulls the first 8 MB of one file.
// Creates nothing, uploads nothing.
const pc = require('/root/build/lib/pcloud.js');
const fs = require('fs');

const SHOW = '/2026 SDVP PRODUCTION MOVIES/BMDCA2026 BERNESE MOUNTAIN DOG NATIONAL';
const SHAKEDOWN = 89850766198;   // BMDCA2026-JMD-SAKS-251.mp4
const BOGUS = 1;                 // known-negative
const TMP = '/var/lib/sdvp-encoder/scratch/_selftest.part';

(async () => {
  console.log('── pCLOUD CLIENT SELF-TEST ──');
  console.log('  host        %s', pc.HOST);
  console.log('  token       %s', process.env.PCLOUD_AUTH_TOKEN ? 'present' : 'MISSING');

  const c = await pc.listFolder(SHOW);
  const files = c.filter(x => !x.isfolder), dirs = c.filter(x => x.isfolder);
  console.log('  listFolder  %d files, %d subfolders', files.length, dirs.length);
  console.log('  encodes/    %s', dirs.some(d => d.name === 'encodes') ? 'EXISTS ⚠' : 'absent');

  const s = await pc.stat(SHAKEDOWN);
  console.log('  stat        ' + s.name + '  ' + (s.size/1e9).toFixed(2) + ' GB');

  const k = await pc.checksum(SHAKEDOWN);
  console.log('  checksum    sha1=%s  md5=%s', k.sha1 ? 'yes' : 'NO', k.md5 ? 'yes' : 'NO');

  console.log('');
  console.log('  ── known-negative: bogus fileid must REFUSE ──');
  try { await pc.stat(BOGUS); console.log('    ⛔ RESOLVED — error path is blind'); }
  catch (e) { console.log('    refused: %s', e.message); }

  console.log('');
  console.log('  ── partial download, first 8 MB ──');
  const t0 = Date.now();
  const d = await pc.download(SHAKEDOWN, TMP, null, 8 * 1024 * 1024);
  const secs = (Date.now() - t0) / 1000;
  const onDisk = fs.statSync(TMP).size;
  console.log('    got ' + d.bytes + ' bytes in ' + secs.toFixed(2) + 's  (' + ((d.bytes*8)/secs/1e6).toFixed(0) + ' Mbps)');
  console.log('    on disk %d bytes   match: %s', onDisk, onDisk === d.bytes ? 'YES' : 'NO');
  fs.unlinkSync(TMP);
  console.log('    scratch cleaned');
})().catch(e => { console.error('FAILED: ' + pc.redact(e.message)); process.exit(1); });
