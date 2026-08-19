'use strict';
// VIMEO TRANSPORT — three steps: create the video record, push the bytes by
// tus, move it to a folder. Ported from the SDVP NAS uploader, which has
// carried real mezzanines for a season, with three changes:
//
//  1. A MISSING Upload-Offset HEADER IS A REFUSAL, not an assumption. The
//     original fell back to (offset + chunkSize) when the header was absent,
//     which turns a silent short write into a green upload.
//  2. RETRY WITH REAL RESUME. tus HEAD returns the server's own offset; we
//     restart from THERE, never from zero and never from what we think we sent.
//  3. AN OUTSIDE WITNESS. Vimeo offers no checksum - nothing equivalent to
//     pCloud's sha1. What it does offer is the DURATION it derives by decoding
//     the file itself. A truncated or corrupt upload cannot produce a matching
//     duration. Weaker than a hash, genuinely independent, and labelled as such.
//
// FOLDERS ARE DASHBOARD LABELS ONLY. The video URI is the sole durable handle,
// so it is returned and recorded whatever the folder move does.

const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const API_HOST = 'api.vimeo.com';
const ACCEPT   = 'application/vnd.vimeo.*+json;version=3.4';
const CHUNK    = 64 * 1024 * 1024;
const RETRIES  = 4;
const BACKOFF  = [5000, 30000, 120000, 300000];
const DURATION_TOLERANCE_S = 2.0;

function token() {
  const t = process.env.VIMEO_ACCESS_TOKEN || '';
  if (!t) throw new Error('VIMEO_ACCESS_TOKEN not in environment');
  return t;
}

// Never let a token reach a log line or an error message.
function redact(s) {
  const t = process.env.VIMEO_ACCESS_TOKEN || '';
  let out = String(s);
  if (t) out = out.split(t).join('***');
  return out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
}

function api(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { 'Authorization': 'Bearer ' + token(), 'Accept': ACCEPT };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: API_HOST, path: apiPath,
                                method: method, headers: headers }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = b ? JSON.parse(b) : null; } catch (e) { parsed = null; }
        resolve({ code: res.statusCode, body: parsed, raw: parsed ? null : b.slice(0, 300) });
      });
    });
    req.on('error', e => reject(new Error(redact(e.message))));
    if (payload) req.write(payload);
    req.end();
  });
}

// tus HEAD: ask the server where IT thinks the file is. This is the resume
// primitive and the reason a blip does not cost the whole transfer.
function tusOffset(uploadLink) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadLink);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0', 'Accept': ACCEPT }
    }, res => {
      const h = res.headers['upload-offset'];
      if (h === undefined) {
        return reject(new Error('tus HEAD returned no Upload-Offset - cannot establish position'));
      }
      const n = Number(h);
      if (!isFinite(n) || n < 0) return reject(new Error('tus HEAD offset unreadable: ' + h));
      resolve(n);
    });
    req.on('error', e => reject(new Error(redact(e.message))));
    req.end();
  });
}

function tusPatch(uploadLink, buffer, offset) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadLink);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'PATCH',
      headers: { 'Tus-Resumable': '1.0.0',
                 'Upload-Offset': String(offset),
                 'Content-Type': 'application/offset+octet-stream',
                 'Content-Length': buffer.length }
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error('tus PATCH HTTP ' + res.statusCode + ' ' + redact(b).slice(0, 200)));
        }
        const h = res.headers['upload-offset'];
        // THE CHANGE THAT MATTERS: no header means we do not know where we are.
        if (h === undefined) {
          return reject(new Error('tus PATCH returned no Upload-Offset - position unknown, refusing to assume'));
        }
        const n = Number(h);
        if (!isFinite(n)) return reject(new Error('tus PATCH offset unreadable: ' + h));
        resolve(n);
      });
    });
    req.on('error', e => reject(new Error(redact(e.message))));
    req.setTimeout(0);
    req.write(buffer);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Push the bytes. Resumes from the server's own offset on every attempt.
