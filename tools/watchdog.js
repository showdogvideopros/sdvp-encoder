#!/usr/bin/env node
'use strict';
// tools/watchdog.js — SDVP encoder email watchdog (2026-10-14)
//
// Runs every 2 minutes from sdvp-watchdog.timer, as a SEPARATE process from the
// encoder, so it still reports when the encoder itself hangs or dies.
// [MEASURED 2026-09-16] a fetch hung ~11 h with nobody told. This exists so that
// cannot happen silently again.
//
// Emails (via SendGrid, its own restricted key in /root/config/watchdog.env):
//   STALLED        a run is active and the encoder's status has not changed in
//                  STALL_MIN (20) minutes; repeats every REPEAT_MIN (120) until it moves.
//                  20 min > the longest deliberate quiet wait in the code
//                  (Vimeo duration poll, 900 s max, lib/vimeo.js).
//   MOVING AGAIN   a stalled run started reporting again
//   DOWN           the encoder is enabled but not running for DOWN_MIN (3) minutes
//                  (a plain crash restarts in 5 s and never reaches this)
//   RUNNING AGAIN  it came back
//   FAILED         a film failed (named, with its error)
//   FILM DONE      a film finished its whole ladder (on by default; set
//                  WATCHDOG_FILM_EMAILS=off for failures + summaries only).
//                  More than 3 in one check are combined into one email.
//   RUN FINISHED   a run ended: summary, with any failures
//   NOT STARTING   a job file has waited QUEUE_MIN (10) minutes with no run starting
//   STILL ALIVE    once each morning (America/Denver) while there is work
//
// The first run (no watchdog.json yet) marks all existing history as already
// seen and sends one "armed" email, so September's old failures never email.
//
// Usage:
//   node tools/watchdog.js           evaluate once, send what is due (the timer runs this)
//   node tools/watchdog.js --dry     print what would be sent; send nothing, save nothing
//   node tools/watchdog.js --test    send one test email now
//   node tools/watchdog.js --seed    mark all current history as seen; send nothing
//   node tools/watchdog.js --preview-film   print the FILM DONE email for the newest
//                                    finished film in state.json; send nothing, save nothing
// Test overrides: WATCHDOG_STATE_FILE, WATCHDOG_DB, WATCHDOG_JOBS_DIR, WATCHDOG_UNIT,
// WATCHDOG_STALL_MIN, WATCHDOG_REPEAT_MIN, WATCHDOG_DOWN_MIN, WATCHDOG_QUEUE_MIN,
// WATCHDOG_HEARTBEAT_HOUR, WATCHDOG_TO, WATCHDOG_FROM,
// WATCHDOG_SINK (write emails to a file, send nothing),
// WATCHDOG_FAKE_ACTIVE / WATCHDOG_FAKE_ENABLED (pretend a service state).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const E = process.env;
const STATE_FILE = E.WATCHDOG_STATE_FILE || '/var/lib/sdvp-encoder/state.json';
const DB_FILE    = E.WATCHDOG_DB || '/var/lib/sdvp-encoder/watchdog.json';
const JOBS_DIR   = E.WATCHDOG_JOBS_DIR || '/var/lib/sdvp-encoder/jobs';
const UNIT       = E.WATCHDOG_UNIT || 'sdvp-encoder';
const num = (v, d) => (v !== undefined && v !== '' && isFinite(Number(v))) ? Number(v) : d;
const STALL_MIN  = num(E.WATCHDOG_STALL_MIN, 20);
const REPEAT_MIN = num(E.WATCHDOG_REPEAT_MIN, 120);
const DOWN_MIN   = num(E.WATCHDOG_DOWN_MIN, 3);
const QUEUE_MIN  = num(E.WATCHDOG_QUEUE_MIN, 10);
const HB_HOUR    = num(E.WATCHDOG_HEARTBEAT_HOUR, 7);
const FILM_EMAILS = String(E.WATCHDOG_FILM_EMAILS || 'on').toLowerCase() !== 'off';
const FILM_BURST  = 3;                       // more than this many in one check -> one combined email
const HB_WINDOW_H = 4;                       // heartbeat may go out HB_HOUR..HB_HOUR+3
const TZ    = 'America/Denver';
const FROM  = E.WATCHDOG_FROM || 'support@showdogvideopros.com';
const TO    = E.WATCHDOG_TO || 'showdogvideopros@gmail.com';
const PANEL = E.WATCHDOG_PANEL || 'http://100.99.131.37:8099';
const HOST  = os.hostname().split('.')[0];

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry') || args.has('--preview-film'), TEST = args.has('--test'), SEED = args.has('--seed');
const PREVIEW = args.has('--preview-film');

