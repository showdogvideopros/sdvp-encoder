'use strict';
// THE RECORD — durable memory of every encode this box has ever done.
//
// WHY IT EXISTS, in Dr. K's framing 2026-08-19: manifests live beside the files
// in a vendor's folder and answer "what is in this folder". They cannot answer
// questions ACROSS shows, years and vendors, and they vanish if an account is
// emptied, closed or lost. The record answers the cross-cutting questions and
// is ours.
//
// WHY A FILE AND NOT A SERVER: this box is destroyed every season. A database
// server would have to be rebuilt, re-credentialed and re-verified each year;
// a fleet database would need production credentials on a temporary machine.
// A file has neither problem - it copies like any other file.
//
// WHY node:sqlite: it ships INSIDE Node, so the seasonal rebuild installs
// nothing and compiles nothing. Node calls the API experimental; that applies
// to the library, not the FILE, which is standard SQLite readable by anything.
// Every call this module makes is wrapped, so swapping libraries later touches
// this file only and no stored byte.
//
// SINGLE WRITER. One daemon, one file. Two encode boxes would need a server.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.SDVP_RECORD_DB || '/var/lib/sdvp-encoder/record.db';
const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  run_number INTEGER,
  job_label TEXT,
  job_file TEXT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  box_host TEXT,
  ffmpeg_version TEXT,
  code_commit TEXT
);

CREATE TABLE IF NOT EXISTS movies (
  item_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  source_name TEXT,
  source_fileid INTEGER,
  source_bytes INTEGER,
  show_path TEXT,
  dest_path TEXT,
  width INTEGER,
  height INTEGER,
  fps REAL,
  duration_s REAL,
  video_codec TEXT,
  audio_codec TEXT,
  has_audio INTEGER,
  source_mbps REAL,
  phase TEXT,
  error TEXT,
  fetch_s REAL,
  encode_s REAL,
  verify_s REAL,
  upload_s REAL
);

CREATE TABLE IF NOT EXISTS rungs (
  rung_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES movies(item_id),
  codec TEXT,
  preset_name TEXT,
  encoder TEXT,
  encoder_preset TEXT,
  height INTEGER,
  state TEXT,
  reason TEXT,
  filename TEXT,
  crf INTEGER,
  maxrate TEXT,
  bufsize TEXT,
  audio_kbps INTEGER,
  bytes INTEGER,
  mbps REAL,
  cap_mbps REAL,
  pct_of_cap REAL,
  verify_s REAL,
  encode_wall_s REAL,
  speed_x REAL,
  UNIQUE (item_id, codec, height)
);

-- ONE ROW PER RUNG PER DESTINATION. A 2027 1080p HEVC rung bound for both
-- pCloud and Vimeo is TWO rows, each with its own outcome. This is what makes
-- "what did we send to Vimeo, and does Vimeo still have it" a single query.
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
  rung_id INTEGER NOT NULL REFERENCES rungs(rung_id),
  destination TEXT NOT NULL,
  ok INTEGER,
  pcloud_fileid INTEGER,
  sha1_verified INTEGER,
  vimeo_uri TEXT,
  vimeo_link TEXT,
  witness_state TEXT,
  witness_drift_s REAL,
  upload_s REAL,
  upload_mbps REAL,
  attempts INTEGER,
  error TEXT,
  recorded_at TEXT,
  UNIQUE (rung_id, destination)
);

CREATE TABLE IF NOT EXISTS quality (
  item_id TEXT PRIMARY KEY REFERENCES movies(item_id),
  audio_ok INTEGER,
  audio_from_height INTEGER,
  channels INTEGER,
  peak_max_db REAL,
  rms_min_db REAL,
  rms_max_db REAL,
  imbalance_db REAL,
  flat_max REAL,
  audio_failed TEXT,
  sheet_h264 TEXT,
  sheet_hevc TEXT,
  sheets_uploaded INTEGER,
  probe_s REAL
);

