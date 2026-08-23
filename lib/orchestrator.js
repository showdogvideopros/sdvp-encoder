'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pc = require('./pcloud.js');
const { probe } = require('./probe.js');
const P = require('./planner.js');
const E = require('./encoder.js');
const V = require('./verifier.js');
const Q = require('./quality.js');
const VM = require('./vimeo.js');
const R = require('./record.js');

// Which destinations does THIS rung owe? Override beats the output default.
// Module level because BOTH the plan (existence) and the upload (routing) need
// the same answer, and two copies of this rule would eventually disagree.
function destinationsFor(out, height) {
  const ov = out.destination_overrides;
  if (ov && ov[String(height)]) return [].concat(ov[String(height)]);
  if (Array.isArray(out.destinations) && out.destinations.length) {
    return out.destinations.slice();
  }
  return ['pcloud'];
}

const PRESET_DIR = '/root/build/presets';
const FFMPEG_VERSION = (function () {
  try {
    const out = require('child_process')
      .execFileSync('/usr/local/bin/ffmpeg', ['-version'], { encoding: 'utf8' });
    const m = out.match(/ffmpeg version (\S+)/);
    return m ? m[1] : 'unknown';
  } catch (e) { return 'unknown'; }
})();
const SCRATCH_ROOT = '/var/lib/sdvp-encoder/scratch';
// Sheets are written into scratch, which is DELETED on success - minutes after
// the card turns green, which is exactly when Dr. K wants to look at one. They
// are kept here so the status page can serve them for the life of the box.
// A few hundred KB per movie; gone at teardown with everything else.
const SHEET_ROOT = '/var/lib/sdvp-encoder/sheets';
const STATE_PATH = '/var/lib/sdvp-encoder/state.json';

// Movie + run. Shared with the rebuild tool so both produce the same name.
// Write this item into the record. Wrapped whole: the record is memory, not
// the job. A failure to write history must never fail an encode that succeeded,
// so it is logged and the run carries on.
function recordItem(runNumber, item) {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const run = (st.runs || []).find(function (x) {
      return Number(x.run_number) === Number(runNumber);
    });
    if (!run || !run.run_id) {
      console.error('record write skipped: no run ' + runNumber + ' in state');
      return;
    }
    R.upsertRun(run, { box_host: require('os').hostname(),
                       ffmpeg_version: FFMPEG_VERSION });
    R.upsertMovie(run.run_id, item);
    for (const out of (item.outputs || [])) {
      let ps = null;
      try { ps = loadPreset(out.preset_name); } catch (e) { ps = null; }
      out._encoder = ps ? ps.encoder : null;
      out._encoder_preset = ps ? ps.preset : null;
      for (const r of (out.rungs || [])) {
        const spec = ps ? ps.rungs.find(x => Number(x.height) === Number(r.height)) : null;
        const band = V.bandFor(spec);
        const cap = band ? band[1] / 1.25 : null;
        const rungId = R.upsertRung(item.item_id, out, r, spec, cap);
        for (const d of (r.destinations || [])) {
          if (d === 'pcloud' && r.stored_fileid) {
            R.upsertDelivery(rungId, 'pcloud', {
              ok: r.state === 'STORED', pcloud_fileid: r.stored_fileid,
              sha1_verified: r.checksum_match, upload_s: r.upload_s,
              upload_mbps: r.upload_mbps, error: r.reason || null });
          } else if (d === 'vimeo' && r.vimeo_uri) {
            R.upsertDelivery(rungId, 'vimeo', {
              ok: r.state === 'STORED', vimeo_uri: r.vimeo_uri,
              vimeo_link: r.vimeo_link, witness_state: r.vimeo_witness || null,
              witness_drift_s: r.vimeo_drift_s, upload_s: r.vimeo_s,
              upload_mbps: r.vimeo_mbps, attempts: r.vimeo_attempts,
              error: r.reason || null });
          }
        }
      }
    }
    if (item.quality) R.upsertQuality(item.item_id, item.quality);
  } catch (e) {
    console.error('record write failed (run continues): ' + String(e.message).slice(0, 200));
  }
}

// END-OF-RUN WITNESS SWEEP. The per-item check runs about 2 s after upload,
// which is usually too early - Vimeo reports a duration once it has ingested
// the file, not instantly. PENDING IS NOT A PASS. Waiting there would idle the
// box, so the resolution happens here, where nothing else is queued and waiting
// is free.
// MEASURED 2026-08-19: a 127 MB file resolved inside 30 s; duration appears
// while transcode is still running, so this never waits on Vimeo's ladder.
async function sweepRunWitnesses(run, save) {
  const pending = [];
  for (const item of (run.items || [])) {
    for (const e of (item.vimeo || [])) {
      if (!e.witness || e.witness.state === 'PENDING') pending.push({ item: item, e: e });
    }
  }
  if (!pending.length) return { checked: 0, verified: 0, unresolved: 0 };

  const deadline = Date.now() + 900000;
  let verified = 0;
  for (;;) {
    let stillPending = 0;
    for (const p of pending) {
      if (p.e.witness && p.e.witness.state !== 'PENDING') continue;
      try {
        p.e.witness = await VM.checkWitnessOnce(p.e.uri, p.e.expected_duration_s);
      } catch (err) {
        p.e.witness = { state: 'PENDING', note: VM.redact(String(err.message)).slice(0, 120) };
      }
      if (p.e.witness.state === 'PENDING') stillPending++;
      else {
        if (p.e.witness.state === 'VERIFIED') verified++;
        // The rung carries the verdict too, so the manifest and the record agree.
        for (const out of (p.item.outputs || [])) {
          for (const r of (out.rungs || [])) {
            if (r.vimeo_uri === p.e.uri) {
              r.vimeo_witness = p.e.witness.state;
              r.vimeo_drift_s = p.e.witness.drift_s;
              if (p.e.witness.state === 'MISMATCH' || p.e.witness.state === 'FAILED') {
                r.state = 'FAILED';
                r.reason = 'vimeo witness ' + p.e.witness.state;
              }
            }
          }
        }
      }
    }
    save({ force: true });
    if (!stillPending || Date.now() >= deadline) {
      // Re-record so the store holds the resolved verdict, not the PENDING one.
      for (const item of (run.items || [])) {
        if ((item.vimeo || []).length) recordItem(run.run_number, item);
      }
      return { checked: pending.length, verified: verified, unresolved: stillPending };
    }
    await new Promise(function (r) { setTimeout(r, 15000); });
  }
}