const NOW = Date.now();
const MIN = 60000;
const TERMINAL = new Set(['DONE', 'FAILED', 'SKIPPED', 'UNSTARTED']);

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function local(t) {
  return new Date(t).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
}
function localParts(t) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) };
}
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function writeAtomic(f, obj) {
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(t, f);
}
function unit(cmd) {
  // test hooks: pretend the encoder service is in a given state
  if (cmd === 'is-active' && E.WATCHDOG_FAKE_ACTIVE) return E.WATCHDOG_FAKE_ACTIVE;
  if (cmd === 'is-enabled' && E.WATCHDOG_FAKE_ENABLED) return E.WATCHDOG_FAKE_ENABLED;
  try { return execFileSync('systemctl', [cmd, UNIT], { encoding: 'utf8', timeout: 10000 }).trim(); }
  catch (e) { return String(e.stdout || '').trim() || 'unknown'; }
}

async function send(subject, lines) {
  const text = lines.join('\n') +
    '\n\n— ' + HOST + ' watchdog · ' + local(NOW) + ' Mountain' +
    '\nEncoder panel (over Tailscale): ' + PANEL + '\n';
  if (DRY) { console.log('[dry] would send: [' + HOST + '] ' + subject + '\n' + text); return true; }
  if (E.WATCHDOG_SINK) {          // test hook: write the email to a file instead of sending it
    fs.appendFileSync(E.WATCHDOG_SINK, '=== [' + HOST + '] ' + subject + '\n' + text + '\n');
    console.log('watchdog: sink "' + subject + '"');
    return true;
  }
  const key = E.SENDGRID_API_KEY || '';
  if (!/^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    console.error('watchdog: SENDGRID_API_KEY missing or not in SendGrid format - nothing sent');
    return false;
  }
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: TO }] }],
        from: { email: FROM, name: 'SDVP Encoder (' + HOST + ')' },
        subject: '[' + HOST + '] ' + subject,
        content: [{ type: 'text/plain', value: text }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (r.status === 202) {
      console.log('watchdog: sent "' + subject + '" (SendGrid 202, id ' + (r.headers.get('x-message-id') || '?') + ')');
      return true;
    }
    const body = (await r.text()).slice(0, 300).replace(/SG\.[A-Za-z0-9_.-]+/g, 'SG.<redacted>');
    console.error('watchdog: SendGrid refused "' + subject + '": HTTP ' + r.status + ' ' + body);
    return false;
  } catch (e) {
    console.error('watchdog: send failed "' + subject + '": ' + e.message);
    return false;
  }
}

// ---------- read the world ----------
const st = readJSON(STATE_FILE);
const runs = (st && Array.isArray(st.runs)) ? st.runs : [];
const stateAge = (st && st.updated_at) ? NOW - Date.parse(st.updated_at) : null;
const active = runs.find(r => !r.finished_at) || null;
const enabled = unit('is-enabled');
const running = unit('is-active');

let queued = [];
try {
  queued = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.json'))
    .map(f => ({ f, age: NOW - fs.statSync(path.join(JOBS_DIR, f)).mtimeMs }));
} catch (_) {}

function counts(run) {
  const c = { DONE: 0, FAILED: 0, SKIPPED: 0, left: 0, total: 0 };
  for (const it of (run.items || [])) {
    c.total++;
    if (it.phase === 'DONE') c.DONE++;
    else if (it.phase === 'FAILED') c.FAILED++;
    else if (it.phase === 'SKIPPED') c.SKIPPED++;
    else if (it.phase !== 'UNSTARTED') c.left++;
  }
  return c;
}
function current(run) {
  return (run.items || []).find(i => !TERMINAL.has(i.phase) && i.phase !== 'QUEUED') || null;
}
function filmLine(it) {
  const p = it.progress || {};
  const pct = (p.pct !== undefined && p.pct !== null) ? ' ' + Math.round(p.pct) + '%' : '';
  return (it.name || ('item ' + it.item_id)) + ' — ' + it.phase + pct + (p.label ? ' (' + p.label + ')' : '');
}
function statusLines() {
  const L = ['Encoder service: ' + running + ' (' + enabled + ')'];
  if (stateAge !== null) L.push('Status last changed: ' + fmtDur(stateAge) + ' ago');
  if (active) {
    const c = counts(active), cur = current(active);
    L.push('Running: run ' + active.run_number + ' · ' + (active.job_label || '(no label)') +
           ' · started ' + local(Date.parse(active.started_at)) + ' Mountain');
    L.push('Films: ' + c.DONE + ' done · ' + c.FAILED + ' failed · ' + c.left + ' to go · ' + c.total + ' in the job');
    if (cur) L.push('Now: ' + filmLine(cur));
  } else {
    L.push('No run in progress.');
  }
  L.push('Jobs waiting in the queue: ' + queued.length);
  return L;
}