CREATE INDEX IF NOT EXISTS ix_movies_run    ON movies(run_id);
CREATE INDEX IF NOT EXISTS ix_movies_name   ON movies(source_name);
CREATE INDEX IF NOT EXISTS ix_movies_show   ON movies(show_path);
CREATE INDEX IF NOT EXISTS ix_rungs_item    ON rungs(item_id);
CREATE INDEX IF NOT EXISTS ix_deliv_rung    ON deliveries(rung_id);
CREATE INDEX IF NOT EXISTS ix_deliv_dest    ON deliveries(destination);
CREATE INDEX IF NOT EXISTS ix_deliv_vimeo   ON deliveries(vimeo_uri);

-- The questions Dr. K named, as views, so nobody has to rebuild the joins.
CREATE VIEW IF NOT EXISTS v_coverage AS
SELECT m.show_path, m.source_name, r.codec, r.height, r.state,
       d.destination, d.ok, d.pcloud_fileid, d.vimeo_uri, d.witness_state
FROM movies m
JOIN rungs r ON r.item_id = m.item_id
LEFT JOIN deliveries d ON d.rung_id = r.rung_id;

CREATE VIEW IF NOT EXISTS v_audio_corpus AS
SELECT m.show_path, m.source_name, m.duration_s,
       q.channels, q.peak_max_db, q.rms_min_db, q.rms_max_db,
       q.imbalance_db, q.flat_max, q.audio_ok
FROM quality q JOIN movies m ON m.item_id = q.item_id;

CREATE VIEW IF NOT EXISTS v_throughput AS
SELECT m.show_path, m.source_name, m.duration_s, m.source_mbps,
       r.codec, r.encoder_preset, r.encode_wall_s, r.speed_x,
       r.height, r.mbps, r.pct_of_cap
FROM movies m JOIN rungs r ON r.item_id = m.item_id
WHERE r.state IN ('STORED','VERIFIED');

CREATE VIEW IF NOT EXISTS v_vimeo AS
SELECT m.show_path, m.source_name, r.codec, r.height,
       d.vimeo_uri, d.vimeo_link, d.witness_state, d.witness_drift_s,
       d.recorded_at