// SNAPSHOT THE RECORD TO pCLOUD AT THE END OF EVERY RUN.
// Each snapshot is a COMPLETE copy of the whole record, so the newest file
// holds every run there has ever been and nothing is searched across files.
//
// CHECKPOINT FIRST: write-ahead journalling keeps recent pages in a sidecar
// until folded in. A copy taken without it is missing its newest contents and
// uploads perfectly, checksum and all.
// OPEN THE COPY: a checksum proves the bytes we sent are the bytes stored. It
// cannot prove those bytes are a usable database. Only opening it does.
// Wrapped whole - failing to archive history must never fail a good run.
async function snapshotRecord(runNumber) {
  const out = { ok: false };
  let staged = null;
  try {
    const dbh = R.db();
    dbh.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    R.close();
    const bytes = fs.statSync(R.DB_PATH).size;
    if (!bytes) throw new Error('record is 0 bytes after checkpoint');

    const st = new Date().toISOString().replace(/[-:]/g, '')
                 .replace(/\..+$/, '').replace('T', '-');
    const name = 'sdvp-encoder-record_' + st + '_r' + (runNumber || 0) + '.db';
    staged = path.join('/tmp', name);
    fs.copyFileSync(R.DB_PATH, staged);

    const { DatabaseSync } = require('node:sqlite');
    const chk = new DatabaseSync(staged);
    out.runs = chk.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
    out.movies = chk.prepare('SELECT COUNT(*) AS n FROM movies').get().n;
    out.rungs = chk.prepare('SELECT COUNT(*) AS n FROM rungs').get().n;
    chk.close();

    const dest = '/SDVP ENCODER RECORD';
    await pc.createFolderIfNotExists(dest);
    const sha = await pc.sha1File(staged);
    const up = await pc.withRetry('record snapshot',
      () => pc.upload(staged, dest, null), () => {});
    const remote = await pc.checksum(up.fileid);
    out.sha1_verified = (remote.sha1 === sha);
    out.fileid = up.fileid;
    out.name = name;
    out.bytes = bytes;
    out.ok = out.sha1_verified === true;
    if (!out.ok) out.error = 'checksum mismatch';
  } catch (e) {
    out.error = pc.redact(String(e.message)).slice(0, 200);
  }
  try { if (staged && fs.existsSync(staged)) fs.unlinkSync(staged); } catch (e) { /* nothing */ }
  return out;
}