// What one finished film delivered, from its own record in state.json.
const rungHeight = (r) => (r && typeof r === 'object')
  ? (r.height || r.target_height || r.rung || r.h || '?') : (r === undefined ? '?' : r);
function filmDoneLines(run, it) {
  const pos = (run.items || []).indexOf(it) + 1, total = (run.items || []).length;
  const t = it.timings || {};
  const secs = ['fetch_s', 'encode_s', 'verify_s', 'upload_s'].reduce((a, k) => a + (Number(t[k]) || 0), 0);
  const L = ['Film: ' + (it.name || it.item_id),
             'Job: ' + (run.job_label || '(no label)') + ' · run ' + run.run_number + ' · film ' + pos + ' of ' + total];
  if (secs > 0) {
    L.push('Took: ' + fmtDur(secs * 1000) + '  (download ' + Math.round(t.fetch_s || 0) + ' s · encode ' +
           Math.round(t.encode_s || 0) + ' s · verify ' + Math.round(t.verify_s || 0) + ' s · upload ' +
           Math.round(t.upload_s || 0) + ' s)');
  }
  const outs = Array.isArray(it.outputs) ? it.outputs : [];
  if (outs.length) {
    L.push('Delivered:');
    for (const o of outs) {
      const hs = (Array.isArray(o.rungs) ? o.rungs : []).map(rungHeight).join('/');
      L.push('  • ' + String(o.codec || '?').toUpperCase() + ' ' + (hs || '?') + 'p → ' +
             (Array.isArray(o.destinations) ? o.destinations.join(' + ') : '?') +
             (o.skipped_count ? '  (' + o.skipped_count + ' already there, skipped)' : ''));
    }
  }
  for (const v of (Array.isArray(it.vimeo) ? it.vimeo : [])) {
    const w = v.witness || {};
    L.push('Vimeo ' + (v.height || '') + 'p: ' + (w.state || 'no check recorded') +
           (w.drift_s !== undefined ? ' (length off by ' + w.drift_s + ' s)' : ''));
  }
  const c = counts(run);
  L.push('', 'This run so far: ' + c.DONE + ' done · ' + c.FAILED + ' failed · ' + c.left + ' to go');
  return L;
}

// ---------- the watchdog's own memory ----------
const fresh = { armed_at: new Date(NOW).toISOString(), seen_failed: {}, seen_runs: {}, seen_done: {},
                stall: null, down: null, queued_alerted: {}, heartbeat_date: null };
const prior = readJSON(DB_FILE);
const db = Object.assign({}, fresh, prior || {});
// [2026-10-14] seen_done is new. A memory file written before it existed must
// have every already-finished film marked seen BEFORE anything is evaluated,
// or the first check after the upgrade would email every film in the history.
const needsDoneSeed = !!prior && !prior.seen_done;
for (const k of ['seen_failed', 'seen_runs', 'seen_done', 'queued_alerted']) db[k] = db[k] || {};

function seedAll() {
  for (const r of runs) {
    if (r.finished_at) db.seen_runs[r.run_number] = 1;
    for (const it of (r.items || [])) if (it.phase === 'FAILED') db.seen_failed[r.run_number + ':' + it.item_id] = 1;
    seedDone(r);
  }
}
function seedDone(r) {
  for (const it of (r.items || [])) if (it.phase === 'DONE') db.seen_done[r.run_number + ':' + it.item_id] = 1;
}
function save() {
  if (DRY) return;
  // keep memory bounded to runs still present in state
  const keep = new Set(runs.map(r => String(r.run_number)));
  for (const k of Object.keys(db.seen_runs)) if (!keep.has(String(k))) delete db.seen_runs[k];
  for (const k of Object.keys(db.seen_failed)) if (!keep.has(k.split(':')[0])) delete db.seen_failed[k];
  for (const k of Object.keys(db.seen_done)) if (!keep.has(k.split(':')[0])) delete db.seen_done[k];
  writeAtomic(DB_FILE, db);
}

