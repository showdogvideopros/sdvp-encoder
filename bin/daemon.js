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

  if (req.url === '/api/state') {
    let body;
    try { body = fs.readFileSync(st.STATE, 'utf8'); }
    catch (e) { body = JSON.stringify(state); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(body);
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
