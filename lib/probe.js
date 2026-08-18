'use strict';
const { execFile } = require('child_process');

const FFPROBE = '/usr/local/bin/ffprobe';

function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,format_name',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,duration',
      '-of', 'json', file
    ], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffprobe failed: ' + (stderr || err.message).trim()));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('ffprobe returned unparseable JSON')); }
    });
  });
}

function ratioToFps(r) {
  if (!r) return null;
  const p = String(r).split('/');
  const n = Number(p[0]), d = Number(p[1] || 1);
  if (!d || !isFinite(n / d)) return null;
  return n / d;
}

async function probe(file) {
  const j = await ffprobeJson(file);
  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video');
  if (!v) throw new Error('no video stream in ' + file);
  const a = streams.find(s => s.codec_type === 'audio');

  const dur = Number((j.format && j.format.duration) || v.duration || 0);
  if (!dur || dur <= 0) throw new Error('no usable duration in ' + file);

  return {
    width: Number(v.width),
    height: Number(v.height),
    video_codec: v.codec_name,             // 'h264', 'hevc', ...
    fps_ratio: v.r_frame_rate || null,     // '60000/1001'
    fps: ratioToFps(v.r_frame_rate),
    duration_s: dur,
    bit_rate: Number((j.format && j.format.bit_rate) || 0),
    has_audio: !!a,
    audio_codec: a ? a.codec_name : null
  };
}

module.exports = { probe, ffprobeJson, ratioToFps, FFPROBE };
