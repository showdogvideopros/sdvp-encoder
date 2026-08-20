'use strict';
// PRUNE CONTACT SHEETS.
//
// Sheets are ~680 KB each, two per movie, and nothing ever removed them. At
// ~700 films a year that is roughly a gigabyte annually.
//
// THE RULE: keep every sheet belonging to the newest N runs. Delete only
// sheets the record EXPLICITLY assigns to an older run.
//
// ⛔ A FILE THE RECORD DOES NOT NAME IS NEVER DELETED. [MEASURED 2026-08-20]
// two sheets on disk belong to a movie that FAILED before its sheet names were
// recorded, and two names in the record point at files already gone. The record
// and the folder can drift. "Delete anything not in the record" would have
// removed files whose provenance nobody understood - the wrong direction for a
// rule that cannot be undone. Orphans cost a little space; that is the cheaper
// error.
//
// Pruning by RUN rather than by age or count means a run's report either keeps
// all its thumbnails or loses all of them, never a confusing partial set.
//
// Usage:  node tools/prune-sheets.js [--keep N] [--apply]
//         Without --apply it only reports. Nothing is deleted.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = '/var/lib/sdvp-encoder/record.db';
const DIR = '/var/lib/sdvp-encoder/sheets';

const args = process.argv.slice(2);
const apply = args.indexOf('--apply') !== -1;
let keepRuns = 30;
const ki = args.indexOf('--keep');
if (ki !== -1 && args[ki + 1]) keepRuns = Math.max(1, Number(args[ki + 1]) || 30);

const db = new DatabaseSync(DB, { readOnly: true });
const runs = db.prepare('SELECT run_id, run_number FROM runs ORDER BY run_number DESC').all();
const recent = new Set(runs.slice(0, keepRuns).map(r => r.run_id));
const oldest = runs.slice(0, keepRuns).map(r => r.run_number).pop();

const rows = db.prepare(
  'SELECT m.run_id, q.sheet_h264, q.sheet_hevc ' +
  'FROM quality q JOIN movies m ON m.item_id = q.item_id').all();

const keep = new Set(), known = new Set();
for (const r of rows) {
  for (const n of [r.sheet_h264, r.sheet_hevc]) {
    if (!n) continue;
    known.add(n);
    if (recent.has(r.run_id)) keep.add(n);
  }
}

const onDisk = fs.readdirSync(DIR).filter(f => /\.jpg$/i.test(f));
const doomed = onDisk.filter(f => known.has(f) && !keep.has(f));
const orphans = onDisk.filter(f => !known.has(f));

const bytes = f => { try { return fs.statSync(path.join(DIR, f)).size; } catch (e) { return 0; } };
const mb = n => (n / 1e6).toFixed(1) + ' MB';

console.log('runs in record ......... ' + runs.length);
console.log('keeping the newest ..... ' + keepRuns + (oldest ? '  (back to run ' + oldest + ')' : ''));
console.log('sheets on disk ......... ' + onDisk.length + '   ' + mb(onDisk.reduce((n, f) => n + bytes(f), 0)));
console.log('keeping ................ ' + keep.size);
console.log('to delete .............. ' + doomed.length + '   ' + mb(doomed.reduce((n, f) => n + bytes(f), 0)));
console.log('orphans, NOT touched ... ' + orphans.length + '   ' + mb(orphans.reduce((n, f) => n + bytes(f), 0)));

if (!doomed.length) { console.log('\nnothing to prune.'); process.exit(0); }
if (!apply) {
  console.log('\nwould delete:');
  doomed.forEach(f => console.log('   ' + f));
  console.log('\nreport only. run again with --apply to delete.');
  process.exit(0);
}
let n = 0, freed = 0;
for (const f of doomed) {
  const b = bytes(f);
  try { fs.unlinkSync(path.join(DIR, f)); n++; freed += b; }
  catch (e) { console.error('could not delete ' + f + ': ' + e.message); }
}
console.log('\ndeleted ' + n + ' sheet(s), freed ' + mb(freed));
