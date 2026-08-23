'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { probe } = require('./probe.js');
const { outputName } = require('./planner.js');

const FFMPEG = '/usr/local/bin/ffmpeg';

// Build one ffmpeg argv: single decode, split N ways, one output per planned rung.
function buildArgs(src, plannedRungs, preset, outDir, srcName, overrides) {
  const o = overrides || {};
  const enc = o.encoder || preset.encoder;
  const n = plannedRungs.length;
  if (!n) throw new Error('buildArgs called with no planned rungs');

  const chain = [];
  const labels = plannedRungs.map((r, i) => 'v' + i);
  chain.push('[0:v]split=' + n + ']' .replace(']', '') +
             labels.map(l => '[s' + l + ']').join('') );
  plannedRungs.forEach((r, i) => {
    chain.push('[s' + labels[i] + ']scale=-2:' + r.height + '[' + labels[i] + ']');
  });

  const args = ['-hide_banner', '-nostdin', '-y',
                '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
                '-i', src,
                '-filter_complex', chain.join(';')];

  const outputs = [];
  plannedRungs.forEach((r, i) => {
    const spec = preset.rungs.find(x => Number(x.height) === Number(r.height));
    if (!spec) throw new Error('no preset entry for rung ' + r.height);
    const finalName = outputName(srcName, r.height, preset.codec);
    const partPath = path.join(outDir, finalName + '.part');
    args.push(
      '-map', '[' + labels[i] + ']',
      '-c:v', enc,
      '-preset', preset.preset);
    // RATE CONTROL. A rung carrying rate_kbps is TARGETED at that average and
    // bounded by maxrate/bufsize. Ruled 2026-08-23: a quality-targeted encode
    // has no predictable file size, and the 4 GiB ceiling is a promise about
    // size. r.rate_kbps (set per film by the planner for the derived top rung)
    // WINS over the preset's own figure; crf remains the fallback so a rung
    // without a rate behaves exactly as it did before.
    const rate = r.rate_kbps || spec.rate_kbps || null;
    if (rate) args.push('-b:v', String(rate) + 'k');
    else      args.push('-crf', String(spec.crf));
    args.push(
      '-maxrate', spec.maxrate,
      '-bufsize', spec.bufsize,
      '-pix_fmt', preset.pix_fmt,
      '-map', '0:a?',
      '-c:a', 'aac',
      '-b:a', spec.audio_kbps + 'k',
      '-movflags', preset.movflags, '-f', 'mp4',
      partPath);
    outputs.push({ height: r.height, part: partPath,
                   final: path.join(outDir, finalName), name: finalName });
  });

  return { args, outputs };
}

function parseProgress(buf, state) {
  for (const line of buf.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k === 'out_time_us') { const n = Number(v); if (isFinite(n) && n >= 0) state.out_time_s = n / 1e6; }
    else if (k === 'frame')  { state.frame = Number(v) || state.frame; }
    else if (k === 'speed')  { const n = parseFloat(v); if (isFinite(n)) state.speed_x = n; }
    else if (k === 'total_size') { state.bytes_out = Number(v) || state.bytes_out; }
    else if (k === 'progress')   { state.ffmpeg_progress = v; }
  }
  return state;
}

// onProgress({pct, out_time_s, speed_x, eta_s, frame, updates})
function runEncode(opts) {
  const { src, plannedRungs, preset, outDir, srcName,
          durationS, onProgress, onSpawn, overrides } = opts;

  const built = buildArgs(src, plannedRungs, preset, outDir, srcName, overrides);
  if (onSpawn) onSpawn(built.args, built.outputs);

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(FFMPEG, built.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const st = { out_time_s: 0, speed_x: 0, frame: 0, bytes_out: 0, updates: 0, peak_pct: 0 };
    let stdoutBuf = '', errText = '';

    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString();
      const cut = stdoutBuf.lastIndexOf('\n');
      if (cut < 0) return;
      parseProgress(stdoutBuf.slice(0, cut), st);
      stdoutBuf = stdoutBuf.slice(cut + 1);
      st.updates++;
      const pct = durationS > 0 ? Math.min(100, (st.out_time_s / durationS) * 100) : 0;
      if (pct > st.peak_pct) st.peak_pct = pct;
      const elapsed = (Date.now() - t0) / 1000;
      const eta = (pct > 0.5) ? Math.max(0, elapsed * (100 - pct) / pct) : null;
      if (onProgress) onProgress({
        pct, out_time_s: st.out_time_s, speed_x: st.speed_x,
        frame: st.frame, bytes_out: st.bytes_out, eta_s: eta, updates: st.updates
      });
    });

    child.stderr.on('data', (c) => { errText += c.toString(); if (errText.length > 65536) errText = errText.slice(-65536); });
    child.on('error', (e) => reject(new Error('ffmpeg spawn failed: ' + e.message)));

    child.on('close', (code) => {
      const wall = (Date.now() - t0) / 1000;
      if (code !== 0) {
        for (const o of built.outputs) { try { fs.unlinkSync(o.part); } catch (e) {} }
        return reject(new Error('ffmpeg exit ' + code + ': ' + (errText.trim() || '(no stderr)')));
      }
      // rename .part -> final only on clean exit
      for (const o of built.outputs) {
        if (!fs.existsSync(o.part)) return reject(new Error('missing output: ' + o.name));
        fs.renameSync(o.part, o.final);
      }
      resolve({ outputs: built.outputs, wall_s: wall, updates: st.updates,
                peak_pct: st.peak_pct, speed_x: st.speed_x, args: built.args });
    });
  });
}

module.exports = { FFMPEG, buildArgs, parseProgress, runEncode };