FROM deliveries d
JOIN rungs r ON r.rung_id = d.rung_id
JOIN movies m ON m.item_id = r.item_id
WHERE d.destination = 'vimeo';
`;

let _db = null;

function db() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(SCHEMA);
  const cur = _db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!cur) {
    _db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
       .run('schema_version', String(SCHEMA_VERSION));
    _db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
       .run('created_at', new Date().toISOString());
  }
  return _db;
}

function close() { if (_db) { _db.close(); _db = null; } }

// Numbers only where numbers belong; SQLite will not coerce silently for us.
function num(v) { return (v === null || v === undefined || !isFinite(v)) ? null : Number(v); }
function int(v) { const n = num(v); return n === null ? null : Math.round(n); }
function bool(v) { return v === true ? 1 : (v === false ? 0 : null); }

function upsertRun(run, extra) {
  db().prepare(`INSERT INTO runs
    (run_id, run_number, job_label, job_file, started_at, finished_at, status,
     box_host, ffmpeg_version, code_commit)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET
      finished_at = excluded.finished_at, status = excluded.status`)
   .run(run.run_id, int(run.run_number), run.job_label || null, run.job_file || null,
        run.started_at || null, run.finished_at || null, run.status || null,
        (extra && extra.box_host) || null,
        (extra && extra.ffmpeg_version) || null,
        (extra && extra.code_commit) || null);
}

function upsertMovie(runId, item) {
  const p = item.probe || {};
  db().prepare(`INSERT INTO movies
    (item_id, run_id, source_name, source_fileid, source_bytes, show_path, dest_path,
     width, height, fps, duration_s, video_codec, audio_codec, has_audio,
     source_mbps, phase, error, fetch_s, encode_s, verify_s, upload_s)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET
      phase = excluded.phase, error = excluded.error,
      fetch_s = excluded.fetch_s, encode_s = excluded.encode_s,
      verify_s = excluded.verify_s, upload_s = excluded.upload_s`)
   .run(item.item_id, runId, item.name || null, int(item.fileid), int(item.bytes),
        item.source_path || null, item.dest_path || null,
        int(p.width), int(p.height), num(p.fps), num(p.duration_s),
        p.video_codec || null, p.audio_codec || null, bool(p.has_audio),
        num(p.bit_rate ? p.bit_rate / 1e6 : null),
        item.phase || null, item.error || null,
        num(item.timings && item.timings.fetch_s),
        num(item.timings && item.timings.encode_s),
        num(item.timings && item.timings.verify_s),
        num(item.timings && item.timings.upload_s));
}

function upsertRung(itemId, out, r, spec, capMbps) {
  const stmt = db().prepare(`INSERT INTO rungs
    (item_id, codec, preset_name, encoder, encoder_preset, height, state, reason,
     filename, crf, maxrate, bufsize, audio_kbps, bytes, mbps, cap_mbps,
     pct_of_cap, verify_s, encode_wall_s, speed_x)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id, codec, height) DO UPDATE SET
      state = excluded.state, reason = excluded.reason, bytes = excluded.bytes,
      mbps = excluded.mbps, pct_of_cap = excluded.pct_of_cap,
      verify_s = excluded.verify_s, encode_wall_s = excluded.encode_wall_s,
      speed_x = excluded.speed_x
    RETURNING rung_id`);
  const mbps = num(r.verify && r.verify.mbps);
  const cap = num(capMbps);
  const row = stmt.get(itemId, out.codec || null, out.preset_name || null,
    (out._encoder || null), (out._encoder_preset || null),
    int(r.height), r.state || null, r.reason || null, r.filename || null,
    int(spec && spec.crf), (spec && spec.maxrate) || null,
    (spec && spec.bufsize) || null, int(spec && spec.audio_kbps),
    int(r.bytes), mbps, cap,
    (mbps !== null && cap) ? num(mbps / cap * 100) : null,
    num(r.verify_s), num(out.encode_wall_s), num(out.speed_x));
  if (row && row.rung_id != null) return row.rung_id;
  return db().prepare('SELECT rung_id FROM rungs WHERE item_id=? AND codec=? AND height=?')
             .get(itemId, out.codec, int(r.height)).rung_id;
}

function upsertDelivery(rungId, destination, d) {
  db().prepare(`INSERT INTO deliveries
    (rung_id, destination, ok, pcloud_fileid, sha1_verified, vimeo_uri, vimeo_link,
     witness_state, witness_drift_s, upload_s, upload_mbps, attempts, error, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rung_id, destination) DO UPDATE SET
      ok = excluded.ok, pcloud_fileid = excluded.pcloud_fileid,
      sha1_verified = excluded.sha1_verified, vimeo_uri = excluded.vimeo_uri,
      vimeo_link = excluded.vimeo_link, witness_state = excluded.witness_state,
      witness_drift_s = excluded.witness_drift_s, upload_s = excluded.upload_s,
      upload_mbps = excluded.upload_mbps, attempts = excluded.attempts,
      error = excluded.error, recorded_at = excluded.recorded_at`)
   .run(rungId, destination, bool(d.ok), int(d.pcloud_fileid), bool(d.sha1_verified),
        d.vimeo_uri || null, d.vimeo_link || null, d.witness_state || null,
        num(d.witness_drift_s), num(d.upload_s), num(d.upload_mbps),
        int(d.attempts), d.error || null, new Date().toISOString());
}

function upsertQuality(itemId, q) {
  if (!q) return;
  const a = q.audio || null;
  const rec = (a && a.recorded) || null;
  const rms = (rec && rec.rms_db) || [];
  const peak = (rec && rec.peak_db) || [];
  const sheets = q.sheets || [];
  const byCodec = c => { const s = sheets.find(x => x.codec === c); return s ? s.name : null; };
  db().prepare(`INSERT INTO quality
    (item_id, audio_ok, audio_from_height, channels, peak_max_db, rms_min_db,
     rms_max_db, imbalance_db, flat_max, audio_failed, sheet_h264, sheet_hevc,
     sheets_uploaded, probe_s)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET
      audio_ok = excluded.audio_ok, peak_max_db = excluded.peak_max_db,
      rms_min_db = excluded.rms_min_db, rms_max_db = excluded.rms_max_db,
      imbalance_db = excluded.imbalance_db, audio_failed = excluded.audio_failed,
      sheet_h264 = excluded.sheet_h264, sheet_hevc = excluded.sheet_hevc,
      sheets_uploaded = excluded.sheets_uploaded, probe_s = excluded.probe_s`)
   .run(itemId, bool(a && a.ok), int(a && a.from_height), int(rec && rec.channels),
        peak.length ? num(Math.max.apply(null, peak)) : null,
        rms.length ? num(Math.min.apply(null, rms)) : null,
        rms.length ? num(Math.max.apply(null, rms)) : null,
        num(rec && rec.imbalance_db), null,
        a && a.checks ? (a.checks.filter(c => !c.ok).map(c => c.name).join(',') || null) : null,
        byCodec('h264'), byCodec('hevc'),
        int(sheets.filter(s => s.uploaded).length), num(q.probe_s));
}

// Has this movie's rung already been delivered here? Keyed on the SOURCE NAME
// rather than item_id, because a rerun is a different item entirely. Newest
// successful delivery wins.
function findDelivery(sourceName, codec, height, destination) {
  const row = db().prepare(`
    SELECT d.destination, d.ok, d.pcloud_fileid, d.vimeo_uri, d.vimeo_link,
           d.witness_state, d.recorded_at
    FROM deliveries d
    JOIN rungs r  ON r.rung_id = d.rung_id
    JOIN movies m ON m.item_id = r.item_id
    WHERE m.source_name = ? AND r.codec = ? AND r.height = ?
      AND d.destination = ? AND d.ok = 1
    ORDER BY d.recorded_at DESC LIMIT 1`)
   .get(sourceName, codec, Math.round(height), destination);
  return row || null;
}

// Everything the record knows about one rung of one movie, newest first.
// Used to CARRY FORWARD detail into a manifest for rungs this run skipped,
// so a top-up run does not publish nulls over what an earlier run measured.
function priorRung(sourceName, codec, height) {
  const row = db().prepare(`
    SELECT r.rung_id, r.state, r.filename, r.crf, r.maxrate, r.bufsize,
           r.audio_kbps, r.bytes, r.mbps, r.verify_s
    FROM rungs r JOIN movies m ON m.item_id = r.item_id
    WHERE m.source_name = ? AND r.codec = ? AND r.height = ?
      AND r.state IN ('STORED')
    ORDER BY r.rung_id DESC LIMIT 1`)
   .get(sourceName, codec, Math.round(height));
  if (!row) return null;
  row.deliveries = db().prepare(
    `SELECT destination, ok, pcloud_fileid, sha1_verified, vimeo_uri, vimeo_link,
            witness_state FROM deliveries WHERE rung_id = ?`).all(row.rung_id);
  return row;
}

function query(sql, params) {
  return db().prepare(sql).all.apply(db().prepare(sql), params || []);
}

function stats() {
  const one = s => db().prepare(s).get();
  return {
    path: DB_PATH,
    bytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
    runs: one('SELECT COUNT(*) AS n FROM runs').n,
    movies: one('SELECT COUNT(*) AS n FROM movies').n,
    rungs: one('SELECT COUNT(*) AS n FROM rungs').n,
    deliveries: one('SELECT COUNT(*) AS n FROM deliveries').n,
    quality: one('SELECT COUNT(*) AS n FROM quality').n
  };
}

module.exports = { db, close, stats, query, findDelivery, priorRung, DB_PATH, SCHEMA_VERSION,
                   upsertRun, upsertMovie, upsertRung, upsertDelivery, upsertQuality };