// Seconds as h:mm:ss or m:ss - a person reads "3:40", not "220.4 s".
function fmtHMS(sec) {
  if (sec == null || !isFinite(sec)) return '-';
  const t = Math.round(Number(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s2 = t % 60;
  const pad = n => (n < 10 ? '0' + n : String(n));
  return h ? (h + ':' + pad(m) + ':' + pad(s2)) : (m + ':' + pad(s2));
}

function manifestName(srcName, runNumber) {
  const base = String(srcName).replace(/\.[^.]+$/, '');
  return '_sdvp_manifest_' + base + '_r' + (runNumber || 0) + '.json';
}

function loadPreset(name) {
  return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8'));
}
function nowIso() { return new Date().toISOString(); }
function id() { return crypto.randomBytes(6).toString('hex'); }

function buildRun(job, jobPath) {
  const run = {
    run_id: id(),
    job_label: job.job_label || path.basename(jobPath),
    job_file: jobPath,
    started_at: nowIso(),
    finished_at: null,
    status: 'RUNNING',
    items: []
  };
  for (const b of job.batches || []) {
    const dest = b.dest_path_override ||
                 (b.source_path + '/' + (job.dest_subfolder || 'encodes'));
    for (const it of b.items || []) {
      run.items.push({
        item_id: id(),
        batch: b.label || '(batch)',
        fileid: it.fileid,
        name: it.name || null,
        source_path: b.source_path,
        dest_path: dest,
        on_existing: job.on_existing || 'skip',
        outputs_requested: b.outputs || [],
        phase: 'QUEUED',
        // SEED THE SIZE FROM THE JOB. [MEASURED 2026-08-20, run 30] bytes was
        // written only when the daemon FETCHED a film, so fourteen queued films
        // read as zero work remaining and the run card's projection was hidden -
        // correctly, because it had no honest way to project. The panel writes
        // the size into every job it builds; this simply carries it across.
        // A hand-written job file with no size still reads null, and the run
        // card stays silent for it, which is the right behaviour.
        bytes: (it.bytes && it.bytes > 0) ? Number(it.bytes) : null,
        probe: null,
        outputs: [],
        progress: { pct: 0, speed_x: 0, eta_s: null },
        timings: {},
        error: null
      });
    }
  }
  return run;
}

// ARTIFACT RECEIPTS. Sheets, the audio report and the manifest all come back
// from pCloud with a fileid - sheets with a verified sha1 as well - and every
// one of them was discarded a line after it arrived. [MEASURED 2026-08-21] the
// record's only trace was quality.sheets_uploaded: a count the daemon derived
// from its own intentions, which reads identically whether pCloud accepted the
// file or never saw it.
//
// WRAPPED AND SWALLOWED, DELIBERATELY. A receipt that fails to save is a gap in
// a report. A film that FAILED because we tried to save a receipt would be
// unforgivable. This can never throw into the run loop.
function recordArtifacts(item) {
  try {
    const R = require('./record.js');
    const arts = [];
    const q = item.quality || {};
    if (q.audio_report && (q.audio_report.name || q.audio_report.error)) {
      arts.push({ kind: 'audio_report', codec: '', name: q.audio_report.name || null,
                  bytes: q.audio_report.bytes, destination: 'pcloud',
                  dest_path: item.dest_path, ok: !!q.audio_report.uploaded,
                  pcloud_fileid: q.audio_report.fileid, sha1_verified: null,
                  error: q.audio_report.error || null });
    }
    for (const sh of (q.sheets || [])) {
      arts.push({ kind: 'sheet', codec: sh.codec || '', name: sh.name || null,
                  bytes: sh.bytes, destination: 'pcloud', dest_path: item.dest_path,
                  ok: !!sh.uploaded, pcloud_fileid: sh.fileid,
                  sha1_verified: sh.sha1_verified, error: sh.error || null });
    }
    const m = item.manifest;
    if (m && (m.name || m.error)) {
      arts.push({ kind: 'manifest', codec: '', name: m.name || null, bytes: m.bytes,
                  destination: 'pcloud', dest_path: item.dest_path, ok: !!m.uploaded,
                  pcloud_fileid: m.fileid, sha1_verified: null, error: m.error || null });
    }
    if (arts.length) R.upsertArtifacts(item.item_id, arts);
  } catch (e) {
    console.error('recordArtifacts: ' + e.message);
  }
}

// ONE LISTING PER DESTINATION FOLDER, not one per film. Films in a batch share
// a destination, so a 30-film job made 30 identical pCloud calls. Cached for
// the life of the run; a run that just wrote files re-reads nothing, which is
// correct - the check only ever runs BEFORE this run writes anything there.
// ⛔ Returns null on any failure. Null means "unknown", and unknown means
// fetch. It must never be mistaken for an empty folder.
const _destCache = new Map();
async function listDestOnce(destPath) {
  if (_destCache.has(destPath)) return _destCache.get(destPath);
  let names = null;
  try {
    names = (await pc.listFolder(destPath)).filter(x => !x.isfolder).map(x => x.name);
  } catch (e) { names = null; }
  _destCache.set(destPath, names);
  return names;
}
function clearDestCache() { _destCache.clear(); }

// ---- CHEAP EXISTENCE CHECK, BEFORE THE DOWNLOAD
// [MEASURED 2026-08-22] processItem fetched and probed BEFORE listing the
// destination, so a resumed 16-film job re-downloaded ~9 GB per finished film
// - about two minutes each - only to conclude there was nothing to do.
// Everything needed is known without the master: outputName() takes only the
// source name, and the planner needs the master's height and codec, both held
// in the record from the first run. The probe block is carried forward so the
// manifest is complete rather than five nulls - run 7 paid for that one.
// ⛔ THE FAILURE MODES ARE NOT SYMMETRIC. Wrongly skipping loses work
// silently; wrongly fetching costs two minutes. Every ambiguity resolves
// toward fetching.
// ⛔ VIMEO FALLS THROUGH. A pCloud filename is evidence; a Vimeo video can be
// deleted upstream and only a live check knows.
// ⭐ Nothing downstream needs to know: verify collects only ENCODED rungs, the
// quality probe skips outputs with none, upload skips anything not VERIFIED,
// and the manifest already renders EXISTS.
async function canSkipFetch(item) {
  if (item.on_existing !== 'skip') return null;
  const prior = R.priorSource(item.name);
  if (!prior || !prior.height || !prior.video_codec) return null;
  const probeLike = {
    width: prior.width, height: prior.height, fps: prior.fps,
    duration_s: prior.duration_s, video_codec: prior.video_codec,
    audio_codec: prior.audio_codec, has_audio: prior.has_audio,
    source_bytes: prior.source_bytes, from_record: true
  };
  const listing = await listDestOnce(item.dest_path);
  if (listing === null) return null;
  let planned = 0;
  for (const o of item.outputs_requested) {
    const plan = P.planRungs(probeLike, o);
    const dests0 = o.destinations ||
      (o.target && o.target.type ? [o.target.type] : ['pcloud']);
    const ov = o.destination_overrides || null;
    for (const r of plan.rungs) {
      if (r.state !== 'PLANNED') continue;
      planned++;
      const d = (ov && (ov[r.height] || ov[String(r.height)])) || dests0;
      if (d.indexOf('vimeo') !== -1) return null;
      if (listing.indexOf(P.outputName(item.name, r.height, plan.codec)) === -1) return null;
    }
  }
  if (planned === 0) return null;
  return { probe: probeLike, planned: planned };
}

async function processItem(item, save, runNumber) {
  const scratch = path.join(SCRATCH_ROOT, item.item_id);
  fs.mkdirSync(scratch, { recursive: true });
  const outDir = path.join(scratch, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(scratch, 'source.mp4');
  const mark = (p) => { item.phase = p; save({ force: true }); };

  try {
    let skip = null;
    try { skip = await canSkipFetch(item); }
    catch (e) { skip = null; }
    if (skip) {
      item.probe = skip.probe;
      item.bytes = skip.probe.source_bytes;
      item.timings.fetch_s = 0;
      item.skipped_fetch = true;
    }
    // ---- FETCH
    mark('FETCHING');
    let t = Date.now();
    if (!skip) {
    const meta = await pc.stat(item.fileid);
    item.name = meta.name;
    item.bytes = meta.size;
    save({ force: true });
    await pc.withRetry('fetch', () => pc.download(item.fileid, src, (done, total) => {
      item.progress.pct = total ? (done / total) * 100 : 0;
      save({});
    }, null), n => { item.error = n; save({ force: true }); });
    item.error = null;
    item.timings.fetch_s = (Date.now() - t) / 1000;
    item.progress.pct = 0;

    // ---- PROBE
    mark('PROBING');
    item.probe = await probe(src);
    }

    // ---- PLAN
    mark('PLANNING');
    let existing = [];
    try {
      existing = (await pc.listFolder(item.dest_path))
                   .filter(x => !x.isfolder).map(x => x.name);
    } catch (e) { existing = []; }

    item.outputs = [];
    for (const o of item.outputs_requested) {
      const plan = P.planRungs(item.probe, o);
      plan.preset_name = o.preset || 'h264-standard';
      // DESTINATIONS ARE A LIST, and may be overridden per rung.
      //   Fall 2026   h264 ladder -> [pcloud];  hevc 1080p -> [vimeo]
      //   Spring 2027 hevc ladder -> [pcloud], 1080p overridden to
      //               [pcloud, vimeo] - one rung, two destinations.
      // Absent means [pcloud], so every job file written before this is
      // unaffected. A single legacy target object is still honoured.
      plan.destinations = o.destinations ||
        (o.target && o.target.type ? [o.target.type] : ['pcloud']);
      plan.destination_overrides = o.destination_overrides || null;
      plan.vimeo_folder = o.vimeo_folder || (o.target && o.target.folder) || null;

      // EXISTENCE IS JUDGED PER DESTINATION, and only AFTER destinations are
      // known. The old check listed the pCloud folder once and applied it to
      // every rung regardless of where that rung was going - so a Vimeo-bound
      // mezzanine could skip because a same-named file sat in a pCloud folder
      // it was no longer going to, and Vimeo would silently get nothing.
      //
      // A RUNG IS SKIPPED ONLY IF IT EXISTS AT EVERY DESTINATION IT OWES.
      // Present in pCloud but absent from Vimeo means encode it.
      for (const r of plan.rungs) {
        if (r.state !== 'PLANNED') continue;
        r.filename = P.outputName(item.name, r.height, plan.codec);
        const dests = destinationsFor(plan, r.height);
        r.destinations = dests;
        // DERIVED RATE FOR THE TOP H.264 RUNG. Ruled 2026-08-23. The 4 GiB
        // ceiling is a promise about size, so the 1080p H.264 rate is reduced
        // per film until it fits, capped at the preset rate and REFUSED below
        // the floor - past ~152 min, where 720p and the HEVC rung carry the
        // film instead. Applied uniformly; short films are never affected.
        if (plan.codec === 'h264' && Number(r.height) === 1080) {
          let dps = null;
          try { dps = loadPreset(plan.preset_name); } catch (e) { dps = null; }
          const spec = dps && (dps.rungs || []).find(x => Number(x.height) === 1080);
          const dur = Number(item.probe && item.probe.duration_s) || 0;
          if (spec && spec.rate_kbps && dur > 0) {
            const CEIL_BYTES = 4 * 1024 * 1024 * 1024;
            const FLOOR_KBPS = 3500;
            // 5%, not 3%. [MEASURED 2026-08-23, run 41] container overhead on
            // three finished files was 2.9-3.6% ON TOP of video+audio, so a 3%
            // reserve leaves nothing. The cost is a fraction of a VMAF point on
            // long films; the gain is that the 4 GiB promise cannot break.
            const RESERVE = 0.95;
            const total = (CEIL_BYTES * 8 / dur / 1000) * RESERVE;
            const video = Math.floor(total - Number(spec.audio_kbps || 0));
            const chosen = Math.min(Number(spec.rate_kbps), video);
            if (chosen < FLOOR_KBPS) {
              r.state = 'SKIPPED';
              r.reason = 'film too long for a 1080p file under 4 GB';
              continue;
            }
            r.rate_kbps = chosen;
            r.rate_derived = chosen < Number(spec.rate_kbps);
          }
        }
        if (item.on_existing !== 'skip') continue;

        const present = [], absent = [];
        for (const d of dests) {
          if (d === 'pcloud') {
            if (existing.indexOf(r.filename) !== -1) present.push('pcloud: file in folder');
            else absent.push('pcloud');
          } else if (d === 'vimeo') {
            // The record proposes; Vimeo disposes. A video deleted upstream
            // must come back as absent, not as a skip.
            let prior = null;
            try { prior = R.findDelivery(item.name, plan.codec, r.height, 'vimeo'); }
            catch (e) { prior = null; }
            if (!prior || !prior.vimeo_uri) { absent.push('vimeo'); continue; }
            let live = null;
            try { live = await VM.checkWitnessOnce(prior.vimeo_uri, item.probe.duration_s); }
            catch (e) { live = null; }
            if (live && live.state === 'VERIFIED') present.push('vimeo: ' + prior.vimeo_uri);
            else absent.push('vimeo (record had ' + prior.vimeo_uri + ', live says ' +
                             (live ? live.state : 'unreachable') + ')');
          } else {
            absent.push(d);
          }
        }
        if (absent.length === 0) {
          r.state = 'EXISTS';
          r.reason = 'already at all destinations - ' + present.join('; ');
        } else if (present.length) {
          r.reason = 'partial: present at ' + present.join('; ') + '; missing ' + absent.join(', ');
        }
      }

      item.outputs.push(plan);
    }
    save({ force: true });

    // ---- ENCODE, one ffmpeg per codec
    mark('ENCODING');
    t = Date.now();
    for (const out of item.outputs) {
      const todo = out.rungs.filter(r => r.state === 'PLANNED');
      if (!todo.length) continue;
      const preset = loadPreset(out.preset_name);
      out.encoding = true; save({ force: true });
      const res = await E.runEncode({
        src, plannedRungs: todo, preset, outDir, srcName: item.name,
        durationS: item.probe.duration_s,
        onProgress: (p) => {
          item.progress.pct = p.pct;
          item.progress.speed_x = p.speed_x;
          item.progress.eta_s = p.eta_s;
          item.progress.label = 'encoding';
          save({});
        }
      });
      for (const o2 of res.outputs) {
        const r = out.rungs.find(x => Number(x.height) === Number(o2.height));
        if (r) { r.state = 'ENCODED'; r.local = o2.final;
                 r.bytes = fs.statSync(o2.final).size; }
      }
      out.encoding = false;
      out.encode_wall_s = res.wall_s;
      out.speed_x = res.speed_x;
      save({ force: true });
    }
    item.timings.encode_s = (Date.now() - t) / 1000;
    item.progress.pct = 100;

    // ---- VERIFY  (all rungs decoded in PARALLEL; each narrates its own progress)
    mark('VERIFYING');
    t = Date.now();
    const vJobs = [];
    for (const out of item.outputs) {
      for (const r of out.rungs) {
        if (r.state === 'ENCODED') vJobs.push({ out: out, r: r });
      }
    }
    // QUALITY PROBE TARGETS. Top rung per codec. Audio on the H.264 rung only:
    // the mezzanine carries the same AAC from the same source, so measuring it
    // twice costs 4 s and learns nothing. The SHEET runs per codec because HEVC
    // has its own artifact vocabulary that no other check can see.
    // MEASURED 2026-08-19: sheet on a 720p rung +0.1 s over the decode already
    // running; on the HEVC rung it finished 23 s INSIDE that rung's own verify.
    const probeTargets = [];
    for (const out of item.outputs) {
      const live = out.rungs.filter(r => r.state === 'ENCODED');
      if (!live.length) continue;
      const top = live.reduce((a, b) => (Number(b.height) > Number(a.height) ? b : a));
      probeTargets.push({ out: out, r: top, codec: out.codec,
                          audio: out.codec === 'h264' });
    }
    // If no H.264 output ran, audio must still be measured once - put it on the
    // top rung of whatever DID run, rather than skipping the check entirely.
    if (probeTargets.length && !probeTargets.some(p => p.audio)) {
      probeTargets[0].audio = true;
    }
    item.quality = { sheets: [], audio: null, probe_s: null };

    const vProg = new Array(vJobs.length).fill(0);
    let vRunning = vJobs.length;
    const paint = function () {
      const mean = vProg.length
        ? vProg.reduce(function (x, y) { return x + y; }, 0) / vProg.length
        : 100;
      item.progress.pct = mean;
      item.progress.label = 'verifying \u2014 ' + vRunning + ' of ' + vJobs.length + ' still running';
      save({});
    };
    item.progress.pct = 0;
    item.progress.speed_x = 0;
    item.progress.eta_s = null;
    paint();

    await Promise.all(vJobs.map(async function (j, idx) {
      const vt0 = Date.now();
      let rungSpec = null;
      try {
        const vps = loadPreset(j.out.preset_name);
        rungSpec = vps.rungs.find(function (x) {
          return Number(x.height) === Number(j.r.height);
        }) || null;
      } catch (e) { rungSpec = null; }
      const v = await V.verifyRung(j.r.local, j.r.height, item.probe.duration_s, rungSpec,
        function (pr) { vProg[idx] = pr.pct; paint(); });
      j.r.verify_s = (Date.now() - vt0) / 1000;
      vProg[idx] = 100;
      vRunning--;
      j.r.verify = { ok: v.ok, coverage_ok: v.coverage_ok,
                     failed: V.failedNames(v), mbps: v.mbps };
      if (!v.ok) { j.r.state = 'FAILED'; j.r.reason = 'verify: ' + V.failedNames(v); }
      else { j.r.state = 'VERIFIED'; }
      paint();
      save({ force: true });
    }));

    // ---- QUALITY PROBE, in parallel with each other
    if (probeTargets.length) {
      const qt0 = Date.now();
      item.progress.label = 'quality probe';
      save({ force: true });
      const results = await Promise.all(probeTargets.map(function (p) {
        return Q.runProbe(p.r.local, item.probe.duration_s, outDir, item.name,
                          p.codec, { audio: p.audio });
      }));
      for (let i = 0; i < results.length; i++) {
        const res = results[i], tgt = probeTargets[i];
        if (res.sheet) {
          item.quality.sheets.push({ codec: tgt.codec, name: res.sheet_name,
                                     local: res.sheet, bytes: res.sheet_bytes,
                                     from_height: tgt.r.height, wall_s: res.wall_s });
        }
        if (tgt.audio) {
          const j = Q.judgeAudio(res.audio, item.probe.has_audio);
          item.quality.audio = { ok: j.ok, checks: j.checks,
                                 recorded: j.recorded || null,
                                 from_height: tgt.r.height, codec: tgt.codec };
          // SILENCE rides the same probe pass. Kept on the quality object so
          // upsertQuality can write it and the report can read it. RECORDED
          // ONLY - it changes no verdict, by ruling, until a corpus exists.
          item.quality.silence = res.silence || null;
          // PLAIN TEXT, readable without opening JSON. Same numbers, laid out
          // for a person. Uploaded beside the sheets in encodes/.
          try {
            const chans = (res.audio && res.audio.channels) || [];
            const L = [];
            L.push('SDVP ENCODER - AUDIO REPORT');
            L.push('');
            L.push('movie        : ' + item.name);
            L.push('measured on  : ' + tgt.r.height + 'p ' + tgt.codec);
            L.push('written      : ' + nowIso());
            L.push('duration     : ' + (item.probe.duration_s / 60).toFixed(2) + ' min');
            L.push('');
            L.push('VERDICT      : ' + (j.ok ? 'OK' : 'CHECK THIS FILE'));
            L.push('');
            L.push('CHECKS');
            (j.checks || []).forEach(function (c) {
              L.push('  ' + (c.ok ? '[ ok ] ' : '[FAIL] ') +
                     c.name + (c.detail ? '   ' + c.detail : ''));
            });
            L.push('');
            L.push('PER CHANNEL');
            chans.forEach(function (c) {
              L.push('  channel ' + c.channel +
                     '   peak ' + (c.peak_db != null ? c.peak_db.toFixed(2) : '-') + ' dB' +
                     '   RMS ' + (c.rms_db != null ? c.rms_db.toFixed(2) : '-') + ' dB' +
                     '   flat factor ' + (isFinite(c.flat_factor) ? c.flat_factor.toFixed(2)
                                          : (c.flat_factor === -Infinity ? 'perfectly flat' : '-')));
            });
            const rec = j.recorded || {};
            L.push('');
            L.push('  channel imbalance : ' + (rec.imbalance_db != null ? rec.imbalance_db : '-') + ' dB');
            L.push('');
            const sil = res.silence;
            L.push('');
            L.push('SILENCE');
            if (!sil) {
              L.push('  not measured');
            } else if (!sil.n) {
              L.push('  none detected at or below ' + sil.threshold_db +
                     ' dB for ' + sil.min_s + ' s or longer');
            } else {
              L.push('  ' + fmtHMS(sil.total_s) + ' silent, ' + sil.pct + '% of the film');
              L.push('  ' + sil.n + ' stretch' + (sil.n === 1 ? '' : 'es') +
                     ', longest ' + fmtHMS(sil.longest_s) +
                     ' beginning at ' + fmtHMS(sil.longest_at_s) +
                     (sil.ends_at_end ? ' and running to the end of the film' : ''));
              L.push('  A FADE OR AN END CARD looks like a short stretch at the end.');
              L.push('  A SLO-MO PASSAGE looks like a short stretch in the middle.');
              L.push('  A PULLED MICROPHONE looks like a long one anywhere.');
              L.push('  Recorded only - judge it against what you know of the master.');
            }
            L.push('');
            L.push('WHAT IS GATED   : no audio stream at all, and a dead channel.');
            L.push('WHAT IS NOT     : peak and RMS levels, channel imbalance, silence, and');
            L.push('                  flat factor. Recorded only - no corpus exists yet to');
            L.push('                  draw honest thresholds from, so they fail nothing.');
            L.push('');
            L.push('NOTE            : an audio finding does NOT fail the encode. The files');
            L.push('                  are delivered. The run report carries the finding so');
            L.push('                  a person looks at the master.');
            const aName = '_sdvp_audio_' + path.parse(item.name).name + '.txt';
            const aPath = path.join(outDir, aName);
            fs.writeFileSync(aPath, L.join('\n') + '\n');
            item.quality.audio_report = { name: aName, local: aPath };
          } catch (e) {
            item.quality.audio_report = null;
          }
          // ⛔ AN AUDIO FINDING DOES NOT FAIL THE RUNG. Dr. K's ruling
          // 2026-08-21: "Ship the film to the destination. Do not FAIL the
          // encode. I can envision circumstances where this is an acceptable
          // encode without revision. But HUMAN should have eyes on it, which
          // the reporting will trigger."
          //
          // WHAT FAILING THE RUNG USED TO DO, none of it chosen deliberately:
          // the film went to FAILED, its scratch was RETAINED (consuming disk
          // silently, indefinitely), and the run went red. A silent master and
          // a broken encode read identically. The encode was never wrong - the
          // master was, and that is an edit problem, not an encoder problem.
          //
          // THE FINDING NOW TRAVELS BY REPORT ONLY. quality.audio_ok = 0 is
          // written to the record, runVerdict scores it, and the ratchet keeps
          // it for the life of the run. If that path ever breaks, an audio
          // fault ships in silence - so it is load-bearing, not cosmetic.
          if (!j.ok) {
            item.audio_finding = j.checks.filter(c => !c.ok).map(c => c.name).join(',');
          }
        }
      }
      item.quality.probe_s = (Date.now() - qt0) / 1000;
      save({ force: true });
    }

    item.progress.pct = 100;
    item.progress.label = 'verified ' + vJobs.length + ' of ' + vJobs.length;
    item.timings.verify_s = (Date.now() - t) / 1000;
    save({ force: true });

    // ---- UPLOAD
    mark('UPLOADING');
    var upTotal = 0, upBase = 0;
    item.outputs.forEach(function(o){ o.rungs.forEach(function(r){ if (r.state === 'VERIFIED') upTotal += (r.bytes || 0); }); });
    item.progress.pct = 0;
    item.progress.label = 'uploading';
    save({ force: true });
    t = Date.now();
    await pc.createFolderIfNotExists(item.dest_path);
    item.vimeo = item.vimeo || [];

    const sendToPCloud = async function (out, r) {
      const localSha = await pc.sha1File(r.local);
      const t2 = Date.now();
      const up = await pc.withRetry('upload ' + r.height,
        () => pc.upload(r.local, item.dest_path, (sent, total) => {
          r.upload_pct = total ? (sent / total) * 100 : 0;
          item.progress.pct = upTotal ? ((upBase + sent) / upTotal) * 100 : 0;
          if (total && sent >= total) r._lastByteAt = Date.now();
          save({});
        }),
        n => { item.error = n; save({ force: true }); });
      item.error = null;
      const doneAt = Date.now();
      const rk = await pc.checksum(up.fileid);
      r.stored_fileid = up.fileid;
      r.checksum_match = (rk.sha1 === localSha);
      r.upload_s  = (doneAt - t2) / 1000;
      r.wire_s    = r._lastByteAt ? (r._lastByteAt - t2) / 1000 : null;
      r.server_s  = r._lastByteAt ? (doneAt - r._lastByteAt) / 1000 : null;
      r.wire_mbps = r.wire_s ? (up.size * 8) / r.wire_s / 1e6 : null;
      delete r._lastByteAt;
      r.upload_mbps = (up.size * 8) / r.upload_s / 1e6;
      if (!r.checksum_match) r.reason = 'checksum mismatch after upload';
      return r.checksum_match === true;
    };

    const sendToVimeo = async function (out, r) {
      const t3 = Date.now();
      try {
        const up = await VM.uploadVideo({
          file: r.local,
          title: path.parse(item.name).name,
          description: 'SDVP encoder run ' + (runNumber || 0) + ', ' +
                       out.codec + ' ' + r.height + 'p',
          folderUri: out.vimeo_folder || null,
          onProgress: (p) => {
            r.vimeo_pct = p.pct;
            // The overall bar counts bytes across EVERY destination. Without
            // this, a movie whose mezzanine goes to Vimeo finishes the bar at
            // the pCloud fraction only - measured at 72 percent on run 11.
            item.progress.pct = upTotal ? ((upBase + (p.sent || 0)) / upTotal) * 100 : 0;
            save({});
          }
        });
        // THE URI IS THE ONLY DURABLE HANDLE. Vimeo folders are dashboard
        // labels with no filesystem behind them. Record it before anything
        // else can fail.
        r.vimeo_uri = up.uri;
        r.vimeo_link = up.link;
        r.vimeo_s = (Date.now() - t3) / 1000;
        r.vimeo_mbps = up.mbps;
        r.vimeo_folder_moved = up.folder_moved;
        r.vimeo_attempts = up.attempts;
        const entry = { uri: up.uri, height: r.height, codec: out.codec,
                        expected_duration_s: item.probe.duration_s,
                        witness: { state: 'PENDING' } };
        item.vimeo.push(entry);
        save({ force: true });
        // NON-BLOCKING, roughly 200 ms. PENDING is not a pass - the end-of-run
        // sweep resolves it. MEASURED 2026-08-19: duration is reported while
        // transcode is still running, so we never wait on Vimeo's ladder.
        entry.witness = await VM.checkWitnessOnce(up.uri, item.probe.duration_s);
        r.vimeo_witness = entry.witness.state;
        r.vimeo_drift_s = entry.witness.drift_s;
        if (entry.witness.state === 'MISMATCH' || entry.witness.state === 'FAILED') {
          r.reason = 'vimeo witness ' + entry.witness.state +
                     (entry.witness.drift_s != null ? ' drift ' + entry.witness.drift_s + 's' : '');
          return false;
        }
        return true;
      } catch (e) {
        r.reason = 'vimeo: ' + VM.redact(String(e.message)).slice(0, 200);
        return false;
      }
    };

    for (const out of item.outputs) {
      for (const r of out.rungs) {
        if (r.state !== 'VERIFIED') continue;
        const dests = destinationsFor(out, r.height);
        r.destinations = dests;
        const failedAt = [];
        for (const d of dests) {
          let ok = false;
          if (d === 'vimeo') ok = await sendToVimeo(out, r);
          else if (d === 'pcloud') ok = await sendToPCloud(out, r);
          else { r.reason = 'unknown destination: ' + d; ok = false; }
          if (!ok) failedAt.push(d);
        }
        upBase += (r.bytes || 0);
        // A rung is STORED only when EVERY destination it was promised to
        // actually took it. A partial delivery is a failure, not a success.
        r.state = failedAt.length ? 'FAILED' : 'STORED';
        if (failedAt.length) {
          r.reason = (r.reason ? r.reason + ' | ' : '') + 'failed at: ' + failedAt.join(',');
        }
        save({ force: true });
      }
    }
    // ---- QUALITY SHEETS. Uploaded whatever the rungs did: the movie with a
    // failed rung is precisely the one worth looking at, and scratch is deleted
    // on success, so a sheet that is not pushed here is a sheet nobody sees.
    if (item.quality && item.quality.audio_report && item.quality.audio_report.local) {
      try {
        const ar = item.quality.audio_report;
        const arUp = await pc.withRetry('audio report',
          () => pc.upload(ar.local, item.dest_path, null), () => {});
        ar.fileid = arUp.fileid;
        ar.bytes = (function(){ try { return fs.statSync(ar.local).size; } catch (e) { return null; } })();
        ar.uploaded = true;
      } catch (e) {
        item.quality.audio_report.uploaded = false;
        item.quality.audio_report.error = pc.redact(String(e.message)).slice(0, 200);
      }
      delete item.quality.audio_report.local;
      save({ force: true });
    }

    if (item.quality && item.quality.sheets && item.quality.sheets.length) {
      for (const sh of item.quality.sheets) {
        try {
          const shSha = await pc.sha1File(sh.local);
          const shUp = await pc.withRetry('sheet ' + sh.codec,
            () => pc.upload(sh.local, item.dest_path, null),
            n => { item.error = n; save({ force: true }); });
          item.error = null;
          const shK = await pc.checksum(shUp.fileid);
          sh.fileid = shUp.fileid;
          sh.sha1_verified = (shK.sha1 === shSha);
          sh.uploaded = true;
        } catch (e) {
          sh.uploaded = false;
          sh.error = pc.redact(String(e.message)).slice(0, 200);
        }
        // Keep a copy where cleanup cannot reach it, for the page.
        try {
          fs.mkdirSync(SHEET_ROOT, { recursive: true });
          const kept = path.join(SHEET_ROOT, sh.name);
          fs.copyFileSync(sh.local, kept);
          sh.served = sh.name;
        } catch (e) {
          sh.served = null;
        }
        delete sh.local;
        save({ force: true });
      }
    }

    item.progress.pct = 100;
    item.progress.label = 'uploaded';
    item.timings.upload_s = (Date.now() - t) / 1000;

    // ---- MANIFEST  (written to the OUTPUT dir and uploaded, so it survives cleanup)
    const manifest = {
      manifest_version: 3,
      run_number: runNumber || null,
      written_at: nowIso(),
      written_date: nowIso().slice(0, 10),
      ffmpeg: FFMPEG_VERSION,
      source: {
        name: item.name, fileid: item.fileid, bytes: item.bytes,
        width: item.probe ? item.probe.width : null,
        height: item.probe ? item.probe.height : null,
        codec: item.probe ? item.probe.video_codec : null,
        duration_s: item.probe ? item.probe.duration_s : null,
        fps: item.probe ? item.probe.fps : null
      },
      outputs: [],
      quality: item.quality ? {
        sheets: (item.quality.sheets || []).map(function (s) {
          return { codec: s.codec, name: s.name, bytes: s.bytes,
                   from_height: s.from_height, fileid: s.fileid || null,
                   sha1_verified: s.sha1_verified === true,
                   uploaded: s.uploaded === true, wall_s: s.wall_s || null };
        }),
        audio: item.quality.audio || null,
        probe_s: item.quality.probe_s || null
      } : null,
      timings: item.timings
    };

    for (const out of item.outputs) {
      let ps = null;
      try { ps = loadPreset(out.preset_name); } catch (e) { ps = null; }
      const entry = {
        codec: out.codec,
        preset: out.preset_name,
        encoder: ps ? ps.encoder : null,
        encoder_preset: ps ? ps.preset : null,
        encode_wall_s: out.encode_wall_s || null,
        speed_x: out.speed_x || null,
        destinations: out.destinations || ['pcloud'],
        destination_overrides: out.destination_overrides || null,
        rungs: []
      };
      for (const r of out.rungs) {
        const spec = ps ? ps.rungs.find(x => Number(x.height) === Number(r.height)) : null;

        // CARRY FORWARD. A rung this run SKIPPED because it already exists is
        // still real, and the manifest must say what it is rather than publish
        // nulls over what an earlier run measured. The record is where that
        // knowledge lives now.
        if (r.state === 'EXISTS') {
          let prior = null;
          try { prior = R.priorRung(item.name, out.codec, r.height); } catch (e) { prior = null; }
          if (prior) {
            const pc2 = (prior.deliveries || []).find(d => d.destination === 'pcloud') || {};
            const vm2 = (prior.deliveries || []).find(d => d.destination === 'vimeo') || {};
            entry.rungs.push({
              height: r.height,
              state: 'EXISTS',
              carried_forward: true,
              filename: prior.filename || r.filename || null,
              crf: prior.crf, maxrate: prior.maxrate, bufsize: prior.bufsize,
              audio_kbps: prior.audio_kbps,
              bytes: prior.bytes, mbps: prior.mbps,
              destinations: r.destinations || null,
              fileid: pc2.pcloud_fileid || null,
              sha1_verified: pc2.sha1_verified === 1,
              vimeo_uri: vm2.vimeo_uri || null,
              vimeo_link: vm2.vimeo_link || null,
              vimeo_witness: vm2.witness_state || null,
              verify_s: prior.verify_s, upload_s: null,
              reason: r.reason || 'already at all destinations'
            });
            continue;
          }
        }

        entry.rungs.push({
          height: r.height,
          state: r.state,
          filename: r.filename || null,
          crf: spec ? spec.crf : null,
          maxrate: spec ? spec.maxrate : null,
          bufsize: spec ? spec.bufsize : null,
          audio_kbps: spec ? spec.audio_kbps : null,
          bytes: r.bytes || null,
          mbps: (r.verify && r.verify.mbps) || null,
          fileid: r.stored_fileid || null,
          sha1_verified: (r.checksum_match === true) || false,
          destinations: r.destinations || null,
          vimeo_uri: r.vimeo_uri || null,
          vimeo_link: r.vimeo_link || null,
          vimeo_witness: r.vimeo_witness || null,
          verify_s: r.verify_s || null,
          upload_s: r.upload_s || null,
          reason: r.reason || null
        });
      }
      manifest.outputs.push(entry);
    }

    // WRITE-ONCE NAME: never updated, so there is no update to lose.
    //
    // The name carries the MOVIE and the RUN. It does NOT carry the date.
    // Run #7 wrote sixteen manifests to TWO filenames - run number plus date
    // is not unique per movie, and the run crossed midnight on the box clock,
    // so even the collision COUNT depended on what time the run started.
    // Fourteen manifests were destroyed. The date now lives INSIDE the file,
    // where a rollover harms nothing. A same-day rerun of the same show gets a
    // new run number, so it does not collide either.
    // A RUN THAT PRODUCED NOTHING DOES NOT GET A MANIFEST.
    // Run 9 on 2026-08-19 encoded nothing, uploaded nothing and probed nothing,
    // yet published a complete-looking manifest of nulls beside the real one -
    // and a reader taking the newest per movie would have believed it.
    // A manifest describes what a run MADE. No work, no manifest.
    const producedSomething = item.outputs.some(function (o) {
      return o.rungs.some(function (x) {
        return x.state === 'STORED' || x.state === 'FAILED' || x.state === 'VERIFIED';
      });
    });
    if (!producedSomething) {
      item.manifest = { name: null, uploaded: false,
                        skipped: 'no rung was made or delivered on this run' };
      save({ force: true });
    } else {
    const mName = manifestName(item.name, runNumber);
    const mPath = path.join(outDir, mName);
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
    try {
      const mUp = await pc.withRetry('manifest', () => pc.upload(mPath, item.dest_path, null),
                                     n => { item.error = n; save({ force: true }); });
      item.error = null;
      item.manifest = { name: mName, fileid: mUp.fileid, uploaded: true,
                        bytes: (function(){ try { return fs.statSync(mPath).size; }
                                            catch (e) { return null; } })() };
    } catch (e) {
      item.manifest = { name: mName, uploaded: false,
                        error: pc.redact(String(e.message)).slice(0, 200) };
    }
    }
    save({ force: true });

    const anyFailed = item.outputs.some(o => o.rungs.some(r => r.state === 'FAILED'));

    // ---- CLEAN (success path only)
    if (!anyFailed) {
      mark('CLEANING');
      fs.rmSync(scratch, { recursive: true, force: true });
      item.scratch_retained = false;
      item.scratch_path = null;
      item.phase = 'DONE';
    } else {
      item.scratch_retained = scratch;
      item.scratch_path = scratch;
      item.phase = 'FAILED';
      item.error = item.error || 'one or more rungs failed';
    }
    save({ force: true });

    // ⛔ RECORD AFTER THE PHASE IS SET, NEVER BEFORE. MEASURED 2026-08-20:
    // run 13 left BREEDERS CLASS and PIPER PROCESSION reading UPLOADING in
    // the record forever. Both were DONE in memory. The write happened above
    // this block, so it captured the phase mid-flight, and the only later
    // correction was gated on having sent something to Vimeo - which those
    // two had not, because they already existed there. A FAILED item was
    // equally never recorded as FAILED. This is the last moment the item is
    // fully described. The write is wrapped and cannot fail the run.
    recordItem(runNumber, item);
    recordArtifacts(item);

  } catch (e) {
    item.phase = 'FAILED';
    item.error = pc.redact(String(e.message)).split('\n')[0].slice(0, 300);
    item.scratch_retained = scratch;
    save({ force: true });
  }
}

async function runJobFile(jobPath, state, save) {
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  if (Number(job.job_file_version) !== 3) {
    throw new Error('unsupported job_file_version: ' + job.job_file_version);
  }
  const run = buildRun(job, jobPath);
  state.run_counter = (Number(state.run_counter) || 0) + 1;
  run.run_number = state.run_counter;
  state.runs.unshift(run);
  save({ force: true });

  for (const item of run.items) {
    // STOP IS HONOURED HERE, BETWEEN FILMS. The film in flight always finishes
    // completely - encode, verify, upload, record, manifest - so nothing is
    // ever left half-delivered. Remaining films never start.
    // ABORT does not come through here: it kills the process outright, and
    // recovery reads the same flag and refuses to re-queue the job.
    if (state.stop_requested &&
        Number(state.stop_requested.run_number) === Number(run.run_number)) {
      run.stopped_by_operator = state.stop_requested.mode || 'STOP';
      // Films that never started must NOT read QUEUED. Queued means "waiting
      // to start", and there is no resume - nothing will ever pick them up.
      // A label describing a state that cannot happen is worse than no label.
      // Dr. K, 2026-08-20.
      for (const rest of run.items) {
        if (rest.phase === 'QUEUED') {
          rest.phase = 'UNSTARTED';
          rest.error = 'run stopped by operator before this file began';
        }
      }
      save({ force: true });
      break;
    }
    state.daemon.current_item = item.item_id;
    save({ force: true });
    await processItem(item, save, run.run_number);
  }

  state.daemon.current_item = null;
  save({ force: true });

  // RESOLVE VIMEO WITNESSES BEFORE THE RUN IS CALLED COMPLETE. The per-item
  // check fires ~2 s after upload, which is too early; measured 2026-08-19,
  // a mezzanine read PENDING at 2 s and VERIFIED a few minutes later, drift
  // 0.44 s. Waiting mid-run would idle the box. Waiting HERE is free, because
  // encoding is finished and nothing else is queued.
  // An unresolved delivery must not hide inside a run marked COMPLETE.
  try {
    run.witness_sweep = await sweepRunWitnesses(run, save);
  } catch (e) {
    run.witness_sweep = { error: String(e.message).slice(0, 200) };
  }

  try {
    run.record_snapshot = await snapshotRecord(run.run_number);
  } catch (e) {
    run.record_snapshot = { ok: false, error: String(e.message).slice(0, 200) };
  }
  save({ force: true });

  run.finished_at = nowIso();
  const allDone = run.items.every(i => i.phase === 'DONE');
  const unresolved = (run.witness_sweep && run.witness_sweep.unresolved) || 0;
  // A DELIBERATE STOP IS NOT A FAILURE. The loop broke early because the
  // operator asked it to, so films never started - that is not the same as
  // films that failed, and reporting it red would teach the reader to
  // discount red. Films that DID run are still judged normally.
  run.status = run.stopped_by_operator ? 'STOPPED'
             : !allDone ? 'COMPLETE_WITH_FAILURES'
             : unresolved ? 'COMPLETE_WITNESS_UNRESOLVED'
             : 'COMPLETE';
  save({ force: true });

  // ⛔ THE RECORD MUST LIST WHAT WAS ATTEMPTED, NOT WHAT SURVIVED.
  // [MEASURED 2026-08-22] Run 38 carried 18 films in the job and 17 in the
  // record. BMDCA2026-JMD-SAKS-251 threw on pCloud folder creation; the catch
  // at the foot of processItem sets the phase, saves memory and RETURNS - the
  // record write lives above it, on the path only a completing film reaches.
  // So the film vanished: no row, no error, no scratch, nothing for any query
  // to find. Every per-film check in the report then asked about a set that
  // never contained it and came back honestly green.
  // Run 23 lost two films the same way down a different path - stopped before
  // they started, marked in memory, never written.
  // THIS SWEEP DOES NOT CARE HOW A FILM WAS LOST. That is the point: it also
  // covers the paths nobody has thought of yet. upsertMovie is keyed on
  // item_id and updates only phase, error and timings, so every film already
  // recorded is rewritten identically and nothing is disturbed.
  // A failure to write history must never fail an encode that succeeded, so
  // each film is wrapped on its own and the run carries on regardless.
  for (const it of (run.items || [])) {
    try { recordItem(run.run_number, it); }
    catch (e) {
      console.error('end-of-run record sweep failed for ' +
        (it.name || it.item_id) + ': ' + String(e.message).slice(0, 200));
    }
  }
  save({ force: true });

  // ⛔ THE RUN ROW MUST BE WRITTEN AGAIN HERE. MEASURED 2026-08-20: upsertRun
  // is reached ONLY from recordItem, which runs per item DURING the run - so
  // finished_at and status were always captured as null/RUNNING. Runs 10-13
  // all read RUNNING in the record while state.json read COMPLETE. Runs 1-9
  // only looked correct because they were backfilled after the fact.
  // No live run had ever recorded its own ending.
  try {
    R.upsertRun(run, { box_host: require('os').hostname(),
                       ffmpeg_version: FFMPEG_VERSION });
  } catch (e) {
    console.error('run row final write failed (run continues): ' +
                  String(e.message).slice(0, 200));
  }
  return run;
}

// destinationsFor is exported so the PREFLIGHT asks the same rule the run
// obeys. Reimplementing it there would test a copy, and the day the two
// drift the preflight would answer confidently about code that no longer runs.
module.exports = { runJobFile, buildRun, processItem, loadPreset, manifestName,
                   destinationsFor };
