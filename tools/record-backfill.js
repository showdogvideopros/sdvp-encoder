'use strict';
// BACKFILL — load the queue file's history into the record.
// Idempotent: every write is an upsert keyed on natural identifiers, so running
// it twice changes nothing. Reads state.json only; writes only to record.db.

const fs = require('fs');
const R = require('../lib/record.js');
const V = require('../lib/verifier.js');

const STATE = process.env.SDVP_STATE || '/var/lib/sdvp-encoder/state.json';
const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));

function loadPreset(name) {
  try { return JSON.parse(fs.readFileSync(__dirname + '/../presets/' + name + '.json', 'utf8')); }
  catch (e) { return null; }
}

let nRuns = 0, nMovies = 0, nRungs = 0, nDeliv = 0, nQual = 0;

for (const run of (s.runs || [])) {
  R.upsertRun(run, {});
  nRuns++;
  for (const item of (run.items || [])) {
    R.upsertMovie(run.run_id, item);
    nMovies++;

    for (const out of (item.outputs || [])) {
      const ps = loadPreset(out.preset_name);
      out._encoder = ps ? ps.encoder : null;
      out._encoder_preset = ps ? ps.preset : null;
      for (const r of (out.rungs || [])) {
        const spec = ps ? ps.rungs.find(x => Number(x.height) === Number(r.height)) : null;
        const band = V.bandFor(spec);
        const cap = band ? band[1] / 1.25 : null;
        const rungId = R.upsertRung(item.item_id, out, r, spec, cap);
        nRungs++;

        // Destinations were not recorded before today. Infer honestly from the
        // evidence present: a pCloud fileid means it went to pCloud, a Vimeo uri
        // means Vimeo. Nothing is invented where no evidence exists.
        if (r.stored_fileid) {
          R.upsertDelivery(rungId, 'pcloud', {
            ok: r.state === 'STORED', pcloud_fileid: r.stored_fileid,
            sha1_verified: r.checksum_match, upload_s: r.upload_s,
            upload_mbps: r.upload_mbps, error: r.reason || null
          });
          nDeliv++;
        }
        if (r.vimeo_uri) {
          R.upsertDelivery(rungId, 'vimeo', {
            ok: r.state === 'STORED', vimeo_uri: r.vimeo_uri, vimeo_link: r.vimeo_link,
            witness_state: r.vimeo_witness || null, upload_s: r.vimeo_s,
            upload_mbps: r.vimeo_mbps, attempts: r.vimeo_attempts,
            error: r.reason || null
          });
          nDeliv++;
        }
      }
    }

    if (item.quality) { R.upsertQuality(item.item_id, item.quality); nQual++; }
  }
}

console.log('  runs ' + nRuns + '   movies ' + nMovies + '   rungs ' + nRungs +
            '   deliveries ' + nDeliv + '   quality ' + nQual);
R.close();
