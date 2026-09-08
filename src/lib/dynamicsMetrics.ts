/**
 * Extra dynamics / integrity metrics that sit alongside BS.1770-4:
 *  - DR   — official TT Dynamic Range (Pleasurize Music Foundation, "DR14")
 *  - PSR  — Peak to Short-term loudness Ratio  (true peak − max LUFS-S)
 *  - PLR  — Peak to Loudness Ratio            (true peak − integrated LUFS)
 *  - clip — consecutive-sample clip runs and their count
 *  - ISP  — inter-sample peaks over a delivery ceiling
 */
import type { LoudnessResult } from '@/lib/loudness';

export interface DynamicsMetrics {
  dr: number;             // integer, TT DR
  psr: number;            // dB
  plr: number;            // dB
  clipEvents: number;     // runs of ≥ `clipRun` consecutive full-scale samples
  clippedSamples: number;
  ispOvers: number;       // count of samples whose 4× interpolation exceeds `ispCeilingDb`
}

const CLIP_RUN = 3;         // ≥3 consecutive samples at ±1.0 = a clip event
const FULL_SCALE = 0.99997; // treat as clipped at/above this
const ISP_CEIL_DB = -1.0;   // streaming delivery ceiling

/** TT Dynamic Range: 20·log10( 2nd-highest peak / RMS of the loudest 20% of 3 s blocks ). */
function ttDynamicRange(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate;
  const block = Math.max(1, Math.round(sr * 3));
  const ch = buffer.numberOfChannels;
  const perChannel: number[] = [];

  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    const rmsList: number[] = [];
    const peaks: number[] = [];
    for (let start = 0; start + block <= d.length; start += block) {
      let sq = 0;
      let pk = 0;
      for (let i = start; i < start + block; i++) {
        const x = d[i];
        sq += x * x;
        const a = Math.abs(x);
        if (a > pk) pk = a;
      }
      rmsList.push(Math.sqrt((2 * sq) / block)); // ×2 per the TT spec
      peaks.push(pk);
    }
    if (rmsList.length < 1) {
      perChannel.push(0);
      continue;
    }
    // loudest 20% of blocks by RMS
    const n = rmsList.length;
    const take = Math.max(1, Math.round(n * 0.2));
    const topRms = [...rmsList].sort((a, b) => b - a).slice(0, take);
    const rms20 = Math.sqrt(topRms.reduce((s, v) => s + v * v, 0) / topRms.length);
    const sortedPk = [...peaks].sort((a, b) => b - a);
    const peak2 = sortedPk[Math.min(1, sortedPk.length - 1)] || sortedPk[0] || 1e-9;
    perChannel.push(20 * Math.log10((peak2 || 1e-9) / (rms20 || 1e-9)));
  }
  const dr = perChannel.reduce((s, v) => s + v, 0) / perChannel.length;
  return Math.round(dr);
}

/** 4× linear interpolation over-count + clip run count. */
function clipAndIsp(buffer: AudioBuffer) {
  const ispCeil = Math.pow(10, ISP_CEIL_DB / 20);
  let clipEvents = 0;
  let clippedSamples = 0;
  let ispOvers = 0;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    let run = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a >= FULL_SCALE) {
        clippedSamples++;
        run++;
        if (run === CLIP_RUN) clipEvents++;
      } else {
        run = 0;
      }
      // cheap 4× check between i and i+1 (Catmull-Rom needs i-1..i+2)
      if (i >= 1 && i < d.length - 2) {
        const x0 = d[i - 1], x1 = d[i], x2 = d[i + 1], x3 = d[i + 2];
        for (let k = 1; k < 4; k++) {
          const t = k / 4;
          const v =
            0.5 *
            (2 * x1 +
              (-x0 + x2) * t +
              (2 * x0 - 5 * x1 + 4 * x2 - x3) * t * t +
              (-x0 + 3 * x1 - 3 * x2 + x3) * t * t * t);
          if (Math.abs(v) > ispCeil) {
            ispOvers++;
            break;
          }
        }
      }
    }
  }
  return { clipEvents, clippedSamples, ispOvers };
}

export function computeDynamicsMetrics(buffer: AudioBuffer, loud: LoudnessResult): DynamicsMetrics {
  const { clipEvents, clippedSamples, ispOvers } = clipAndIsp(buffer);
  return {
    dr: ttDynamicRange(buffer),
    psr: Math.round((loud.truePeak - loud.shortTermMax) * 10) / 10,
    plr: Math.round((loud.truePeak - loud.integrated) * 10) / 10,
    clipEvents,
    clippedSamples,
    ispOvers,
  };
}
