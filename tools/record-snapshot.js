'use strict';
// RECORD SNAPSHOT — checkpoint, copy, upload, then VERIFY BY OPENING IT.
//
// Each snapshot is a COMPLETE copy of the whole record, not a fragment of one
// run. The newest file holds every run there has ever been; older ones exist
// only so a lost or corrupted copy does not take the history with it. Nothing
// has to be searched across files, and any pruning rule works.
//
// WHY CHECKPOINT FIRST: write-ahead journalling keeps recent pages in a sidecar
// until they are folded in. A copy taken without it is missing its newest
// contents AND uploads successfully, checksum and all. That is exactly the
// "uploaded means our socket drained" failure in a new costume.
//
// WHY OPEN THE COPY: a checksum proves the bytes we sent are the bytes stored.
// It cannot prove those bytes are a usable database. Only opening it does.

const fs = require('fs');
const path = require('path');
const pc = require('../lib/pcloud.js');
const R = require('../lib/record.js');
const { DatabaseSync } = require('node:sqlite');

const DEST = process.env.SDVP_RECORD_DEST || '/SDVP ENCODER RECORD';
const SRC = R.DB_PATH;

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

(async () => {
  const label = process.argv[2] || 'manual';

  // 1 - fold the journal into the file itself
  const db = R.db();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  R.close();
  const bytes = fs.statSync(SRC).size;
  console.log('  checkpointed : ' + bytes + ' bytes');
  if (bytes === 0) throw new Error('record is 0 bytes after checkpoint - refusing to upload');

  // 2 - a named, write-once copy
  const name = 'sdvp-encoder-record_' + stamp() + '_' + label + '.db';
  const staged = path.join('/tmp', name);
  fs.copyFileSync(SRC, staged);

  // 3 - open the STAGED copy and count. If it will not open, stop here.
  const check = new DatabaseSync(staged);
  const counts = {};
  for (const t of ['runs', 'movies', 'rungs', 'deliveries', 'quality']) {
    counts[t] = check.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
  }
  check.close();
  console.log('  local copy   : ' + JSON.stringify(counts));

  // 4 - upload with the same outside witness every other file gets
  await pc.createFolderIfNotExists(DEST);
  const localSha = await pc.sha1File(staged);
  const up = await pc.withRetry('record', () => pc.upload(staged, DEST, null), n => console.log('    ' + n));
  const remote = await pc.checksum(up.fileid);
  const match = remote.sha1 === localSha;
  console.log('  uploaded     : fileid ' + up.fileid + '   sha1_verified ' + match);
  if (!match) throw new Error('checksum mismatch - snapshot is NOT trustworthy');

  // 5 - VERIFY AT THE POINT OF CONSUMPTION. Pull it back down and open it.
  const back = path.join('/tmp', 'verify_' + name);
  await pc.download(up.fileid, back, null, null);
  const v = new DatabaseSync(back);
  const vCounts = {};
  for (const t of ['runs', 'movies', 'rungs', 'deliveries', 'quality']) {
    vCounts[t] = v.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
  }
  v.close();
  console.log('  round-tripped: ' + JSON.stringify(vCounts));

  const same = Object.keys(counts).every(k => counts[k] === vCounts[k]);
  console.log('  counts agree : ' + same);
  fs.unlinkSync(staged);
  fs.unlinkSync(back);
  if (!same) throw new Error('round-tripped copy does not match - snapshot is NOT trustworthy');

  console.log('');
  console.log('  SNAPSHOT GOOD: ' + DEST + '/' + name);
})().catch(e => { console.error('  SNAPSHOT FAILED: ' + e.message); process.exit(1); });
