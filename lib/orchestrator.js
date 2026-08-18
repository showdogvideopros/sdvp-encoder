'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pc = require('./pcloud.js');
const { probe } = require('./probe.js');
const P = require('./planner.js');
const E = require('./encoder.js');
const V = require('./verifier.js');

const PRESET_DIR = '/root/build/presets';
const SCRATCH_ROOT = '/var/lib/sdvp-encoder/scratch';

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
        bytes: null,
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

async function processItem(item, save) {
  const scratch = path.join(SCRATCH_ROOT, item.item_id);
  fs.mkdirSync(scratch, { recursive: true });
  const outDir = path.join(scratch, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(scratch, 'source.mp4');
  const mark = (p) => { item.phase = p; save({ force: true }); };

  try {
    // ---- FETCH
    mark('FETCHING');
    let t = Date.now();
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
      for (const r of plan.rungs) {
        if (r.state !== 'PLANNED') continue;
        const fname = P.outputName(item.name, r.height, plan.codec);
        if (item.on_existing === 'skip' && existing.indexOf(fname) !== -1) {
          r.state = 'EXISTS';
          r.reason = 'already in destination';
        }
        r.filename = fname;
      }
      plan.preset_name = o.preset || 'h264-standard';
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

    // ---- VERIFY
    mark('VERIFYING');
    for (const out of item.outputs) {
      for (const r of out.rungs) {
        if (r.state !== 'ENCODED') continue;
        const v = await V.verifyRung(r.local, r.height, item.probe.duration_s);
        r.verify = { ok: v.ok, coverage_ok: v.coverage_ok,
                     failed: V.failedNames(v), mbps: v.mbps };
        if (!v.ok) { r.state = 'FAILED'; r.reason = 'verify: ' + V.failedNames(v); }
        else { r.state = 'VERIFIED'; }
        save({ force: true });
      }
    }

    // ---- UPLOAD
    mark('UPLOADING');
    t = Date.now();
    await pc.createFolderIfNotExists(item.dest_path);
    for (const out of item.outputs) {
      for (const r of out.rungs) {
        if (r.state !== 'VERIFIED') continue;
        const localSha = await pc.sha1File(r.local);
        const t2 = Date.now();
        const up = await pc.withRetry('upload ' + r.height,
          () => pc.upload(r.local, item.dest_path, (sent, total) => {
            r.upload_pct = total ? (sent / total) * 100 : 0;
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
        r.state = r.checksum_match ? 'STORED' : 'FAILED';
        if (!r.checksum_match) r.reason = 'checksum mismatch after upload';
        save({ force: true });
      }
    }
    item.timings.upload_s = (Date.now() - t) / 1000;

    // ---- MANIFEST
    const manifest = {
      manifest_version: 1, written_at: nowIso(),
      source: { name: item.name, fileid: item.fileid, bytes: item.bytes },
      rungs: []
    };
    for (const out of item.outputs) {
      for (const r of out.rungs) {
        manifest.rungs.push({ codec: out.codec, preset: out.preset_name,
          height: r.height, state: r.state, filename: r.filename || null,
          bytes: r.bytes || null, fileid: r.stored_fileid || null,
          reason: r.reason || null });
      }
    }
    const mPath = path.join(scratch, 'manifest.json');
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));

    const anyFailed = item.outputs.some(o => o.rungs.some(r => r.state === 'FAILED'));

    // ---- CLEAN (success path only)
    if (!anyFailed) {
      mark('CLEANING');
      fs.rmSync(scratch, { recursive: true, force: true });
      item.scratch_retained = false;
      item.phase = 'DONE';
    } else {
      item.scratch_retained = scratch;
      item.phase = 'FAILED';
      item.error = item.error || 'one or more rungs failed';
    }
    save({ force: true });

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
    state.daemon.current_item = item.item_id;
    save({ force: true });
    await processItem(item, save);
  }

  state.daemon.current_item = null;
  run.finished_at = nowIso();
  run.status = run.items.every(i => i.phase === 'DONE') ? 'COMPLETE' : 'COMPLETE_WITH_FAILURES';
  save({ force: true });
  return run;
}

module.exports = { runJobFile, buildRun, processItem, loadPreset };