(async () => {
  if (TEST) {
    const ok = await send('Test email - the watchdog can reach you', [
      'This is a test from the enc2 email watchdog.',
      'If you are reading this on your phone and your desktop, alerts will reach you.',
      '', ...statusLines()]);
    process.exit(ok ? 0 : 1);
  }

  if (PREVIEW) {
    let pick = null;
    for (const r of runs) {
      for (const it of (r.items || [])) if (it.phase === 'DONE') { pick = { r, it }; break; }
      if (pick) break;
    }
    if (!pick) { console.log('preview: no finished film in state'); return; }
    await send('FILM DONE (preview): ' + (pick.it.name || pick.it.item_id), filmDoneLines(pick.r, pick.it));
    return;
  }

  if (SEED || !prior) {
    seedAll();
    if (SEED) {
      save();
      console.log('watchdog: seeded - ' + Object.keys(db.seen_runs).length + ' finished run(s), ' +
                  Object.keys(db.seen_failed).length + ' failed film(s) and ' +
                  Object.keys(db.seen_done).length + ' finished film(s) marked as already seen');
      return;
    }
    // first real run: arm quietly, say so once
    await send('Watchdog armed', ['The enc2 email watchdog is now watching the encoder.',
      'Existing history was marked as already seen; only new events will email you.',
      '', ...statusLines()]);
    save();
    return;
  }

  if (needsDoneSeed) {
    for (const r of runs) seedDone(r);
    console.log('watchdog: upgrade - ' + Object.keys(db.seen_done).length + ' already-finished film(s) marked seen');
  }

  // 0. FILM DONE - each film that finished its ladder since the last check
  if (FILM_EMAILS) {
    const newDone = [];
    for (const r of runs) for (const it of (r.items || [])) {
      if (it.phase === 'DONE' && !db.seen_done[r.run_number + ':' + it.item_id]) newDone.push({ r, it });
    }
    const mark = (x) => { db.seen_done[x.r.run_number + ':' + x.it.item_id] = 1; };
    if (newDone.length > FILM_BURST) {
      const L = newDone.map(x => '• ' + (x.it.name || x.it.item_id) + '  (' + (x.r.job_label || 'run ' + x.r.run_number) + ')');
      L.push('', 'Several finished between checks, so they are combined into one email.', '', ...statusLines());
      if (await send(newDone.length + ' FILMS DONE', L)) newDone.forEach(mark);
    } else {
      for (const x of newDone) {
        const pos = (x.r.items || []).indexOf(x.it) + 1, total = (x.r.items || []).length;
        if (await send('FILM DONE (' + pos + ' of ' + total + '): ' + (x.it.name || x.it.item_id),
                       filmDoneLines(x.r, x.it))) mark(x);
      }
    }
  } else {
    for (const r of runs) seedDone(r);   // stay current, so switching back on does not flood
  }

  // 1. RUN FINISHED (carries its own new failures, so they do not email twice)
  for (const r of runs) {
    if (!r.finished_at || db.seen_runs[r.run_number]) continue;
    const c = counts(r);
    const newFails = (r.items || []).filter(i => i.phase === 'FAILED');
    const L = ['Run ' + r.run_number + ' · ' + (r.job_label || '(no label)') + ' · ' + r.status,
               'Started ' + local(Date.parse(r.started_at)) + ' · finished ' + local(Date.parse(r.finished_at)) +
               ' Mountain (' + fmtDur(Date.parse(r.finished_at) - Date.parse(r.started_at)) + ')',
               'Films: ' + c.DONE + ' done · ' + c.FAILED + ' failed · ' + c.SKIPPED + ' skipped · ' + c.total + ' in the job'];
    if (newFails.length) {
      L.push('', 'Failed:');
      for (const it of newFails) L.push('  • ' + (it.name || it.item_id) + ' — ' + (it.error || 'no error text'));
    }
    const subj = (c.FAILED ? 'RUN FINISHED with ' + c.FAILED + ' failed' : 'RUN FINISHED') +
                 ' - ' + (r.job_label || 'run ' + r.run_number);
    if (await send(subj, L)) {
      db.seen_runs[r.run_number] = 1;
      for (const it of newFails) db.seen_failed[r.run_number + ':' + it.item_id] = 1;
    }
  }

  // 2. FAILED films in the active run
  if (active) {
    const nf = (active.items || []).filter(i => i.phase === 'FAILED' && !db.seen_failed[active.run_number + ':' + i.item_id]);
    if (nf.length) {
      const L = nf.map(it => '• ' + (it.name || it.item_id) + ' — ' + (it.error || 'no error text'));
      L.push('', 'The run carries on with the next film.', '', ...statusLines());
      if (await send('FAILED: ' + (nf.length === 1 ? (nf[0].name || 'a film') : nf.length + ' films'), L)) {
        for (const it of nf) db.seen_failed[active.run_number + ':' + it.item_id] = 1;
      }
    }
  }

  // 3. DOWN / RUNNING AGAIN
  const isUp = running === 'active';
  if (enabled === 'enabled' && !isUp) {
    if (!db.down) db.down = { first_at: NOW, alerted: false, last_sent: 0 };
    const downFor = NOW - db.down.first_at;
    const due = !db.down.alerted ? downFor >= DOWN_MIN * MIN : (NOW - db.down.last_sent) >= REPEAT_MIN * MIN;
    if (due && await send((db.down.alerted ? 'STILL DOWN' : 'DOWN') + ' - the encoder is not running',
        ['The encoder service is enabled but has not been running for ' + fmtDur(downFor) + '.',
         'Nothing will encode until it is running again.', '', ...statusLines()])) {
      db.down.alerted = true; db.down.last_sent = NOW;
    }
  } else if (db.down) {
    if (db.down.alerted && isUp) {
      await send('RUNNING AGAIN - the encoder is back', ['The encoder service is running again after ' +
        fmtDur(NOW - db.down.first_at) + '.', '', ...statusLines()]);
    }
    db.down = null;
  }

  // 4. STALLED / MOVING AGAIN  (only while the service is up; DOWN covers the rest)
  const stalled = isUp && active && stateAge !== null && stateAge >= STALL_MIN * MIN;
  if (stalled) {
    const cur = current(active);
    const key = active.run_number + ':' + (cur ? cur.item_id : '-');
    const isNew = !db.stall || db.stall.key !== key;
    if (isNew || (NOW - db.stall.last_sent) >= REPEAT_MIN * MIN) {
      const L = ['Nothing has moved for ' + fmtDur(stateAge) + '.',
                 cur ? 'Stuck on: ' + filmLine(cur) : 'No film is marked as in progress.',
                 '', 'This is the September hang pattern. Check the panel; if it is truly stuck,',
                 'ABORT from the panel (STOP and PAUSE wait for the current film and will not help).',
                 '', ...statusLines()];
      if (await send((isNew ? 'STALLED' : 'STILL STALLED') + ': ' + (cur ? (cur.name || 'a film') : 'run ' + active.run_number), L)) {
        db.stall = { key, first_at: isNew ? NOW : db.stall.first_at, last_sent: NOW };
      }
    }
  } else if (db.stall) {
    if (active && isUp) {
      await send('MOVING AGAIN', ['The encoder is reporting progress again.', '', ...statusLines()]);
    }
    db.stall = null;
  }

  // 5. NOT STARTING - a job file waiting with no run picking it up
  for (const q of queued) {
    if (isUp && !active && q.age >= QUEUE_MIN * MIN && !db.queued_alerted[q.f]) {
      if (await send('NOT STARTING: a job has waited ' + fmtDur(q.age),
          ['Job file: ' + q.f, 'The encoder normally takes a new job within seconds.', '', ...statusLines()])) {
        db.queued_alerted[q.f] = 1;
      }
    }
  }
  for (const f of Object.keys(db.queued_alerted)) if (!queued.some(q => q.f === f)) delete db.queued_alerted[f];

  // 6. STILL ALIVE - once a morning while there is work
  const lp = localParts(NOW);
  const recentFinish = runs.some(r => r.finished_at && NOW - Date.parse(r.finished_at) < 24 * 60 * MIN);
  const work = !!active || queued.length > 0 || recentFinish;
  if (work && db.heartbeat_date !== lp.date && lp.hour >= HB_HOUR && lp.hour < HB_HOUR + HB_WINDOW_H) {
    if (await send('Still alive - morning report', ['Good morning. The watchdog is running and watching the encoder.',
        '', ...statusLines()])) {
      db.heartbeat_date = lp.date;
    }
  }

  save();
})().catch(e => { console.error('watchdog: error ' + e.message); process.exit(1); });