async function pushBytes(uploadLink, file, size, onProgress) {
  const fd = fs.openSync(file, 'r');
  let attempt = 0;
  try {
    for (;;) {
      try {
        let offset = await tusOffset(uploadLink);
        while (offset < size) {
          const n = Math.min(CHUNK, size - offset);
          const buf = Buffer.alloc(n);
          fs.readSync(fd, buf, 0, n, offset);
          const next = await tusPatch(uploadLink, buf, offset);
          if (next <= offset) {
            throw new Error('tus offset did not advance: ' + offset + ' -> ' + next);
          }
          offset = next;
          if (onProgress) onProgress({ sent: offset, total: size,
                                       pct: (offset / size) * 100 });
        }
        if (offset !== size) {
          throw new Error('final offset ' + offset + ' does not equal size ' + size);
        }
        return { offset: offset, attempts: attempt + 1 };
      } catch (e) {
        attempt++;
        if (attempt > RETRIES) throw new Error(redact(e.message));
        await sleep(BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)]);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// The whole job. Returns the URI and link whatever the folder move does.
async function uploadVideo(opts) {
  const file = opts.file;
  const size = fs.statSync(file).size;
  const name = opts.title || path.parse(file).name;
  const t0 = Date.now();

  const created = await api('POST', '/me/videos', {
    upload: { approach: 'tus', size: size },
    name: name,
    description: opts.description || null,
    privacy: opts.privacy || undefined
  });
  if (created.code >= 400 || !created.body) {
    throw new Error('Vimeo create HTTP ' + created.code + ' ' +
                    redact(created.raw || JSON.stringify(created.body)).slice(0, 200));
  }
  const link = created.body.upload && created.body.upload.upload_link;
  const uri  = created.body.uri;
  if (!link) throw new Error('Vimeo create returned no tus upload link');

  const pushed = await pushBytes(link, file, size, opts.onProgress);
  const wall_s = (Date.now() - t0) / 1000;

  const result = { uri: uri, link: created.body.link, name: name,
                   bytes: size, wall_s: wall_s, attempts: pushed.attempts,
                   mbps: wall_s ? (size * 8) / wall_s / 1e6 : null,
                   folder_moved: false, witness: null };

  if (opts.folderUri && uri) {
    const vid = String(uri).split('/').pop();
    const mv = await api('PUT', opts.folderUri + '/videos/' + vid, null);
    result.folder_moved = (mv.code >= 200 && mv.code < 300);
    result.folder_http = mv.code;
  }
  return result;
}

// THE OUTSIDE WITNESS. Vimeo decodes the file to produce a duration; a
// truncated upload cannot match. Polls because transcoding is not instant.
async function verifyByDuration(uri, expectDurationS, maxWaitS, onNote) {
  const deadline = Date.now() + (maxWaitS || 900) * 1000;
  let last = null;
  for (;;) {
    const r = await api('GET', uri + '?fields=uri,duration,status,upload.status,transcode.status');
    if (r.code >= 400) return { ok: false, reason: 'HTTP ' + r.code, checked: last };
    const b = r.body || {};
    last = { status: b.status,
             upload_status: b.upload && b.upload.status,
             transcode_status: b.transcode && b.transcode.status,
             duration: b.duration };
    if (onNote) onNote(last);
    if (b.duration && b.duration > 0) {
      const drift = Math.abs(b.duration - expectDurationS);
      return { ok: drift <= DURATION_TOLERANCE_S,
               vimeo_duration_s: b.duration,
               expected_duration_s: expectDurationS,
               drift_s: Number(drift.toFixed(2)),
               tolerance_s: DURATION_TOLERANCE_S,
               upload_status: last.upload_status,
               transcode_status: last.transcode_status,
               witness: 'duration' };
    }
    if (Date.now() > deadline) {
      return { ok: false, reason: 'no duration reported before timeout',
               checked: last, witness: 'duration' };
    }
    await sleep(15000);
  }
}

// SINGLE SHOT. Never sleeps, never blocks. One API call, roughly 200 ms.
//
// MEASURED 2026-08-19: duration was reported while transcode was still
// in_progress - we are NOT waiting on Vimeo's encoding ladder, only on their
// ingest reading the file header. A 127 MB file resolved inside 30 s.
//
// Returns state PENDING when no duration exists yet. PENDING IS NOT A PASS:
// it means unresolved, and an unresolved entry must be swept before a run is
// called complete.
async function checkWitnessOnce(uri, expectDurationS) {
  let r;
  try {
    r = await api('GET', uri + '?fields=uri,duration,status,upload.status,transcode.status');
  } catch (e) {
    return { state: 'PENDING', note: redact(e.message).slice(0, 120) };
  }
  if (r.code >= 400) return { state: 'PENDING', note: 'HTTP ' + r.code };
  const b = r.body || {};
  const up = b.upload && b.upload.status;
  const tr = b.transcode && b.transcode.status;
  if (up === 'error') {
    return { state: 'FAILED', reason: 'vimeo reports upload error',
             upload_status: up, transcode_status: tr };
  }
  if (!b.duration || b.duration <= 0) {
    return { state: 'PENDING', upload_status: up, transcode_status: tr };
  }
  const drift = Math.abs(b.duration - expectDurationS);
  return {
    state: drift <= DURATION_TOLERANCE_S ? 'VERIFIED' : 'MISMATCH',
    witness: 'duration',
    vimeo_duration_s: b.duration,
    expected_duration_s: expectDurationS,
    drift_s: Number(drift.toFixed(2)),
    tolerance_s: DURATION_TOLERANCE_S,
    upload_status: up,
    transcode_status: tr
  };
}

// Sweep a list of unresolved entries. Called between items with wait=false
// (free), and once at the end of a run with wait=true (nothing else queued).
async function sweepWitnesses(entries, wait, onNote) {
  const deadline = Date.now() + (wait ? 600000 : 0);
  for (;;) {
    let stillPending = 0;
    for (const e of entries) {
      if (e.witness && (e.witness.state === 'VERIFIED' ||
                        e.witness.state === 'MISMATCH' ||
                        e.witness.state === 'FAILED')) continue;
      e.witness = await checkWitnessOnce(e.uri, e.expected_duration_s);
      if (onNote) onNote(e);
      if (e.witness.state === 'PENDING') stillPending++;
    }
    if (!stillPending || Date.now() >= deadline) {
      return { pending: stillPending, total: entries.length };
    }
    await sleep(15000);
  }
}

module.exports = { uploadVideo, verifyByDuration, checkWitnessOnce, sweepWitnesses,
                   api, redact, tusOffset, CHUNK, RETRIES, DURATION_TOLERANCE_S };
