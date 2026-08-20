'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const HOST  = process.env.PCLOUD_API_HOST || 'api.pcloud.com';
const TOKEN = process.env.PCLOUD_AUTH_TOKEN || '';

// keepAlive agent — from the NAS uploader, proven at line rate
const agent = new https.Agent({ keepAlive: true, maxSockets: 5 });

function redact(s) {
  return String(s).replace(/auth=[^&\s]+/g, 'auth=<REDACTED>');
}

function qs(params) {
  const p = Object.assign({}, params, { auth: TOKEN });
  return Object.entries(p)
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function api(method, params) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: HOST, path: '/' + method + '?' + qs(params), agent },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          let j;
          try { j = JSON.parse(body); }
          catch (e) { return reject(new Error('pCloud parse error from ' + method)); }
          if (j.result) {
            return reject(new Error('pCloud ' + method + ' error ' +
                          j.result + ': ' + (j.error || '')));
          }
          resolve(j);
        });
      });
    req.on('error', e => reject(new Error(redact(e.message))));
    req.setTimeout(60000, () => { req.destroy(new Error('pCloud ' + method + ' timeout')); });
  });
}

async function listFolder(folderPath) {
  const j = await api('listfolder', { path: folderPath });
  // KEEP THE DATES. pCloud returns created and modified on every entry and we
  // were discarding both. The panel lists films newest-first, which is how the
  // work actually arrives - this afternoon's edits at the top.
  // 'hash' is pCloud's own content hash, kept because it is a stronger identity
  // than a filename if we ever need to notice a master was replaced.
  return j.metadata.contents.map(c => ({
    isfolder: !!c.isfolder,
    name: c.name,
    fileid: c.fileid || null,
    folderid: c.folderid || null,
    size: c.size || 0,
    created: c.created || null,
    modified: c.modified || null,
    hash: c.hash || null
  }));
}

async function stat(fileid) {
  const j = await api('stat', { fileid });
  return { name: j.metadata.name, size: j.metadata.size, fileid: j.metadata.fileid };
}

async function createFolderIfNotExists(folderPath) {
  const parts = String(folderPath).split('/').filter(Boolean);
  let acc = '', last = null;
  for (const p of parts) {
    acc += '/' + p;
    const j = await api('createfolderifnotexists', { path: acc });
    last = { folderid: j.metadata.folderid, created: !!j.created, path: acc };
  }
  if (!last) throw new Error('empty folder path');
  return last;
  
  
}

async function checksum(fileid) {
  const j = await api('checksumfile', { fileid });
  return { sha1: j.sha1 || null, md5: j.md5 || null, size: j.metadata ? j.metadata.size : null };
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', c => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// Download to dest. onProgress(bytesDone, bytesTotal). maxBytes for tests only.
async function download(fileid, dest, onProgress, maxBytes) {
  const j = await api('getfilelink', { fileid, forcedownload: 0 });
  const url = 'https://' + j.hosts[0] + j.path;
  const meta = await stat(fileid);
  const expect = maxBytes ? Math.min(maxBytes, meta.size) : meta.size;

  const got = await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); out.destroy();
        return reject(new Error('download HTTP ' + res.statusCode));
      }
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (onProgress) onProgress(n, expect);
        if (maxBytes && n >= maxBytes) { res.destroy(); }
      });
      res.pipe(out);
      out.on('finish', () => resolve(n));
      res.on('close', () => { if (maxBytes && n >= maxBytes) out.end(); });
    });
    req.on('error', e => { out.destroy(); reject(new Error(redact(e.message))); });
    out.on('error', e => { req.destroy(); reject(e); });
  });

  if (!maxBytes && got !== meta.size) {
    throw new Error('download short: got ' + got + ' of ' + meta.size);
  }
  return { bytes: got, expected: expect, name: meta.name };
}

// Streaming multipart push — structure from the NAS uploader.
async function upload(localFile, destFolder, onProgress) {
  const name = path.basename(localFile);
  const size = fs.statSync(localFile).size;
  await createFolderIfNotExists(destFolder);

  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const header = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + name + '"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n');
  const footer = Buffer.from('\r\n--' + boundary + '--\r\n');

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, port: 443, method: 'POST', agent,
      path: '/uploadfile?' + qs({ path: destFolder, nopartial: 1 }),
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': header.length + size + footer.length,
        'Connection': 'keep-alive'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('upload parse error')); }
      });
    });

    req.setTimeout(0);
    req.on('socket', (s) => { s.setTimeout(0); s.setNoDelay(true); s.setKeepAlive(true, 30000); });
    req.on('error', e => reject(new Error(redact(e.message))));

    req.write(header);
    const rs = fs.createReadStream(localFile, { highWaterMark: 512 * 1024 });
    let sent = 0;
    rs.on('data', (c) => {
      sent += c.length;
      if (onProgress) onProgress(sent, size);
      if (!req.write(c)) { rs.pause(); req.once('drain', () => rs.resume()); }
    });
    rs.on('end', () => { req.write(footer); req.end(); });
    rs.on('error', (e) => { req.destroy(); reject(e); });
  });

  if (result.error) throw new Error('pCloud upload error ' + result.error + ': ' + (result.message||''));
  if (!result.metadata || !result.metadata.length) throw new Error('upload returned no metadata');
  const m = result.metadata[0];
  if (m.size !== size) throw new Error('stored size ' + m.size + ' != local ' + size);
  return { fileid: m.fileid, size: m.size, name: m.name };
}

// 3 attempts, 5s / 30s / 120s
async function withRetry(label, fn, onNote) {
  const delays = [5000, 30000, 120000];
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (onNote) onNote(label + ' attempt ' + (i+1) + ' failed: ' + redact(e.message));
      if (i < 2) await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  throw last;
}

module.exports = { HOST, listFolder, stat, createFolderIfNotExists,
                   checksum, sha1File, download, upload, withRetry, redact };
