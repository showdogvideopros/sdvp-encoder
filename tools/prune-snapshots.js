
'use strict';
// PRUNE RECORD SNAPSHOTS AT pCLOUD.
//
// A snapshot is written at the END OF EVERY RUN and nothing ever removed them.
// [MEASURED 2026-08-21] Dr. K counted ten from a single day. Across a backlog
// burn that is a file every few hours, forever, in a folder he must clean by
// hand.
//
// ⭐ WHY THIS IS SAFE WHERE SHEET PRUNING NEEDED CARE: every snapshot is a
// COMPLETE copy of the whole record, not a fragment of one run. The newest file
// contains everything every older file contains. Older ones exist only so a
// lost or corrupted copy does not take the history with it - so keeping thirty
// is generous rather than cautious. (Dr. K, 2026-08-21: "Each one necessarily
// holds the info from the entire antecedent list.")
//
// ⛔ A FILE WE DID NOT WRITE IS NEVER TOUCHED. Only names matching the
// snapshot tool's own pattern are considered. Anything else in that folder
// belongs to someone else and is left alone - the same rule as prune-sheets,
// for the same reason: a rule that cannot be undone errs toward keeping.
//
// ⛔ AND IT REFUSES RATHER THAN GUESSES. An empty or unreadable listing is what
// a network failure looks like as well as what an empty folder looks like, and
// the two must not be confused. The newest snapshot is never deleted under any
// circumstance.
//
// Usage:  node tools/prune-snapshots.js [--keep N] [--apply]
//         Without --apply it only reports. Nothing is deleted.

require('../lib/env.js').loadEnv();
const pc = require('../lib/pcloud.js');

const DEST = process.env.SDVP_RECORD_DEST || '/SDVP ENCODER RECORD';
const args = process.argv.slice(2);
const apply = args.indexOf('--apply') !== -1;
let keep = 30;
const ki = args.indexOf('--keep');
if (ki !== -1 && args[ki + 1]) keep = Math.max(1, Number(args[ki + 1]) || 30);

// The name the snapshot tool writes:
//   sdvp-encoder-record_YYYYMMDD-HHMMSS_label.db
const PATTERN = /^sdvp-encoder-record_\d{8}-\d{6}_.*\.db$/;

(async () => {
  console.log('folder : ' + DEST);
  console.log('keeping: newest ' + keep);
  console.log('mode   : ' + (apply ? 'APPLY - files will be deleted' : 'report only'));
  console.log('');

  let entries;
  try {
    entries = await pc.listFolder(DEST);
  } catch (e) {
    console.error('REFUSING: could not read the folder - ' + pc.redact(String(e.message)));
    process.exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error('REFUSING: the listing was not readable');
    process.exit(1);
  }

  const files = entries.filter(e => !e.isfolder);
  const mine = files.filter(e => PATTERN.test(e.name));
  const others = files.filter(e => !PATTERN.test(e.name));

  console.log('files in the folder    : ' + files.length);
  console.log('snapshots (ours)       : ' + mine.length);
  console.log('other files, untouched : ' + others.length);
  if (others.length) {
    for (const o of others) console.log('    left alone: ' + o.name);
  }
  console.log('');

  if (!mine.length) {
    console.log('No snapshots found. Nothing to do.');
    console.log('(If that is a surprise, it is a reason to look, not to act.)');
    return;
  }

  // Sort by the timestamp IN THE NAME, not by a modified date the vendor
  // reports - the name is what we wrote and cannot drift.
  mine.sort((a, b) => b.name.localeCompare(a.name));

  const keepers = mine.slice(0, keep);
  const doomed = mine.slice(keep);

  console.log('newest : ' + keepers[0].name);
  console.log('oldest kept : ' + keepers[keepers.length - 1].name);
  console.log('');

  if (!doomed.length) {
    console.log('Nothing to prune - ' + mine.length + ' snapshot(s), keeping ' + keep + '.');
    return;
  }

  let bytes = 0;
  for (const d of doomed) bytes += Number(d.size || 0);
  console.log(doomed.length + ' snapshot(s) older than the newest ' + keep +
              '  (' + (bytes / 1e6).toFixed(1) + ' MB)');
  for (const d of doomed) console.log('    ' + d.name);
  console.log('');

  if (!apply) {
    console.log('Report only. Re-run with --apply to delete them.');
    return;
  }

  // Never the newest, whatever the arithmetic said.
  const newest = mine[0].name;
  let gone = 0, failed = 0;
  for (const d of doomed) {
    if (d.name === newest) { console.error('  REFUSING to delete the newest snapshot'); continue; }
    try {
      await pc.deleteSnapshot(d.fileid, d.name);
      console.log('  deleted ' + d.name);
      gone++;
    } catch (e) {
      console.error('  FAILED  ' + d.name + ' - ' + pc.redact(String(e.message)).slice(0, 120));
      failed++;
    }
  }
  console.log('');
  console.log('deleted ' + gone + ', failed ' + failed + ', kept ' + keepers.length);

  // VERIFY AT THE POINT OF CONSUMPTION: read the folder back.
  const after = (await pc.listFolder(DEST)).filter(e => !e.isfolder && PATTERN.test(e.name));
  console.log('folder now holds ' + after.length + ' snapshot(s)');
})().catch(e => { console.error('FAILED: ' + String(e.message)); process.exit(1); });
