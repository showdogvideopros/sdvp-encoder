'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const st = require('/root/build/lib/state.js');
const orch = require('/root/build/lib/orchestrator.js');

const PORT = Number(process.env.ENCODER_PORT || 8099);
const JOBS = path.join(st.ROOT, 'jobs');
const PAGE = '/root/build/public/status.html';

st.ensureDirs();
const state = st.load();
state.daemon = { pid: process.pid, started_at: new Date().toISOString(), current_item: null };
if (!state.runs) state.runs = [];
const save = (o) => st.save(state, o);

// ---- CRASH RECOVERY ------------------------------------------------------
// [MEASURED 2026-08-20] Before this existed, nothing looked at an interrupted
// item on startup: the state loaded verbatim, current_item was cleared to
// null, and the job file had been renamed .accepted the moment it was picked
// up - so there was no queue entry left to find and no code that would notice.
// An unattended crash did not leave work "stuck"; it DROPPED it silently,
// abandoning every remaining movie in the job.
//
// THE RULE, deliberately conservative: any item not in a terminal state is
// abandoned, its scratch discarded, and the whole job re-queued from its own
// job file. Partial output is never trusted - a half-written encode looks
// exactly like a finished one on disk. Re-encoding is cheap next to shipping
// a truncated file, and the per-destination existence check means finished
// rungs are SKIPPED rather than redone, so a movie that was nine-tenths done
// costs one rung, not the whole ladder.
//
// The interrupted run is left in the record as FAILED with its reason, and the
// re-queued job becomes a NEW run number. That is honest: the first run was
// interrupted, the second is a fresh instantiation of the same job, and its
// report will correctly show most work skipped as already present.
const WORKING = { FETCHING:1, PROBING:1, PLANNING:1, ENCODING:1,
                  VERIFYING:1, UPLOADING:1, CLEANING:1 };
(function recoverInterrupted() {
  const SCRATCH = '/var/lib/sdvp-encoder/scratch';
  let requeued = 0, marked = 0;
  for (const run of (state.runs || [])) {
    // UNSTARTED is TERMINAL - it means a stopped run's films that will never
    // run. Sweeping them as abandoned work would make a later crash re-queue
    // a job the operator deliberately halted.
    const hit = (run.items || []).filter(i =>
      (WORKING[i.phase] || i.phase === 'QUEUED') && i.phase !== 'UNSTARTED');
    if (!hit.length) continue;
    for (const it of hit) {
      if (WORKING[it.phase]) {
        // Discard partial output. Named by item_id, so this is exact - never a
        // sweep by age, never a guess about which directory belonged to what.
        const dir = path.join(SCRATCH, String(it.item_id));
        try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { console.error('recover: could not clear scratch for ' +
                                  it.item_id + ': ' + e.message); }
        it.scratch_retained = false;
      }
      it.error = 'daemon stopped during ' + it.phase + ' - work abandoned, job re-queued';
      it.phase = 'FAILED';
      marked++;
    }
    if (!run.finished_at) {
      run.finished_at = new Date().toISOString();
      run.status = 'INTERRUPTED';
    }
    // A DELIBERATE STOP IS NOT A CRASH. If the operator asked for this, the
    // job must NOT come back - that is the entire difference between ABORT and
    // a power cut, and getting it wrong would mean the button does nothing.
    const stopped = state.stop_requested &&
                    Number(state.stop_requested.run_number) === Number(run.run_number);
    if (stopped) {
      run.status = state.stop_requested.mode === 'ABORT' ? 'ABORTED' : 'STOPPED';
      for (const it of hit) {
        it.error = 'run ' + run.status.toLowerCase() + ' by operator';
      }
      st.event({ kind: 'run_' + run.status.toLowerCase(), run: run.run_number });
      console.log('run ' + run.run_number + ' was ' + run.status +
                  ' by request - not re-queued');
    }
    // WRITE THE INTERRUPTION INTO THE RECORD. [MEASURED 2026-08-20] A killed
    // run never reached the point where anything is recorded, so run 16 had NO
    // record row at all - the crash existed only in state.json and on the
    // page. The record is the durable artifact; the state file is not. After a
    // five-day unattended burn, "how many times did it crash, and where" must
    // be answerable from the record alone.
    // Wrapped whole: failing to write history must never stop the daemon
    // starting, which is the one thing that would turn a crash into an outage.
    try {
      const R = require('/root/build/lib/record.js');
      R.upsertRun(run, { box_host: require('os').hostname() });
      for (const it of hit) { try { R.upsertMovie(run.run_id, it); } catch (e2) {} }
      R.close();
    } catch (e) {
      console.error('recover: could not record interrupted run ' +
                    run.run_number + ': ' + e.message);
    }
    // Put the job back in the queue by its original name. The scanner picks it
    // up as if newly dropped and it becomes a new run.
    if (!stopped && run.job_file && String(run.job_file).endsWith('.accepted')) {
      const back = String(run.job_file).replace(/\.accepted$/, '');
      try {
        if (fs.existsSync(run.job_file) && !fs.existsSync(back)) {
          fs.renameSync(run.job_file, back);
          requeued++;
          st.event({ kind: 'job_requeued_after_crash', file: back,
                     from_run: run.run_number, items_abandoned: hit.length });
        }
      } catch (e) {
        console.error('recover: could not re-queue ' + run.job_file + ': ' + e.message);
      }
    }
  }
  // The flag has done its work. Leaving it set would make the NEXT crash look
  // like a deliberate stop and silently drop a job that should have resumed.
  if (state.stop_requested) {
    state.last_stop = state.stop_requested;
    delete state.stop_requested;
  }
  if (marked || requeued) {
    console.log('crash recovery: ' + marked + ' item(s) abandoned, ' +
                requeued + ' job(s) re-queued');
  }
})();

save({ force: true });

