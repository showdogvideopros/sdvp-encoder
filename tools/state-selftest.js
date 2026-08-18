'use strict';
// Discriminator: naive in-place write MUST produce torn reads; atomic MUST NOT.
// Runs entirely in /tmp. Never touches the live state file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sdvp-state-'));
const FILE = path.join(DIR, 'state.json');
const st = require('/root/build/lib/state.js');

const WRITES = 200;
const payload = { state_version: 1, updated_at: '', runs: [],
                  filler: new Array(9000).fill('x'.repeat(200)) };
const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2));

const READER = `
const fs=require('fs'); const f=process.argv[1];
let reads=0, fail=0;
process.on('SIGTERM',()=>{ fs.writeSync(1, JSON.stringify({reads,fail})); process.exit(0); });
(function loop(){
  try { JSON.parse(fs.readFileSync(f,'utf8')); } catch(e) { fail++; }
  reads++; setImmediate(loop);
})();
`;

function naiveWrite(text) { fs.writeFileSync(FILE, text); }

async function phase(name, writer) {
  fs.writeFileSync(FILE, JSON.stringify(payload, null, 2));
  const child = spawn(process.execPath, ['-e', READER, FILE], { stdio:['ignore','pipe','inherit'] });
  let out = '';
  child.stdout.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 150));
  for (let i = 0; i < WRITES; i++) {
    payload.updated_at = new Date().toISOString();
    writer(JSON.stringify(payload, null, 2) + '\n');
    await new Promise(r => setTimeout(r, 2));
  }
  await new Promise(r => setTimeout(r, 150));
  child.kill('SIGTERM');
  await new Promise(r => child.on('close', r));
  const res = JSON.parse(out || '{"reads":0,"fail":0}');
  console.log('  ' + name.padEnd(8) + '  writes=' + WRITES +
              '  reads=' + res.reads + '  torn=' + res.fail);
  return res;
}

(async () => {
  console.log('── STATE STORE DISCRIMINATOR ──');
  console.log('  payload %d bytes   dir %s', bytes, DIR);
  const naive  = await phase('NAIVE',  naiveWrite);
  const atomic = await phase('ATOMIC', t => st.writeAtomic(FILE, t));

  console.log('');
  const power = naive.fail > 0;
  const clean = atomic.fail === 0;
  const powered = naive.reads > WRITES && atomic.reads > WRITES;
  console.log('  known-positive (naive tears) : %s', power ? 'YES' : 'NO  ← TEST IS BLIND');
  console.log('  known-negative (atomic clean): %s', clean ? 'YES' : 'NO  ← ATOMIC FAILED');
  console.log('  reader had power             : %s', powered ? 'YES' : 'NO  ← too few reads');
  console.log('');
  console.log('  RESULT: %s', (power && clean && powered) ? 'PASS' : 'FAIL');

  // round-trip check
  const a = st.emptyState(); a.runs.push({ run_id:'t', items:[] });
  st.writeAtomic(FILE, JSON.stringify(a, null, 2));
  const b = JSON.parse(fs.readFileSync(FILE,'utf8'));
  console.log('  round-trip identical         : %s',
    JSON.stringify(a) === JSON.stringify(b) ? 'YES' : 'NO');
  fs.rmSync(DIR, { recursive: true, force: true });
})();
