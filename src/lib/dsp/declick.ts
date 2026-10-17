/**
 * Click / crackle removal.
 *
 * Detection uses the prediction error of an AR model in BOTH time directions. A click at samples [j, j+L) pushes the
 * forward error up on [j, j+L+p) (the corrupted samples feed the next p predictions) and the backward error up on
 * (j-p, j+L-1]. Only the damaged samples exceed the threshold in both, so the intersection pins the click exactly,
 * while a musical onset (unpredictable forward, perfectly predictable backward from its own decay) is not touched.
 *
 * Repair is the least-squares AR interpolation from `ar.ts`.
 */
import { autocorrelation, estimateARAround, interpolateAR, levinson } from '@/lib/dsp/ar';

export interface DeclickOptions {
  /** 1 (conservative) … 10 (aggressive). Default 5. */
  sensitivity?: number;
  /** Longest burst (samples) treated as a click. Longer events are assumed to be music. Default ≈ 1 ms. */
  maxLength?: number;
  /** AR model order. Default 24 (32 above 64 kHz). */
  order?: number;
  /** Detect → repair passes (a second pass catches clicks that were masked by neighbours). Default 2. */
  passes?: number;
}

export interface DeclickResult {
  /** number of repaired bursts */
  bursts: number;
  /** number of repaired samples */
  samples: number;
}

const BLOCK = 2048;
const SUB = 512;
/** residual must also exceed this absolute level (≈ −52 dBFS) so dither / noise floor is never "repaired" */
const ABS_MIN = 0.0025;

function medianAbs(a: Float32Array, from: number, to: number, scratch: Float32Array): number {
  const n = to - from;
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) scratch[i] = Math.abs(a[from + i]);
  const s = scratch.subarray(0, n);
  s.sort();
  return s[n >> 1];
}

function detect(x: Float32Array, order: number, T: number, maxLen: number): Array<[number, number]> {
  const n = x.length;
  const bursts: Array<[number, number]> = [];
  if (n < BLOCK + 2 * order) return bursts;
  const ef = new Float32Array(BLOCK);
  const eb = new Float32Array(BLOCK);
  const scratch = new Float32Array(SUB);
  const flag = new Uint8Array(BLOCK);

  for (let b0 = order; b0 < n - order; b0 += BLOCK) {
    const b1 = Math.min(n - order, b0 + BLOCK);
    const len = b1 - b0;
    const r = autocorrelation(x, Math.max(0, b0 - 512), Math.min(n, b1 + 512), order);
    if (!(r[0] > 1e-14)) continue;
    const { a } = levinson(r, order);

    for (let i = 0; i < len; i++) {
      const t = b0 + i;
      let pf = 0;
      let pb = 0;
      for (let k = 0; k < order; k++) {
        pf += a[k] * x[t - 1 - k];
        pb += a[k] * x[t + 1 + k];
      }
      ef[i] = x[t] - pf;
      eb[i] = x[t] - pb;
    }

    flag.fill(0, 0, len);
    for (let s0 = 0; s0 < len; s0 += SUB) {
      const s1 = Math.min(len, s0 + SUB);
      const sigF = medianAbs(ef, s0, s1, scratch) / 0.6745;
      const sigB = medianAbs(eb, s0, s1, scratch) / 0.6745;
      const thF = Math.max(T * sigF, ABS_MIN);
      const thB = Math.max(T * sigB, ABS_MIN);
      for (let i = s0; i < s1; i++) {
        if (Math.abs(ef[i]) > thF && Math.abs(eb[i]) > thB) flag[i] = 1;
      }
    }

    // contiguous flagged runs (gap ≤ 1) → bursts, dilated by one sample on each side
    let i = 0;
    while (i < len) {
      if (!flag[i]) { i++; continue; }
      let j = i;
      while (j + 2 < len && (flag[j + 1] || flag[j + 2])) j++;
      const s = b0 + i - 1;
      const e = b0 + j + 1;
      if (e - s + 1 <= maxLen) bursts.push([s, e]);
      i = j + 1;
    }
  }
  // merge bursts that touch or overlap
  const merged: Array<[number, number]> = [];
  for (const bu of bursts) {
    const last = merged[merged.length - 1];
    if (last && bu[0] <= last[1] + 2) last[1] = Math.max(last[1], bu[1]);
    else merged.push([bu[0], bu[1]]);
  }
  return merged;
}

/** Detection only: how many click bursts would be repaired (used for the diagnosis, nothing is modified). */
export function countClicks(x: Float32Array, sampleRate: number, opts: DeclickOptions = {}): number {
  const sensitivity = Math.min(10, Math.max(1, opts.sensitivity ?? 5));
  const order = opts.order ?? (sampleRate > 64000 ? 32 : 24);
  const maxLen = opts.maxLength ?? Math.max(8, Math.round(sampleRate * 0.001));
  return detect(x, order, 9 - 0.6 * sensitivity, maxLen).length;
}

/** Remove clicks from one channel, in place. */
export function declick(x: Float32Array, sampleRate: number, opts: DeclickOptions = {}): DeclickResult {
  const sensitivity = Math.min(10, Math.max(1, opts.sensitivity ?? 5));
  const T = 9 - 0.6 * sensitivity; // 8.4 … 3.0 robust sigmas
  const order = opts.order ?? (sampleRate > 64000 ? 32 : 24);
  const maxLen = opts.maxLength ?? Math.max(8, Math.round(sampleRate * 0.001));
  const passes = Math.max(1, opts.passes ?? 2);

  let bursts = 0;
  let samples = 0;
  for (let pass = 0; pass < passes; pass++) {
    const found = detect(x, order, T, maxLen);
    if (found.length === 0) break;
    for (const [s, e] of found) {
      const a = estimateARAround(x, s, e, order);
      if (a) {
        interpolateAR(x, a, s, e);
        bursts++;
        samples += e - s + 1;
      }
    }
  }
  return { bursts, samples };
}
