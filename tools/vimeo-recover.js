'use strict';
// RECOVER VIMEO SOURCES TO pCLOUD.
//
// Run 48 encoded GRCA2025's HEVC rung to Vimeo ONLY - a profile mistake. The
// files are correct and they are at Vimeo; they are simply not at pCloud, and
// the portal's picker serves pCloud-destination rungs only.
//
// Vimeo returns the ORIGINAL uploaded file under quality 'source', so this is a
// copy, never a re-encode. Both legs run at datacentre speed.
//
// ⛔ Needs a token carrying the video_files scope. The encoder's own token does
// not have it, by design. Set VIMEO_DOWNLOAD_TOKEN in the environment file; it
// is used for THIS PROCESS ONLY and the daemon is untouched.
//
// Usage:  node tools/vimeo-recover.js <run_number> [--go]
//         without --go it reports what it WOULD do and writes nothing.
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('/root/build/lib/env.js');
loadEnv({ quiet: true });
if (!process.env.VIMEO_DOWNLOAD_TOKEN) {
  console.log('VIMEO_DOWNLOAD_TOKEN is not set - nothing to do'); process.exit(1);
}
process.env.VIMEO_ACCESS_TOKEN = process.env.VIMEO_DOWNLOAD_TOKEN;
const VM = require('/root/build/lib/vimeo.js');
const pc = require('/root/build/lib/pcloud.js');
const R = require('/root/build/lib/record.js');
const P = require('/root/build/lib/planner.js');
const SCRATCH = '/var/lib/sdvp-encoder/scratch/_recover';

// Ask Vimeo for the ORIGINAL file. quality 'source' is what we uploaded; every
// other entry is one of THEIR transcodes and would be a different file under
// our filename. If there is no source entry we refuse rather than substitute.
function sourceLink(videoId) {
  return VM.api('GET', '/videos/' + videoId + '?fields=download').then(r => {
    const list = (r.body || {}).download || [];
    const src = list.find(x => x.quality === 'source');
    if (!src) return null;
    return { link: src.link, size: src.size || null };
  });
}

// Follow redirects, stream to disk, report bytes. No link is ever logged.
function fetchToFile(url, dest) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const go = (u, depth) => {
      if (depth > 5) return reject(new Error('too many redirects'));
      https.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return go(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(fs.statSync(dest).size)));
        f.on('error', e => reject(new Error('write failed: ' + e.code)));
      }).on('error', e => reject(new Error('fetch failed: ' + e.code)));
    };
    go(url, 0);
  });
}

const runNum = Number(process.argv[2]);
const GO = process.argv.indexOf('--go') !== -1;
if (!runNum) { console.log('usage: node tools/vimeo-recover.js <run_number> [--go]'); process.exit(1); }
const run = R.query('SELECT * FROM runs WHERE run_number = ?', [runNum])[0];
if (!run) { console.log('no run ' + runNum); process.exit(1); }

// Every rung this run delivered to Vimeo and NOT to pCloud.
const work = R.query(`
  SELECT r.rung_id, r.codec, r.height, r.bytes, m.source_name, m.dest_path,
         dv.vimeo_uri, dp.pcloud_fileid
  FROM rungs r
  JOIN movies m ON m.item_id = r.item_id
  JOIN deliveries dv ON dv.rung_id = r.rung_id AND dv.destination = 'vimeo'
  LEFT JOIN deliveries dp ON dp.rung_id = r.rung_id AND dp.destination = 'pcloud'
  WHERE m.run_id = ? AND r.state = 'STORED' AND dp.rung_id IS NULL
  ORDER BY m.source_name`, [run.run_id]);

console.log('');
console.log('  RUN ' + runNum + '  ' + String(run.job_label).slice(0, 50));
console.log('  rungs at Vimeo with no pCloud delivery: ' + work.length);
console.log('  destination: ' + (work[0] ? work[0].dest_path : '-'));
const totalB = work.reduce((a, w) => a + (w.bytes || 0), 0);
console.log('  to copy: ' + (totalB / 1073741824).toFixed(1) + ' GB');
if (!GO) {
  console.log('');
  console.log('  DRY RUN - nothing fetched, nothing uploaded, nothing written.');
  work.forEach(w => console.log('   ' + (w.bytes/1073741824).toFixed(2).padStart(6) + ' GB  ' +
    String(w.vimeo_uri).padEnd(20) + P.outputName(w.source_name, w.height, w.codec)));
  console.log('');
  console.log('  add --go to perform the copy');
  process.exit(0);
}

fs.mkdirSync(SCRATCH, { recursive: true });
(async () => {
  let ok = 0, skipped = 0, failed = 0, moved = 0;
  // ONE LISTING, not one per film.
  let present = [];
  try { present = (await pc.listFolder(work[0].dest_path)).filter(x => !x.isfolder).map(x => x.name); }
  catch (e) { console.log('  cannot list the destination - stopping'); process.exit(1); }

  for (const w of work) {
    const name = P.outputName(w.source_name, w.height, w.codec);
    const label = name.slice(0, 46);
    if (present.indexOf(name) !== -1) { console.log('  skip  already at pCloud   ' + label); skipped++; continue; }
    const tmp = path.join(SCRATCH, name);
    const vid = String(w.vimeo_uri).split('/').pop();
    try {
      const src = await sourceLink(vid);
      if (!src) throw new Error('no source rendition offered - refusing to substitute a transcode');
      const got = await fetchToFile(src.link, tmp);
      // ⛔ THE CONTROL. The record says how many bytes we uploaded. A different
      // number means this is not our file, and we stop rather than publish it.
      if (w.bytes && got !== w.bytes)
        throw new Error('byte mismatch: got ' + got + ', record says ' + w.bytes);
      const sha = await pc.sha1File(tmp);
      const up = await pc.withRetry('recover ' + label, () => pc.upload(tmp, w.dest_path, null), () => {});
      const k = await pc.checksum(up.fileid);
      const verified = (k.sha1 === sha);
      R.upsertDelivery(w.rung_id, 'pcloud', {
        ok: true, pcloud_fileid: up.fileid, sha1_verified: verified,
        attempts: 1, error: verified ? null : 'sha1 mismatch after upload'
      });
      console.log('  ok    ' + (got/1073741824).toFixed(2) + ' GB  sha1=' + verified + '  ' + label);
      moved += got; ok++;
    } catch (e) {
      console.log('  FAIL  ' + label + '  — ' + String(e.message).slice(0, 70));
      failed++;
    }
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  console.log('');
  console.log('  copied ' + ok + '   skipped ' + skipped + '   failed ' + failed +
    '   ' + (moved/1073741824).toFixed(1) + ' GB moved');
  if (failed) console.log('  ⛔ re-run to retry the failures - completed films are skipped');
})();
