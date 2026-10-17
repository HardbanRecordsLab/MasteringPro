/**
 * Restoration pipeline: diagnose a file, then repair it.
 *
 * Order matters. NON-LINEAR damage first: clipping (its flat tops must still be exactly flat to be recognised — any filter,
 * including the hum notches, would blur them) and clicks (an AR model is unaffected by a steady hum tone). Then the LINEAR
 * clean-up: hum notches, and noise reduction last, so the noise estimator sees the already-repaired signal.
 */
import { detectHum, dehum, type HumDetection } from '@/lib/dsp/dehum';
import { detectClipping, declip, type ClipDetection } from '@/lib/dsp/declip';
import { countClicks, declick } from '@/lib/dsp/declick';
import { denoise, estimateNoiseProfile } from '@/lib/dsp/denoise';

export interface Diagnosis {
  hum: HumDetection | null;
  clipping: ClipDetection | null;
  /** estimated number of click bursts (summed over channels) */
  clicks: number;
  noise: { floorDb: number; confidence: number } | null;
  /** sample peak, dBFS */
  peakDb: number;
}

export interface RestoreOptions {
  dehum?: { enabled: boolean; lines?: number[] };
  declip?: { enabled: boolean };
  declick?: { enabled: boolean; sensitivity?: number };
  denoise?: { enabled: boolean; reductionDb?: number; sensitivity?: number; smoothing?: number };
  /** after declipping the peaks exceed full scale: scale the result so its peak sits at this dBFS. Default −0.3. */
  peakTargetDb?: number;
}

export interface RestoreReport {
  hum: { lines: number[] } | null;
  clip: { runs: number; samples: number; ceilingDb: number; rebuiltToDb: number } | null;
  clicks: { bursts: number; samples: number } | null;
  noise: { reducedDb: number; floorBeforeDb: number; floorAfterDb: number } | null;
  /** gain applied at the end to keep the restored peaks below full scale (dB, ≤ 0) */
  gainDb: number;
}

const toDb = (v: number) => 20 * Math.log10(v + 1e-12);

export function diagnose(channels: Float32Array[], sampleRate: number, onProgress?: (f: number) => void): Diagnosis {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));

  let hum: HumDetection | null = null;
  let clipping: ClipDetection | null = null;
  let clicks = 0;
  let noise: Diagnosis['noise'] = null;

  channels.forEach((ch, c) => {
    const h = detectHum(ch, sampleRate);
    if (h && (!hum || h.prominenceDb > hum.prominenceDb)) hum = h;
    const cl = detectClipping(ch);
    if (cl && (!clipping || cl.fraction > clipping.fraction)) clipping = cl;
    clicks += countClicks(ch, sampleRate);
    const np = estimateNoiseProfile(ch, sampleRate);
    if (np && (!noise || np.floorDb > noise.floorDb)) noise = { floorDb: np.floorDb, confidence: np.confidence };
    onProgress?.((c + 1) / channels.length);
  });
  return { hum, clipping, clicks, noise, peakDb: toDb(peak) };
}

/** Restore the channels. Input arrays are not modified; new arrays are returned. */
export function restoreChannels(
  input: Float32Array[],
  sampleRate: number,
  opts: RestoreOptions,
  onProgress?: (stage: string, fraction: number) => void,
): { channels: Float32Array[]; report: RestoreReport } {
  const chans = input.map((c) => Float32Array.from(c));
  const report: RestoreReport = { hum: null, clip: null, clicks: null, noise: null, gainDb: 0 };
  const stages: string[] = [];
  if (opts.declip?.enabled) stages.push('declip');
  if (opts.declick?.enabled) stages.push('declick');
  if (opts.dehum?.enabled) stages.push('hum');
  if (opts.denoise?.enabled) stages.push('denoise');
  const total = Math.max(1, stages.length * chans.length);
  let done = 0;
  const tick = (stage: string, f = 1) => onProgress?.(stage, Math.min(1, (done + f) / total));

  if (opts.declip?.enabled) {
    let runs = 0, samples = 0, ceil = 0, rebuilt = 0;
    chans.forEach((c) => {
      const r = declip(c, sampleRate);
      runs += r.runs; samples += r.samples; ceil = Math.max(ceil, r.ceiling); rebuilt = Math.max(rebuilt, r.maxRepaired);
      done++; tick('declip', 0);
    });
    report.clip = { runs, samples, ceilingDb: toDb(ceil), rebuiltToDb: toDb(rebuilt) };
  }

  if (opts.declick?.enabled) {
    let bursts = 0, samples = 0;
    chans.forEach((c) => {
      const r = declick(c, sampleRate, { sensitivity: opts.declick?.sensitivity });
      bursts += r.bursts; samples += r.samples;
      done++; tick('declick', 0);
    });
    report.clicks = { bursts, samples };
  }

  if (opts.dehum?.enabled) {
    let lines = opts.dehum.lines;
    if (!lines || lines.length === 0) {
      const found = chans.map((c) => detectHum(c, sampleRate)).find(Boolean);
      lines = found ? found.lines : [];
    }
    chans.forEach((c) => { if (lines!.length) dehum(c, sampleRate, lines!); done++; tick('hum', 0); });
    report.hum = { lines };
  }

  if (opts.denoise?.enabled) {
    let reduced = 0, before = -Infinity, after = -Infinity, counted = 0;
    chans.forEach((c, i) => {
      const res = denoise(c, sampleRate, {
        reductionDb: opts.denoise?.reductionDb,
        sensitivity: opts.denoise?.sensitivity,
        smoothing: opts.denoise?.smoothing,
      }, (f) => tick('denoise', f));
      chans[i] = res.output;
      if (res.profile && res.floorAfterDb !== null) {
        before = Math.max(before, res.profile.floorDb);
        after = Math.max(after, res.floorAfterDb);
        reduced += res.profile.floorDb - res.floorAfterDb;
        counted++;
      }
      done++; tick('denoise', 0);
    });
    if (counted) report.noise = { reducedDb: reduced / counted, floorBeforeDb: before, floorAfterDb: after };
  }

  // keep the (possibly grown) peaks inside full scale
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const target = Math.pow(10, (opts.peakTargetDb ?? -0.3) / 20);
  if (peak > target) {
    const g = target / peak;
    for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g;
    report.gainDb = toDb(g);
  }
  return { channels: chans, report };
}
