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
