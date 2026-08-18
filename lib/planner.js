'use strict';

// Map ffprobe codec names onto our codec keys.
const CODEC_ALIASES = { h264: 'h264', avc1: 'h264', hevc: 'hevc', h265: 'hevc', hvc1: 'hevc' };

function normalizeCodec(name) {
  if (!name) return null;
  return CODEC_ALIASES[String(name).toLowerCase()] || String(name).toLowerCase();
}

// RULE 1  never encode ABOVE the source height.
// RULE 2  never remake the master: skip a rung AT source height when the
//         requested codec equals the source's codec.
function planRungs(probeInfo, output) {
  const srcH = Number(probeInfo.height);
  const srcCodec = normalizeCodec(probeInfo.video_codec);
  const want = normalizeCodec(output.codec);

  const seen = new Set();
  const rungs = [];

  for (const r of (output.rungs || [])) {
    const h = Number(r);
    if (!isFinite(h) || h <= 0) {
      rungs.push({ height: r, state: 'SKIPPED', reason: 'not a valid height' });
      continue;
    }
    if (seen.has(h)) {
      rungs.push({ height: h, state: 'SKIPPED', reason: 'duplicate rung' });
      continue;
    }
    seen.add(h);

    if (h > srcH) {
      rungs.push({ height: h, state: 'SKIPPED',
                   reason: 'above source height ' + srcH });
    } else if (h === srcH && want === srcCodec) {
      rungs.push({ height: h, state: 'SKIPPED',
                   reason: 'master is the top rung (' + srcCodec + ' at ' + srcH + ')' });
    } else {
      rungs.push({ height: h, state: 'PLANNED', reason: null });
    }
  }

  // descending by height; skipped entries keep their place in that order
  rungs.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

  const planned = rungs.filter(r => r.state === 'PLANNED');
  return {
    codec: want,
    preset: output.preset || null,
    source_height: srcH,
    source_codec: srcCodec,
    rungs,
    planned_count: planned.length,
    skipped_count: rungs.length - planned.length
  };
}

function planItem(probeInfo, outputs) {
  return (outputs || []).map(o => planRungs(probeInfo, o));
}

function outputName(sourceName, height, codec) {
  const base = String(sourceName).replace(/\.[^.]+$/, '');
  return base + ' - ' + height + 'p ' + codec + '.mp4';
}

module.exports = { planRungs, planItem, normalizeCodec, outputName };