http.createServer((req, res) => {
  // SHEETS. Serves only files whose name matches the sheet pattern, from one
  // fixed directory, with no path separators permitted - a filename, never a
  // path, so nothing outside that folder is reachable.
  if (req.url.indexOf('/sheet/') === 0) {
    const raw = decodeURIComponent(req.url.slice(7).split('?')[0]);
    if (raw.indexOf('/') !== -1 || raw.indexOf('\\') !== -1 ||
        raw.indexOf('..') !== -1 || !/^_sdvp_quality_.+\.jpg$/.test(raw)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('bad sheet name');
    }
    const f = '/var/lib/sdvp-encoder/sheets/' + raw;
    if (!fs.existsSync(f)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('no such sheet');
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(f));
  }

  // ---- PROFILES -----------------------------------------------------------
  // Sidecar files beside the presets, read at request time so the panel can
  // never offer something the box cannot do. Adding a JMC profile in September
  // is dropping a file in, not a deploy.
  if (req.url === '/api/profiles') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    try {
      const dir = '/root/build/profiles';
      const out = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        j._file = f; return j;
      }).sort((a, b) => (a.order || 99) - (b.order || 99));
      // The panel also needs to know which rungs each preset actually defines,
      // so a hand-edited output can never name a rung that does not exist.
      const presets = {};
      for (const f of fs.readdirSync('/root/build/presets').filter(x => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync('/root/build/presets/' + f, 'utf8'));
        // 'provisional' marks rungs DERIVED rather than measured. The editor
        // labels them so a ladder built on them is never mistaken for one
        // resting on measurement. See rung_provenance in the preset itself.
        presets[f.replace(/\.json$/, '')] =
          { name: j.name, codec: j.codec,
            rungs: (j.rungs || []).map(r => r.height),
            provisional: (j.rungs || []).filter(r => r.provisional).map(r => r.height) };
      }
      return res.end(JSON.stringify({ ok: true, profiles: out, presets: presets }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // ---- ESTIMATE A RUN -----------------------------------------------------
  // Rates are measured from the record on every call, so this sharpens as the
  // box works. Returns a RANGE: mean absolute error against 12 finished runs
  // was 26%, and a single figure would imply a precision the data does not
  // support. Answers "one night or three days", not "how many minutes".
  if (req.url === '/api/estimate') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      try {
        const E = require('/root/build/lib/estimate.js');
        const j = JSON.parse(body || '{}');
        const films = j.films || [];
        const e = E.estimate(films);
        return res.end(JSON.stringify({ ok: true, seconds: e.seconds,
          low: e.low, high: e.high, words: E.words(e.seconds), range: E.range(e),
          sample: { h264: e.rates.n_h264, both: e.rates.n_both } }));
      } catch (err) {
        return res.end(JSON.stringify({ ok: false, error: String(err.message).slice(0, 200) }));
      }
    });
    return;
  }

  // ---- SAVE A PROFILE -----------------------------------------------------
  // The Media Encoder model: configure once, name it, keep it. Written as a
  // sidecar beside the presets, so adding the JMC profile in September is a
  // file appearing, not a deploy.
  // Validated exactly like a job's outputs - a profile that names a rung its
  // preset does not define would fail at encode time, hours later.
  if (req.url === '/api/profile/save') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      let prof;
      try { prof = JSON.parse(body); }
      catch (e) { return res.end(JSON.stringify({ ok: false, error: 'could not read it' })); }
      const problems = [];
      const nm = String(prof.name || '').trim();
      if (!nm) problems.push('the profile needs a name');
      if (!/^[A-Za-z0-9 _.-]+$/.test(nm)) problems.push('use letters, numbers, spaces, dot, dash or underscore in the name');
      const outs = prof.outputs || [];
      if (!outs.length) problems.push('nothing is selected');
      outs.forEach(function (o) {
        let ps = null;
        try { ps = JSON.parse(fs.readFileSync('/root/build/presets/' + o.preset + '.json', 'utf8')); }
        catch (e) { problems.push('preset "' + o.preset + '" does not exist'); return; }
        const have = (ps.rungs || []).map(r => Number(r.height));
        (o.rungs || []).forEach(function (h) {
          if (have.indexOf(Number(h)) === -1) problems.push(o.preset + ' has no ' + h + 'p rung');
        });
        if (!(o.rungs || []).length) problems.push(o.preset + ': no rungs chosen');
        if (!(o.destinations || []).length) problems.push(o.preset + ': no destination chosen');
        const ov = o.destination_overrides || {};
        Object.keys(ov).forEach(function (h) {
          if ((o.rungs || []).map(Number).indexOf(Number(h)) === -1)
            problems.push(o.preset + ': a destination is set for ' + h + 'p, which is not selected');
          if (!(ov[h] || []).length) problems.push(o.preset + ': ' + h + 'p has no destination');
        });
      });
      if (problems.length) return res.end(JSON.stringify({ ok: false, problems: problems }));
      const slug = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const dest = '/root/build/profiles/' + slug + '.json';
      const out = { name: nm, description: prof.description || 'Saved from the jobs panel.',
                    order: Number(prof.order) || 50, outputs: outs,
                    saved_at: new Date().toISOString() };
      try {
        const tmp = dest + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
        fs.renameSync(tmp, dest);
      } catch (e) {
        return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
      }
      return res.end(JSON.stringify({ ok: true, file: slug + '.json', name: nm,
                                      replaced: false, message: 'Saved as "' + nm + '".' }));
    });
    return;
  }

  // ---- DELETE A PROFILE ---------------------------------------------------
  // Presets accumulate experiments. Nothing else is touched: a held job keeps
  // its own copy of the ladder, so deleting a preset never changes work
  // already built.
  if (req.url.indexOf('/api/profile/delete/') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const raw = decodeURIComponent(req.url.split('/').pop().split('?')[0]);
    if (!/^[0-9A-Za-z_.-]+\.json$/.test(raw) || raw.indexOf('..') !== -1) {
      return res.end(JSON.stringify({ ok: false, error: 'bad preset name' }));
    }
    const f = '/root/build/profiles/' + raw;
    if (!fs.existsSync(f)) {
      return res.end(JSON.stringify({ ok: false, error: 'no such preset' }));
    }
    try {
      fs.unlinkSync(f);
      return res.end(JSON.stringify({ ok: true, message: 'Deleted.' }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // ---- BROWSE pCLOUD ------------------------------------------------------
  if (req.url.indexOf('/api/browse') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const q = req.url.indexOf('?');
    let folder = '/';
    if (q >= 0) {
      const params = new URLSearchParams(req.url.slice(q + 1));
      folder = params.get('path') || '/';
    }
    const pc = require('/root/build/lib/pcloud.js');
    return pc.listFolder(folder).then(function (entries) {
      const dirs  = (entries || []).filter(e => e.isfolder)
                      .sort((a, b) => a.name.localeCompare(b.name));
      // NEWEST FIRST. Dr. K works forward through a production day, so the
      // films he just uploaded belong at the top of the list, not buried
      // alphabetically among everything the show has ever produced.
      const files = (entries || []).filter(e => !e.isfolder && /\.(mp4|mov|m4v)$/i.test(e.name))
                      .sort(function (a, b) {
                        const ta = Date.parse(a.modified || a.created || 0) || 0;
                        const tb = Date.parse(b.modified || b.created || 0) || 0;
                        if (tb !== ta) return tb - ta;
                        return a.name.localeCompare(b.name);
                      });
      res.end(JSON.stringify({ ok: true, path: folder, folders: dirs, files: files }));
    }).catch(function (e) {
      res.end(JSON.stringify({ ok: false, error: pc.redact(String(e.message)).slice(0, 200) }));
    });
  }

  // ---- PREFLIGHT ----------------------------------------------------------
  // Dr. K, 2026-08-21: "A tired mind during production season may forget what
  // was encoded yesterday. No need to do it twice."
  //
  // ADVISORY, NEVER BLOCKING - his ruling. A refusal at eleven at night, when
  // he knows perfectly well the folder is fine, would be infuriating, and he is
  // the one with the context. This reports; he decides.
  //
  // It asks the SAME questions the run will ask, in the same way: the pCloud
  // half lists the DESTINATION FOLDER and matches filenames, exactly as
  // processItem does. That is stronger than querying our own record - it also
  // sees files encoded before this box existed, or moved by hand.
  //
  // ⛔ WHAT IT CANNOT KNOW: whether the top rung will be LINKED rather than
  // encoded depends on the master's own codec and height, which needs a probe.
  // It says so instead of guessing.
  if (req.url === '/api/preflight') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async function () {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      let job;
      try { job = JSON.parse(body || '{}'); }
      catch (e) { return res.end(JSON.stringify({ ok: false, error: 'could not read the job' })); }

      const pc = require('/root/build/lib/pcloud.js');
      const P = require('/root/build/lib/planner.js');
      const orch = require('/root/build/lib/orchestrator.js');
      let R = null;
      try { R = require('/root/build/lib/record.js'); } catch (e) { R = null; }

      const out = { ok: true, batches: [], totals: { films: 0, missing_sources: 0,
                    outputs: 0, present: 0, todo: 0, vimeo_unchecked: 0 } };
      try {
        for (const b of job.batches || []) {
          const dest = b.dest_path_override ||
                       ((b.source_path || '') + '/' + (job.dest_subfolder || 'encodes'));
          const row = { label: b.label || '(batch)', source_path: b.source_path,
                        dest_path: dest, dest_exists: false, films: (b.items || []).length,
                        missing_sources: [], present: [], todo: 0, outputs: 0,
                        top_rung_likely_linked: 0, note: null };

          // The masters: ONE listing, matched on file id. A master renamed or
          // moved since the job was built fails the run hours in; here it costs
          // a second.
          let srcNames = null;
          try {
            const se = await pc.listFolder(b.source_path);
            srcNames = {};
            for (const e of se) if (!e.isfolder) srcNames[String(e.fileid)] = e.name;
          } catch (e) { row.note = 'could not read the source folder'; }
          if (srcNames) {
            for (const it of b.items || []) {
              if (!srcNames[String(it.fileid)]) row.missing_sources.push(it.name || String(it.fileid));
            }
          }

          // The destination, listed exactly as processItem lists it.
          let destNames = [];
          try {
            const de = await pc.listFolder(dest);
            row.dest_exists = true;
            destNames = de.filter(e => !e.isfolder).map(e => e.name);
          } catch (e) { row.dest_exists = false; }

          const skipMode = (job.on_existing || 'skip') === 'skip';
          for (const it of b.items || []) {
            for (const o of b.outputs || []) {
              for (const h of o.rungs || []) {
                const name = P.outputName(it.name, h, o.codec);
                const dests = orch.destinationsFor(o, h);
                row.outputs++;
                let allPresent = dests.length > 0;
                for (const dd of dests) {
                  if (dd === 'pcloud') {
                    if (destNames.indexOf(name) === -1) allPresent = false;
                  } else if (dd === 'vimeo') {
                    let prior = null;
                    try { prior = R ? R.findDelivery(it.name, o.codec, h, 'vimeo') : null; }
                    catch (e2) { prior = null; }
                    if (!prior || !prior.vimeo_uri) allPresent = false;
                    else out.totals.vimeo_unchecked++;
                  } else allPresent = false;
                }
                if (skipMode && allPresent) row.present.push(name);
                else {
                  row.todo++;
                  if (o.codec === 'h264' && Number(h) === 1080) row.top_rung_likely_linked++;
                }
              }
            }
          }
          if (R) { try { R.close(); R = require('/root/build/lib/record.js'); } catch (e3) {} }

          if (row.top_rung_likely_linked && row.todo === row.top_rung_likely_linked) {
            row.note = (row.note ? row.note + '. ' : '') +
              row.top_rung_likely_linked + ' output(s) still to make - everything else is ' +
              'already delivered. They are 1080p H.264: a REAL ENCODE as of 2026-08-23, and ' +
              'the most expensive rung in the ladder.';
          } else if (row.top_rung_likely_linked) {
            row.note = (row.note ? row.note + '. ' : '') +
              row.top_rung_likely_linked + ' of the outstanding output(s) are 1080p H.264 - ' +
              'the most expensive rung in the ladder.';
          }
          out.totals.top_rung_likely_linked =
            (out.totals.top_rung_likely_linked || 0) + row.top_rung_likely_linked;
          out.totals.films += row.films;
          out.totals.missing_sources += row.missing_sources.length;
          out.totals.outputs += row.outputs;
          out.totals.present += row.present.length;
          out.totals.todo += row.todo;
          out.batches.push(row);
        }
        out.skip_mode = (job.on_existing || 'skip') === 'skip';
        try { if (R) R.close(); } catch (e) {}
        return res.end(JSON.stringify(out));
      } catch (e) {
        try { if (R) R.close(); } catch (e2) {}
        return res.end(JSON.stringify({ ok: false,
          error: pc.redact(String(e.message)).slice(0, 200) }));
      }
    });
    return;
  }

  // ---- MAKE A FOLDER ------------------------------------------------------
  // Dr. K builds a job standing in the master folder, and the destination he
  // wants often does not exist yet - "ABTC2026 JMDs" beside "encodes", or
  // "hevc" for the 2027 ladder. Creating it from the browser is one step where
  // leaving the panel would be several.
  //
  // GUARDED HARD, because this is the second WRITE surface on this box and the
  // first one that creates something at a vendor. A name with a slash in it
  // would silently make a nested tree; a name with a leading dot or a traversal
  // would land somewhere nobody chose.
  if (req.url === '/api/folder/new') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      let j;
      try { j = JSON.parse(body || '{}'); }
      catch (e) { return res.end(JSON.stringify({ ok: false, error: 'could not read the request' })); }
      const parent = String(j.parent || '').trim();
      const name = String(j.name || '').trim();
      if (!parent || parent.charAt(0) !== '/')
        return res.end(JSON.stringify({ ok: false, error: 'no parent folder given' }));
      if (!name)
        return res.end(JSON.stringify({ ok: false, error: 'the folder needs a name' }));
      if (name.length > 80)
        return res.end(JSON.stringify({ ok: false, error: 'that name is too long' }));
      if (/[\/\\]/.test(name))
        return res.end(JSON.stringify({ ok: false, error: 'a folder name cannot contain a slash' }));
      if (name === '.' || name === '..' || name.charAt(0) === '.')
        return res.end(JSON.stringify({ ok: false, error: 'a folder name cannot start with a dot' }));
      if (/["'*?<>|]/.test(name))
        return res.end(JSON.stringify({ ok: false, error: 'that name has characters pCloud will not accept' }));
      const full = (parent === '/' ? '' : parent) + '/' + name;
      const pc = require('/root/build/lib/pcloud.js');
      return pc.createFolderIfNotExists(full).then(function (r) {
        st.event({ kind: 'folder_created', path: full, created: !!(r && r.created) });
        return res.end(JSON.stringify({ ok: true, path: full, name: name,
          created: !!(r && r.created),
          message: (r && r.created) ? 'Created.' : 'That folder already existed - using it.' }));
      }).catch(function (e) {
        return res.end(JSON.stringify({ ok: false,
          error: pc.redact(String(e.message)).slice(0, 200) }));
      });
    });
    return;
  }

  // ---- HELD JOBS ----------------------------------------------------------
  if (req.url === '/api/held') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    try {
      const dir = '/var/lib/sdvp-encoder/held';
      // ESTIMATE EACH HELD JOB, AND THE QUEUE AS A WHOLE. Dr. K: the figure
      // decides whether he is loading one night or three days, and that
      // decision is made BEFORE anything is released - so it has to be here,
      // on the waiting list, not only inside the review modal.
      // The sizes are already in the job file; this endpoint was opening each
      // one and reporting only a count.
      const E = require('/root/build/lib/estimate.js');
      const RT = E.rates();
      let qTotal = 0, qAny = false;
      const out = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const films = (j.batches || []).reduce((n, b) => n + ((b.items || []).length), 0);
        let est = null;
        try {
          const fl = [];
          for (const b of j.batches || []) {
            const rungs = [];
            for (const o of b.outputs || []) {
              for (const h of o.rungs || []) rungs.push({ codec: o.codec, height: h });
            }
            for (const it of b.items || []) {
              fl.push({ bytes: it.bytes || 0, rungs: rungs });
            }
          }
          // A job whose films carry no size cannot be estimated honestly.
          // Hand-written job files have no bytes; panel-built ones always do.
          if (fl.length && fl.every(x => x.bytes > 0)) {
            const e = E.estimate(fl, RT);
            if (e.seconds > 0) {
              est = { seconds: e.seconds, words: E.words(e.seconds), range: E.range(e),
                      modelled: !!e.modelled };
              qTotal += e.seconds; qAny = true;
            }
          }
        } catch (e2) { est = null; }
        return { file: f, label: j.job_label, built_at: j.built_at || null,
                 batches: (j.batches || []).length, films: films,
                 job_uid: j.job_uid || null, estimate: est };
      }).sort((a, b) => String(a.built_at).localeCompare(String(b.built_at)));
      const queue = qAny ? { seconds: qTotal, words: E.words(qTotal),
                             range: E.range({ low: qTotal * 0.85, high: qTotal * 1.25 }) } : null;
      return res.end(JSON.stringify({ ok: true, held: out, queue: queue }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // ---- WRITE A JOB --------------------------------------------------------
  // The first WRITE surface on this box. Everything else reads.
  //
  // TWO GUARDS, both here rather than in the page, because a guard in the page
  // protects only the tab it runs in:
  //  1. VALIDATION - the daemon refuses to write a job it could not run.
  //     A file that parses but names a preset that does not exist fails at the
  //     first film, hours after the operator walked away.
  //  2. IDEMPOTENCE - the panel stamps each job with a uid. A second write
  //     carrying a uid already seen is REFUSED. A double-click, or a second
  //     browser tab, cannot queue thirty hours of duplicate encoding.
  //
  // Written atomically: temp name, then rename. A crash mid-write leaves no
  // half-file for the scanner to pick up.
  if (req.url === '/api/job' || req.url === '/api/job/hold') {
    const hold = req.url === '/api/job/hold';
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      let job;
      try { job = JSON.parse(body); }
      catch (e) { return res.end(JSON.stringify({ ok: false, error: 'could not read the job' })); }

      const problems = [];
      if (Number(job.job_file_version) !== 3) problems.push('job_file_version must be 3');
      if (!job.job_label || !String(job.job_label).trim()) problems.push('the job needs a name');
      if (!job.job_uid) problems.push('missing job identifier');
      const batches = job.batches || [];
      if (!batches.length) problems.push('the job has no batches');
      batches.forEach(function (b, bi) {
        const where = 'batch ' + (bi + 1) + (b.label ? ' (' + b.label + ')' : '');
        if (!b.source_path) problems.push(where + ' has no source folder');
        // THE DESTINATION OVERRIDE. buildRun uses it verbatim, so a typo here
        // does not fail - it delivers a show to a folder nobody chose, or makes
        // one under a misspelt name. It is refused at the door instead.
        if (b.dest_path_override != null) {
          const dp = String(b.dest_path_override);
          if (!dp.trim()) problems.push(where + ': the destination folder is empty');
          else if (dp.charAt(0) !== '/') problems.push(where + ': the destination must start at the top');
          else if (dp.indexOf('..') !== -1) problems.push(where + ': that destination is not a real path');
          else if (dp.length > 400) problems.push(where + ': that destination is too long');
        }
        if (!(b.items || []).length) problems.push(where + ' has no files selected');
        (b.items || []).forEach(function (it) {
          if (!it.fileid) problems.push(where + ': "' + (it.name || '?') + '" has no file id');
        });
        if (!(b.outputs || []).length) problems.push(where + ' has no outputs');
        (b.outputs || []).forEach(function (o) {
          let ps = null;
          try { ps = JSON.parse(fs.readFileSync('/root/build/presets/' + o.preset + '.json', 'utf8')); }
          catch (e) { problems.push(where + ': preset "' + o.preset + '" does not exist'); return; }
          const have = (ps.rungs || []).map(r => Number(r.height));
          if (!(o.rungs || []).length) problems.push(where + ': ' + o.preset + ' has no rungs chosen');
          (o.rungs || []).forEach(function (h) {
            if (have.indexOf(Number(h)) === -1)
              problems.push(where + ': ' + o.preset + ' has no ' + h + 'p rung');
          });
          if (!(o.destinations || []).length)
            problems.push(where + ': ' + o.preset + ' has no destination');
          (o.destinations || []).forEach(function (d) {
            if (d !== 'pcloud' && d !== 'vimeo')
              problems.push(where + ': "' + d + '" is not a destination');
          });
        });
      });
      if (problems.length) {
        return res.end(JSON.stringify({ ok: false, problems: problems }));
      }

      // Has this exact job already been written? Check both folders.
      const qdir = path.join(st.ROOT, 'jobs'), hdir = path.join(st.ROOT, 'held');
      for (const dir of [qdir, hdir]) {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.json(\.accepted)?$/.test(f)) continue;
          try {
            const prev = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (prev.job_uid && prev.job_uid === job.job_uid) {
              return res.end(JSON.stringify({ ok: false, duplicate: true,
                error: 'That job was already sent. Nothing was queued twice.' }));
            }
          } catch (e) { /* unreadable file is not a duplicate */ }
        }
      }

      job.built_at = new Date().toISOString();
      const slug = String(job.job_label).replace(/[^A-Za-z0-9]+/g, '-')
                     .replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
      const stamp = job.built_at.replace(/[-:]/g, '').replace(/\..+$/, '');
      const name = stamp + '_' + slug + '.json';
      const dest = path.join(hold ? hdir : qdir, name);
      try {
        const tmp = dest + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n');
        fs.renameSync(tmp, dest);
      } catch (e) {
        return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
      }
      const films = batches.reduce((n, b) => n + (b.items || []).length, 0);
      st.event({ kind: hold ? 'job_held' : 'job_queued', file: dest,
                 label: job.job_label, films: films });
      return res.end(JSON.stringify({ ok: true, held: hold, file: name, films: films,
        message: hold ? ('Held. ' + films + ' file(s) waiting to be released.')
                      : ('Queued. ' + films + ' file(s) — the encoder starts within seconds.') }));
    });
    return;
  }

  // ---- READ ONE HELD JOB BACK ---------------------------------------------
  // So the panel can load it into the builder, change it, and send it again.
  // Editing replaces rather than adds: the panel discards the old file after a
  // successful write, so two near-identical held jobs can never accumulate and
  // leave the operator guessing which one is current.
  if (req.url.indexOf('/api/held/get/') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const raw = decodeURIComponent(req.url.split('/').pop().split('?')[0]);
    if (!/^[0-9A-Za-z_.-]+\.json$/.test(raw) || raw.indexOf('..') !== -1) {
      return res.end(JSON.stringify({ ok: false, error: 'bad job name' }));
    }
    const f = path.join(st.ROOT, 'held', raw);
    if (!fs.existsSync(f)) {
      return res.end(JSON.stringify({ ok: false, error: 'that job is no longer held' }));
    }
    try {
      return res.end(JSON.stringify({ ok: true, file: raw,
                                      job: JSON.parse(fs.readFileSync(f, 'utf8')) }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // ---- RELEASE OR DISCARD A HELD JOB --------------------------------------
  // Release MOVES the file into the queue - it does not copy it, so the job
  // cannot exist in both places and be run twice. Rename is atomic on the same
  // filesystem, so there is no window where the scanner sees a partial file.
  //
  // The queued name keeps the ORIGINAL build timestamp, so several jobs
  // released together run in the order they were BUILT, not alphabetically by
  // label. Dr. K's JMDs-before-MOVIES case depends on that.
  //
  // The filename is taken apart and rebuilt from its own basename: nothing the
  // caller sends can point outside the held folder.
  // ---- QUEUED JOBS ------------------------------------------------------
  // Jobs SENT but not yet started: plain .json in the queue folder. Intake
  // renames to .accepted the moment it takes one, so the presence of the
  // plain name IS the definition of "not started" - no separate state needed.
  // ⚠ Intake is ALPHABETICAL (readdirSync().sort(), files[0]), not by the time
  // a job was queued. The order below is the order they will actually run.
  if (req.url === '/api/queued') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    try {
      const dir = path.join(st.ROOT, 'jobs');
      const out = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(function (f) {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { j = null; }
        const films = j ? (j.batches || []).reduce((n, b) => n + ((b.items || []).length), 0) : null;
        return { file: f,
                 label: (j && j.job_label) || f,
                 films: films,
                 batches: j ? (j.batches || []).length : null,
                 built_at: (j && j.built_at) || null,
                 unreadable: !j };
      });
      return res.end(JSON.stringify({ ok: true, queued: out }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // ---- HOLD A QUEUED JOB ------------------------------------------------
  // The inverse of /api/held/release/. A job that has not started goes back to
  // staging, where it can be reviewed, edited or re-released.
  // ⛔ THE RACE IS REAL AND IS NOT PAPERED OVER. Intake polls every 3 seconds,
  // so a job can be taken between the click and this call. If the plain .json
  // is gone the job STARTED - say so plainly rather than reporting a success
  // that did not happen. There is no un-starting; that is what STOP is for.
  if (req.url.indexOf('/api/job/unqueue/') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const raw = decodeURIComponent(req.url.split('/').pop().split('?')[0]);
    if (!/^[0-9A-Za-z_.-]+\.json$/.test(raw) || raw.indexOf('..') !== -1) {
      return res.end(JSON.stringify({ ok: false, error: 'bad job name' }));
    }
    const from = path.join(st.ROOT, 'jobs', raw);
    const to = path.join(st.ROOT, 'held', raw);
    if (!fs.existsSync(from)) {
      const started = fs.existsSync(from + '.accepted');
      return res.end(JSON.stringify({ ok: false, started: started,
        error: started ? 'That job has already started - it was taken from the queue before this reached the encoder. Use STOP to halt it after the film in flight.'
                       : 'That job is no longer queued.' }));
    }
    if (fs.existsSync(to)) {
      return res.end(JSON.stringify({ ok: false, error: 'a job by that name is already in staging' }));
    }
    try {
      fs.renameSync(from, to);
      st.event({ kind: 'job_unqueued', file: raw });
      return res.end(JSON.stringify({ ok: true, held: true,
        message: 'Back in staging. Nothing was lost - review, edit or release it again.' }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  if (req.url.indexOf('/api/held/release/') === 0 ||
      req.url.indexOf('/api/held/discard/') === 0) {
    const release = req.url.indexOf('/api/held/release/') === 0;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const raw = decodeURIComponent(req.url.split('/').pop().split('?')[0]);
    if (!/^[0-9A-Za-z_.-]+\.json$/.test(raw) || raw.indexOf('..') !== -1) {
      return res.end(JSON.stringify({ ok: false, error: 'bad job name' }));
    }
    const from = path.join(st.ROOT, 'held', raw);
    if (!fs.existsSync(from)) {
      return res.end(JSON.stringify({ ok: false, error: 'that job is no longer held' }));
    }
    try {
      if (!release) {
        fs.unlinkSync(from);
        st.event({ kind: 'job_discarded', file: raw });
        return res.end(JSON.stringify({ ok: true, discarded: true,
                                        message: 'Discarded.' }));
      }
      const to = path.join(st.ROOT, 'jobs', raw);
      if (fs.existsSync(to)) {
        return res.end(JSON.stringify({ ok: false,
          error: 'a job by that name is already queued' }));
      }
      fs.renameSync(from, to);
      st.event({ kind: 'job_released', file: raw });
      return res.end(JSON.stringify({ ok: true, released: true,
        message: 'Released to the queue. The encoder starts within seconds.' }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // ---- STOP AND ABORT ---------------------------------------------------
  // TWO STATES, Dr. K's ruling 2026-08-20:
  //   STOP  - the run is correctly configured and the film in flight is fine.
  //           Finish it completely, then halt. Nothing downstream starts.
  //   ABORT - something is wrong with the master or the configuration. Stop
  //           everything now. Implemented by killing the daemon, because the
  //           encoder holds its ffmpeg child privately and nothing can signal
  //           it from outside. Recovery then reads the flag and REFUSES to
  //           re-queue - which is the whole difference from a crash.
  //
  // AN UPLOAD IN FLIGHT ALWAYS COMPLETES, whichever button is pressed.
  // A truncated file at pCloud would sit in the destination folder under the
  // correct name, and a later run's existence check would read that name and
  // skip the film - shipping a broken file believing it fine. Enforced here
  // by REFUSING the abort, not by trusting the operator to remember.
  // NOTHING IS EVER DELETED AT A DESTINATION. Dr. K's ruling, absolute.
  //
  // There is NO CONTINUE. A stopped run is re-made as a fresh job, because a
  // resumable run is a run that resumes with the wrong configuration intact.
  // PAUSE is STOP plus the job file going back to staging, so the SAME job
  // can be released again. Not a mid-film suspend - the film in flight always
  // finishes. On resume the finished films are skipped by the cheap existence
  // check, which is what makes this cheap rather than a re-run.
  if (req.url === '/api/stop' || req.url === '/api/abort' || req.url === '/api/pause') {
    const abort = req.url === '/api/abort';
    const pause = req.url === '/api/pause';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const run = (state.runs || [])[0];
    if (!run || run.finished_at) {
      return res.end(JSON.stringify({ ok: false, error: 'no run is in flight' }));
    }
    const inFlight = (run.items || []).find(i => i.phase === 'UPLOADING');
    if (abort && inFlight) {
      return res.end(JSON.stringify({ ok: false, uploading: true,
        error: 'An upload is in flight for ' + (inFlight.name || 'a file') +
               '. Aborting now could leave a truncated file at the destination ' +
               'under the right name, which a later run would trust. Press STOP ' +
               'instead - it lets this upload finish, then halts.' }));
    }
    state.stop_requested = { mode: abort ? 'ABORT' : (pause ? 'PAUSE' : 'STOP'),
                             at: new Date().toISOString(),
                             run_number: run.run_number };
    save({ force: true });
    if (abort) {
      setTimeout(function () { console.log('ABORT requested - exiting'); process.exit(1); }, 400);
      return res.end(JSON.stringify({ ok: true, mode: 'ABORT',
        message: 'Aborting now. The daemon will stop and will not resume this job.' }));
    }
    if (pause) {
      return res.end(JSON.stringify({ ok: true, mode: 'PAUSE',
        message: 'Pausing. The film being encoded finishes and is delivered, then the job goes back to staging. Release it again and the films already made are skipped.' }));
    }
    return res.end(JSON.stringify({ ok: true, mode: 'STOP',
      message: 'Stopping after the current file finishes. Nothing further will start.' }));
  }

  // VERDICT, computed in ONE place and read by BOTH surfaces. The button and
  // the report cannot disagree because they do not each decide.
  //
  // THE RATCHET (Dr. K, 2026-08-20): a FINDING sticks for the life of the run.
  // A finding is a fact about a file that was already processed - a failed
  // rung, an unconfirmed delivery, a bad or missing measurement, a retry, a
  // retained scratch directory. Those rows stay amber or red no matter what
  // the remaining movies do, and they are sticky BY CONSTRUCTION: the record
  // keeps the row, so the query still finds it at movie 16.
  // INCOMPLETENESS is not a finding. "Still mid-phase" is amber at movie 3
  // because 13 have not started; it must clear as they finish, or every run
  // reads amber from its first minute and the colour stops meaning anything.
  function runVerdict(R, rid) {
    const q1 = (s, p) => R.query(s, p)[0] || {};
    // ⛔ A FILM HALTED BY THE OPERATOR IS NOT A FAILED FILM. [MEASURED
    // 2026-08-21] runs 22, 28 and 34 all read FAIL for the single reason that
    // a button was pressed; run 23 read PASS only because its film happened to
    // finish before the stop landed. The colour was an accident of timing.
    // Red is for work that did not happen. A deliberate halt is a decision,
    // and teaching the reader to discount red is the one thing a report must
    // never do - the same principle that made a stopped run read STOPPED
    // rather than COMPLETE_WITH_FAILURES.
    // A film that failed for a REAL reason inside a halted run still counts.
    const f = q1('SELECT ' +
      "SUM(CASE WHEN m.phase='FAILED' " +
      "         AND (m.error IS NULL OR m.error NOT LIKE '%by operator%') " +
      '         THEN 1 ELSE 0 END) AS mv_failed, ' +
      "SUM(CASE WHEN m.phase='FAILED' " +
      "         AND m.error LIKE '%by operator%' THEN 1 ELSE 0 END) AS mv_halted, " +
      "SUM(CASE WHEN m.error IS NOT NULL AND m.error<>'' THEN 1 ELSE 0 END) AS mv_err " +
      'FROM movies m WHERE m.run_id=?', [rid]);
    const r = q1('SELECT ' +
      "SUM(CASE WHEN r.state='FAILED' THEN 1 ELSE 0 END) AS rung_failed " +
      'FROM rungs r JOIN movies m ON m.item_id=r.item_id WHERE m.run_id=?', [rid]);
    const d = q1('SELECT ' +
      'SUM(CASE WHEN d.ok IS NOT 1 THEN 1 ELSE 0 END) AS not_ok, ' +
      'SUM(CASE WHEN d.attempts > 1 THEN 1 ELSE 0 END) AS retried, ' +
      // PENDING is an unanswered question, not a bad answer, and scores CHECK.
      // A MISMATCH or FAILED verdict is a bad answer and scores FAIL.
      // [MEASURED 2026-08-20] run 10 carried a PENDING mezzanine that had been
      // fine all along - 0.44 s drift against a 2 s tolerance, upload and
      // transcode both complete. Scoring it FAIL would have left a permanent
      // red on a file nothing was ever wrong with.
      "SUM(CASE WHEN d.destination='vimeo' AND d.witness_state IS NOT NULL " +
      "         AND d.witness_state NOT IN ('VERIFIED','PENDING') " +
      '         THEN 1 ELSE 0 END) AS wit_bad, ' +
      "SUM(CASE WHEN d.destination='vimeo' AND d.witness_state='PENDING' " +
      '         THEN 1 ELSE 0 END) AS wit_pending, ' +
      "SUM(CASE WHEN d.destination='vimeo' AND d.witness_drift_s IS NULL " +
      '         THEN 1 ELSE 0 END) AS wit_nodrift ' +
      'FROM deliveries d JOIN rungs r ON r.rung_id=d.rung_id ' +
      'JOIN movies m ON m.item_id=r.item_id WHERE m.run_id=?', [rid]);
    // ⛔ THE OLD-PROBE DISCRIMINATOR IS SILENCE, NOT FLAT FACTOR (Dr. K's ruling
    // 2026-08-21). flat_max was the marker until the parser learned to read
    // -Infinity, which SQLite cannot store - so a PERFECTLY FLAT channel now
    // lands as NULL in flat_max, indistinguishable from "never measured". A
    // real finding would have been filed as an untrustworthy old row. No row
    // written before 2026-08-21 can carry silence_n; every row after does.
    const a = q1('SELECT ' +
      'SUM(CASE WHEN q.audio_ok=0 THEN 1 ELSE 0 END) AS aud_failed, ' +
      'SUM(CASE WHEN q.audio_ok IS NOT NULL AND q.flat_max IS NULL ' +
      '         AND q.silence_n IS NULL THEN 1 ELSE 0 END) AS aud_old ' +
      'FROM quality q JOIN movies m ON m.item_id=q.item_id WHERE m.run_id=?', [rid]);
    // RETAINED SCRATCH. [MEASURED 2026-08-21] runVerdict named movies, rungs,
    // deliveries and quality - and nothing at all about scratch, so a run with
    // 16 GB of abandoned working files read PASS. Retention is deliberate on a
    // FAILED film, but it is proportional to failures and grows unwatched.
    const sc = q1('SELECT COUNT(*) AS n FROM movies ' +
      'WHERE run_id=? AND scratch_path IS NOT NULL', [rid]);
    // Duplicate audio readings across DIFFERENT movies. Two movies of unequal
    // length cannot measure identically; this is what caught the probe defect.
    const dup = q1('SELECT COUNT(*) AS n FROM (' +
      'SELECT q.rms_min_db, q.rms_max_db FROM quality q ' +
      'JOIN movies m ON m.item_id=q.item_id ' +
      'WHERE m.run_id=? AND q.rms_max_db IS NOT NULL ' +
      'GROUP BY q.rms_min_db, q.rms_max_db HAVING COUNT(*) > 1)', [rid]);

    const num = v => Number(v || 0);
    const findings = [];

    // RUN-LEVEL TRUTH. The run's own status word is evidence, and until now
    // nothing read it. [MEASURED 2026-08-22] Run 38 carried
    // COMPLETE_WITH_FAILURES in the header of the very report being scored and
    // still scored PASS - because a film that fails by a THROWN error is never
    // written to the record at all. Every per-film query below then asks about
    // a set that never contained it, and comes back honestly green. The status
    // word was the only place the failure landed.
    const runRow = q1('SELECT status, job_file FROM runs WHERE run_id=?', [rid]);
    if (String(runRow.status || '') === 'COMPLETE_WITH_FAILURES') {
      findings.push({ k: 'run ended with failures', n: 1, sev: 'FAIL' });
    }
    // THE JOB IS THE ONLY LIST OF WHAT WAS ATTEMPTED; the record holds what
    // survived. Comparing the two is the one check that does not need to know
    // HOW a film was lost, so it covers paths nobody has thought of yet.
    // Dr. K's ruling 2026-08-22: CHECK, amber. A missing row is a bookkeeping
    // loss; the run's own status carries the severity.
    let jobN = null;
    try {
      const jd = JSON.parse(fs.readFileSync(runRow.job_file, 'utf8'));
      jobN = (jd.batches || []).reduce(function (a, b) {
        return a + ((b.items || []).length); }, 0);
    } catch (e) { jobN = null; }
    if (jobN !== null) {
      const recN = num(q1('SELECT COUNT(*) AS c FROM movies WHERE run_id=?', [rid]).c);
      if (jobN > recN) {
        findings.push({ k: 'films in job, not in record', n: jobN - recN, sev: 'CHECK' });
      }
    }
    if (num(f.mv_failed))     findings.push({ k: 'movie failed',        n: num(f.mv_failed),     sev: 'FAIL' });
    // CHECK, not FAIL - and it still appears, so a halted run is never silently
    // green. It says what happened: you stopped it.
    if (num(f.mv_halted))     findings.push({ k: 'halted by operator',  n: num(f.mv_halted),     sev: 'CHECK' });
    if (num(r.rung_failed))   findings.push({ k: 'rung failed',         n: num(r.rung_failed),   sev: 'FAIL' });
    if (num(d.not_ok))        findings.push({ k: 'delivery unconfirmed',n: num(d.not_ok),        sev: 'FAIL' });
    if (num(d.wit_bad))       findings.push({ k: 'vimeo not verified',  n: num(d.wit_bad),       sev: 'FAIL' });
    if (num(d.wit_pending))   findings.push({ k: 'vimeo never answered', n: num(d.wit_pending),   sev: 'CHECK' });
    // ⛔ CHECK, NOT FAIL. Dr. K's ruling 2026-08-21: the film SHIPS and a human
    // looks at it. The encode is not wrong - the master is - and red is for
    // work that did not happen. This finding is now the ONLY road an audio
    // fault travels, since it no longer fails the rung.
    if (num(a.aud_failed))    findings.push({ k: 'audio wants a look',  n: num(a.aud_failed),    sev: 'CHECK' });
    if (num(sc.n))            findings.push({ k: 'scratch retained',    n: num(sc.n),            sev: 'CHECK' });
    if (num(dup.n))           findings.push({ k: 'duplicate audio',     n: num(dup.n),           sev: 'CHECK' });
    if (num(d.wit_nodrift))   findings.push({ k: 'no drift figure',     n: num(d.wit_nodrift),   sev: 'CHECK' });
    if (num(a.aud_old))       findings.push({ k: 'old audio probe',     n: num(a.aud_old),       sev: 'CHECK' });
    if (num(d.retried))       findings.push({ k: 'upload retried',      n: num(d.retried),       sev: 'CHECK' });

    let verdict = 'PASS';
    if (findings.some(x => x.sev === 'CHECK')) verdict = 'CHECK';
    if (findings.some(x => x.sev === 'FAIL'))  verdict = 'FAIL';
    // REMEDIATION LIVES WITH THE FINDING, not in the page. Dr. K's standing
    // requirement is that every row names what to do about it, written for 1 AM.
    // Keeping the text HERE means a finding added to this function arrives
    // complete in every surface that renders it - which is the defect measured
    // 2026-08-22, when the button and the report body each decided separately
    // and the report body never learned about two new findings.
    const FIX = {
      "movie failed": "This film did not finish. Its working files were kept - the working-files row below names the path. Fix the cause and re-run the film.",
      "halted by operator": "You stopped this run. Films that never started were never encoded and are NOT at the destination. Rebuild a job for them when ready.",
      "rung failed": "An output failed encoding or verification. The rungs row names the height. Nothing was delivered for it, so that height is missing at the destination.",
      "delivery unconfirmed": "The destination never confirmed a file we sent. Treat that height as NOT delivered and list the destination folder yourself before assuming it arrived.",
      "vimeo not verified": "Vimeo answered and its answer disagrees with what we sent. Open the video at Vimeo and compare its length against the master before re-uploading.",
      "vimeo never answered": "Vimeo had not finished transcoding when we asked. Usually fine - re-open this report later. Still unanswered tomorrow means go and look at Vimeo.",
      "audio wants a look": "The audio measured outside the normal band. The film SHIPPED and the encode is not wrong - listen to the master before this goes to a customer.",
      "scratch retained": "Working files were kept on the box because a film failed. Nothing deletes them automatically. The working-files row has the paths.",
      "duplicate audio": "Two films of different lengths measured identically, which cannot happen. Suspect the measuring code, not the films.",
      "no drift figure": "Checked by code that discarded the length comparison. The verdict stands; the evidence behind it does not. Fixed 20 Aug - later runs carry the figure.",
      "old audio probe": "Measured before the audio probe was fixed on 21 Aug. Not a fault, just not trustworthy. Ignore the audio numbers for this run.",
      "upload retried": "An upload needed more than one attempt. It succeeded, but a destination that needs retries is worth watching.",
      "run ended with failures": "The daemon recorded a failure during this run. Every row below may still read clean - a film that fails by a thrown error is never written to the record at all. Compare the job list against the films shown here.",
      "films in job, not in record": "The job listed more films than the record holds. The missing film failed in a way that left no row - its name is in the daemon own memory, on the run card. It is NOT at the destination and must be re-run."
    };
    for (const x of findings) { x.fix = FIX[x.k] || null; }
    return { verdict: verdict, findings: findings };
  }

  // VERDICT FOR EVERY RUN AT ONCE - one database open, whatever the run count.
  if (req.url === '/api/verdicts') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    let R = null;
    try {
      R = require('/root/build/lib/record.js');
      const out = {};
      for (const run of R.query('SELECT run_id, run_number, status, finished_at FROM runs', [])) {
        const v = runVerdict(R, run.run_id);
        out[run.run_number] = { verdict: v.verdict, findings: v.findings,
                                status: run.status, finished: !!run.finished_at };
      }
      R.close();
      return res.end(JSON.stringify({ ok: true, verdicts: out }));
    } catch (e) {
      try { if (R) R.close(); } catch (e2) {}
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  // RUN REPORT. Reads the RECORD, not memory - the two disagreeing is the
  // whole reason this exists. MEASURED 2026-08-20: run 13 read COMPLETE in
  // memory and RUNNING in the record; two movies read DONE in memory and
  // UPLOADING in the record. A report drawn from memory alone would have
  // shown a confident green.
  // Read-only, closed after every request, and it refuses rather than throws.
  if (req.url.indexOf('/api/report/') === 0) {
    const runNum = Number(decodeURIComponent(req.url.slice(12).split('?')[0]));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (!isFinite(runNum) || runNum <= 0) {
      return res.end(JSON.stringify({ ok: false, error: 'bad run number' }));
    }
    let R = null;
    try {
      R = require('/root/build/lib/record.js');
      const run = R.query('SELECT * FROM runs WHERE run_number = ?', [runNum])[0];
      if (!run) {
        R.close();
        return res.end(JSON.stringify({ ok: false, error: 'run ' + runNum + ' not in record' }));
      }
      const rid = run.run_id;
      const out = {
        ok: true,
        run: run,
        items_by_phase: R.query(
          'SELECT phase, COUNT(*) AS cnt FROM movies WHERE run_id=? GROUP BY phase', [rid]),
        items_with_error: R.query(
          "SELECT source_name, phase, error FROM movies WHERE run_id=? AND error IS NOT NULL AND error<>''", [rid]),
        rungs_by_state: R.query(
          'SELECT r.codec, r.height, r.state, COUNT(*) AS cnt FROM rungs r ' +
          'JOIN movies m ON m.item_id=r.item_id WHERE m.run_id=? ' +
          'GROUP BY r.codec, r.height, r.state', [rid]),
        deliveries: R.query(
          'SELECT d.destination, d.ok, d.witness_state, COUNT(*) AS cnt FROM deliveries d ' +
          'JOIN rungs r ON r.rung_id=d.rung_id JOIN movies m ON m.item_id=r.item_id ' +
          'WHERE m.run_id=? GROUP BY d.destination, d.ok, d.witness_state', [rid]),
        deliveries_dirty: R.query(
          'SELECT m.source_name, d.destination, d.ok, d.attempts, d.witness_state, ' +
          'd.witness_drift_s, d.error FROM deliveries d JOIN rungs r ON r.rung_id=d.rung_id ' +
          'JOIN movies m ON m.item_id=r.item_id WHERE m.run_id=? AND ' +
          "(d.ok IS NOT 1 OR d.attempts > 1 OR (d.error IS NOT NULL AND d.error<>''))", [rid]),
        witness: R.query(
          'SELECT COUNT(*) AS n, ' +
          "SUM(CASE WHEN d.witness_state='VERIFIED' THEN 1 ELSE 0 END) AS verified, " +
          'SUM(CASE WHEN d.witness_drift_s IS NULL THEN 1 ELSE 0 END) AS drift_missing, ' +
          'MAX(d.witness_drift_s) AS drift_max FROM deliveries d ' +
          'JOIN rungs r ON r.rung_id=d.rung_id JOIN movies m ON m.item_id=r.item_id ' +
          "WHERE m.run_id=? AND d.destination='vimeo'", [rid]),
        audio: R.query(
          'SELECT COUNT(*) AS n, ' +
          'SUM(CASE WHEN q.audio_ok=1 THEN 1 ELSE 0 END) AS passed, ' +
          'SUM(CASE WHEN q.flat_max IS NULL AND q.silence_n IS NULL ' +
          '         THEN 1 ELSE 0 END) AS unmeasurable, ' +
          'SUM(CASE WHEN q.silence_n IS NULL THEN 1 ELSE 0 END) AS no_silence, ' +
          'MIN(q.rms_min_db) AS rms_min, MAX(q.rms_max_db) AS rms_max, ' +
          'MAX(q.imbalance_db) AS imb_max, MAX(q.flat_max) AS flat_max, ' +
          'SUM(CASE WHEN q.silence_n > 0 THEN 1 ELSE 0 END) AS with_silence, ' +
          'MAX(q.silence_pct) AS silence_pct_max, ' +
          'MAX(q.silence_longest_s) AS silence_longest_s ' +
          'FROM quality q JOIN movies m ON m.item_id=q.item_id WHERE m.run_id=?', [rid]),
        audio_rows: R.query(
          'SELECT m.source_name, q.audio_ok, q.channels, q.peak_max_db, q.rms_min_db, ' +
          'q.rms_max_db, q.imbalance_db, q.flat_max, q.audio_failed, q.sheets_uploaded, ' +
          'q.silence_n, q.silence_total_s, q.silence_pct, q.silence_longest_s, ' +
          'q.silence_longest_at_s, q.silence_ends_at_end ' +
          'FROM quality q JOIN movies m ON m.item_id=q.item_id WHERE m.run_id=? ' +
          'ORDER BY q.silence_pct DESC, q.imbalance_db DESC', [rid]),
        // ARTIFACTS - sheets, audio reports, manifests. Every one carries a
        // pCloud fileid the record used to discard. "ok" is OUR word for it;
        // "confirmed" means the destination answered with an id.
        artifacts: R.query(
          'SELECT a.kind, COUNT(*) AS cnt, ' +
          'SUM(CASE WHEN a.ok=1 THEN 1 ELSE 0 END) AS ok_n, ' +
          'SUM(CASE WHEN a.pcloud_fileid IS NOT NULL THEN 1 ELSE 0 END) AS confirmed, ' +
          'SUM(CASE WHEN a.sha1_verified=1 THEN 1 ELSE 0 END) AS sha1_ok, ' +
          'SUM(COALESCE(a.bytes,0)) AS bytes ' +
          'FROM artifacts a JOIN movies m ON m.item_id=a.item_id ' +
          'WHERE m.run_id=? GROUP BY a.kind ORDER BY a.kind', [rid]),
        artifacts_dirty: R.query(
          'SELECT m.source_name, a.kind, a.codec, a.name, a.ok, a.pcloud_fileid, ' +
          'a.sha1_verified, a.error FROM artifacts a JOIN movies m ON m.item_id=a.item_id ' +
          "WHERE m.run_id=? AND (a.ok IS NOT 1 OR a.pcloud_fileid IS NULL " +
          "OR (a.error IS NOT NULL AND a.error<>''))", [rid]),
        // SCRATCH - the record names the path; the DISK says whether it is
        // still there. Dr. K deletes these by hand in Transmit, so a report
        // reciting the record alone would keep pointing at folders he cleaned.
        scratch: (function () {
          const rows = R.query(
            'SELECT source_name, phase, scratch_path FROM movies ' +
            'WHERE run_id=? AND scratch_path IS NOT NULL', [rid]);
          return rows.map(function (x) {
            let bytes = null, present = false;
            try {
              if (fs.existsSync(x.scratch_path)) {
                present = true;
                bytes = Number(require('child_process')
                  .execFileSync('du', ['-sb', x.scratch_path], { encoding: 'utf8' })
                  .split(/\s+/)[0]) || null;
              }
            } catch (e) { bytes = null; }
            return { source_name: x.source_name, phase: x.phase,
                     path: x.scratch_path, present: present, bytes: bytes };
          });
        })(),
        // Per-movie rung tallies. A movie that owed nothing reads 0 stored and
        // >0 exists; one that did work reads the inverse. [MEASURED 2026-08-20,
        // run 13: 2 and 14, nothing in between.] This is what lets the report
        // say "skipped, already at its destinations" instead of "still mid-phase".
        per_movie: R.query(
          'SELECT m.source_name, m.phase, ' +
          "SUM(CASE WHEN r.state='EXISTS'  THEN 1 ELSE 0 END) AS n_exists, " +
          "SUM(CASE WHEN r.state='STORED'  THEN 1 ELSE 0 END) AS n_stored, " +
          "SUM(CASE WHEN r.state='SKIPPED' THEN 1 ELSE 0 END) AS n_skipped, " +
          "SUM(CASE WHEN r.state='FAILED'  THEN 1 ELSE 0 END) AS n_failed " +
          'FROM movies m LEFT JOIN rungs r ON r.item_id=m.item_id ' +
          'WHERE m.run_id=? GROUP BY m.item_id, m.source_name, m.phase', [rid]),
        bands: R.query(
          'SELECT r.codec, r.height, COUNT(*) AS cnt, MIN(r.pct_of_cap) AS lo, ' +
          'MAX(r.pct_of_cap) AS hi FROM rungs r JOIN movies m ON m.item_id=r.item_id ' +
          'WHERE m.run_id=? AND r.pct_of_cap IS NOT NULL GROUP BY r.codec, r.height', [rid])
      };
      // THE REPORT CARRIES THE VERDICT IT IS SCORED BY. [MEASURED
      // 2026-08-22] The button and the report body each decided separately:
      // run 38 showed a RED button over a report whose every row read green.
      // One decision, rendered twice.
      out.verdict = runVerdict(R, rid);
      R.close();
      return res.end(JSON.stringify(out));
    } catch (e) {
      try { if (R) R.close(); } catch (e2) {}
      return res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
    }
  }

  if (req.url === '/api/state') {
    let body;
    try { body = fs.readFileSync(st.STATE, 'utf8'); }
    catch (e) { body = JSON.stringify(state); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  // The jobs panel. Served the same way as the run card - a file off disk, no
  // framework, no build step. Two pages, two branches.
  if (req.url === '/jobs' || req.url.indexOf('/jobs?') === 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync('/root/build/public/scheduler.html'));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(PAGE));
}).listen(PORT, '0.0.0.0', () => {
  console.log('sdvp-encoder status on port ' + PORT);
});

let busy = false;
async function scan() {
  if (busy) return;
  const files = fs.readdirSync(JOBS).filter(f => f.endsWith('.json')).sort();
  if (!files.length) return;
  busy = true;
  const jp = path.join(JOBS, files[0]);
  const done = jp + '.accepted';
  try {
    fs.renameSync(jp, done);
    st.event({ kind: 'job_start', file: done });
    await orch.runJobFile(done, state, save);
    st.event({ kind: 'job_end', file: done });
  } catch (e) {
    st.event({ kind: 'job_error', file: done, error: String(e.message) });
    console.error('job failed: ' + e.message);
  }
  busy = false;
}
setInterval(scan, 3000);
