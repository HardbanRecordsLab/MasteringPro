/**
 * Declipping — reconstruct the peaks a clipper flattened.
 *
 * A clipped waveform shows runs of consecutive samples stuck at the same ceiling. Those samples are treated as missing
 * and re-estimated with the least-squares AR interpolation; because the real signal must have been AT LEAST as
 * large as the ceiling, the result is clamped so it never falls below it. The restored peaks exceed full scale, so the
 * caller usually lowers the gain afterwards (see `restore.ts`).
 */
import { estimateARAround, interpolateAR } from '@/lib/dsp/ar';

export interface ClipDetection {
  /** the ceiling the signal was clipped at (linear) */
  level: number;
  /** samples sitting on the ceiling */
  clippedSamples: number;
  /** distinct clipped runs (≥ 2 consecutive samples) */
  runs: number;
  /** clippedSamples / length */
  fraction: number;
}

/**
 * Look for the signature of hard clipping: many runs of ≥ 2 consecutive samples with the SAME magnitude. Natural peaks
 * essentially never repeat to 1e-4 over consecutive samples. The ceiling is the highest level that such runs keep landing
 * on (not simply the largest sample, which a single loud click would hijack).
 */
export function detectClipping(x: ArrayLike<number>, minRuns = 4): ClipDetection | null {
  const n = x.length;
  const STEP = 0.0005;
  const levels = new Map<number, { runs: number; sum: number; count: number }>();
  let i = 0;
  while (i < n - 1) {
    const a = Math.abs(x[i]);
    if (a > 0.05 && Math.sign(x[i]) === Math.sign(x[i + 1]) && Math.abs(Math.abs(x[i + 1]) - a) <= a * 1e-4) {
      let j = i + 1;
      while (j + 1 < n && Math.sign(x[j + 1]) === Math.sign(x[i]) && Math.abs(Math.abs(x[j + 1]) - a) <= a * 1e-4) j++;
      const key = Math.round(a / STEP);
      const e = levels.get(key) ?? { runs: 0, sum: 0, count: 0 };
      e.runs++; e.sum += a * (j - i + 1); e.count += j - i + 1;
      levels.set(key, e);
      i = j + 1;
    } else i++;
  }
  if (levels.size === 0) return null;
  let most = 0;
  for (const e of levels.values()) most = Math.max(most, e.runs);
  // highest level that is a genuine, repeated clipping plateau
  let bestKey = -1;
  for (const [key, e] of levels) {
    if (e.runs >= Math.max(minRuns, most * 0.2) && key > bestKey) bestKey = key;
  }
  if (bestKey < 0) return null;
  const e = levels.get(bestKey)!;
  const level = e.sum / e.count;
  // A real clipper flattens the TOP of the signal: next to nothing rises above the ceiling (only the odd click). A
  // repeated value in quiet material has loud music above it — "declipping" that rebuilt 160 000 perfectly good samples of
  // a real track and cost it 4 dB. So: if more than 0.05 % of the samples are louder than the plateau it is not a clipper.
  const above = level * 1.05;
  let over = 0;
  for (let q = 0; q < n; q++) if (Math.abs(x[q]) > above) over++;
  if (over > n * 0.0005) return null;
  // count runs on the plateau (±1 step) for the report
  const tol = level * 1e-4;
  let runs = 0;
  let clipped = 0;
  let k = 0;
  while (k < n) {
    if (Math.abs(x[k]) >= level - tol && Math.abs(x[k]) <= level + STEP) {
      const sign = Math.sign(x[k]);
      let j = k;
      while (j + 1 < n && Math.sign(x[j + 1]) === sign && Math.abs(x[j + 1]) >= level - tol && Math.abs(x[j + 1]) <= level + STEP) j++;
      const len = j - k + 1;
      if (len >= 2) { runs++; clipped += len; }
      k = j + 1;
    } else k++;
  }
  if (runs < minRuns) return null;
  return { level, clippedSamples: clipped, runs, fraction: clipped / n };
}

export interface DeclipOptions {
  /** ceiling (linear). Defaults to the detected one. */
  level?: number;
  /** longest run (samples) attempted. Default ≈ 2.5 ms; longer runs have too little signal left to model. */
  maxRun?: number;
  order?: number;
  /** cap on how far above the ceiling a reconstructed peak may go (linear multiple). Default 4 (+12 dB). */
  maxGrowth?: number;
}

export interface DeclipResult {
  runs: number;
  samples: number;
  peakBefore: number;
  peakAfter: number;
  /** the clipping ceiling that was detected (linear) */
  ceiling: number;
  /** the largest value among the reconstructed samples (linear) — how far the peaks were rebuilt */
  maxRepaired: number;
}

/** Declip one channel in place. */
export function declip(x: Float32Array, sampleRate: number, opts: DeclipOptions = {}): DeclipResult {
  const det = opts.level ? null : detectClipping(x);
  const level = opts.level ?? det?.level ?? 0;
  const empty = { runs: 0, samples: 0, peakBefore: 0, peakAfter: 0, ceiling: 0, maxRepaired: 0 };
  if (!(level > 0)) return empty;

  const n = x.length;
  const order = opts.order ?? (sampleRate > 64000 ? 32 : 24);
  const maxRun = opts.maxRun ?? Math.max(8, Math.round(sampleRate * 0.0025));
  const maxGrowth = opts.maxGrowth ?? 4;
  const tol = level * 1e-4;
  let peakBefore = 0;
  for (let i = 0; i < n; i++) peakBefore = Math.max(peakBefore, Math.abs(x[i]));

  let runs = 0;
  let samples = 0;
  let maxRepaired = 0;
  let i = 0;
  while (i < n) {
    if (Math.abs(x[i]) >= level - tol) {
      const sign = Math.sign(x[i]);
      let j = i;
      while (j + 1 < n && Math.sign(x[j + 1]) === sign && Math.abs(x[j + 1]) >= level - tol) j++;
      const len = j - i + 1;
      if (len >= 2 && len <= maxRun) {
        const a = estimateARAround(x, i, j, order);
        if (a && interpolateAR(x, a, i, j)) {
          for (let k = i; k <= j; k++) {
            // the true waveform was at least as large as the ceiling
            const v = sign * x[k];
            x[k] = sign * Math.min(Math.max(v, level), level * maxGrowth);
            if (Math.abs(x[k]) > maxRepaired) maxRepaired = Math.abs(x[k]);
          }
          runs++;
          samples += len;
        }
      }
      i = j + 1;
    } else i++;
  }
  let peakAfter = 0;
  for (let k = 0; k < n; k++) peakAfter = Math.max(peakAfter, Math.abs(x[k]));
  return { runs, samples, peakBefore, peakAfter, ceiling: level, maxRepaired };
}
