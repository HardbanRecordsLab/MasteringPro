/**
 * Sample-rate conversion by a windowed-sinc polyphase filter (Kaiser window, ≥ 90 dB stopband), zero phase (no delay, no shift of the audio).
 *
 * Why not the browser's own resampler: an OfflineAudioContext with an AudioBufferSourceNode converts the rate by LINEAR INTERPOLATION.
 * Measured in Chrome (48 → 44.1 kHz): a 20 kHz tone loses 5.3 dB, and a 30 kHz tone from a 96 kHz file lands at 14.1 kHz at −8.9 dB
 * (aliasing into the audible band) instead of being removed.
 *
 * Design: the filter is applied at the INPUT rate. Passband 0–0.4535·f, stopband from 0.5465·f, where f is the lower of the two rates
 * (20 kHz / 24.1 kHz for 44.1 kHz), so everything audible passes flat and everything that would alias is gone; only the 20–22 kHz edge is
 * allowed to roll off. The rate ratio is reduced to L/M, so every output sample uses one of L exactly precomputed phases; for odd rates
 * with L > MAX_PHASES a table of MAX_PHASES phases with linear interpolation between neighbours is used (error below −100 dB).
 */
const STOPBAND_DB = 96;
const PASS_EDGE = 20000 / 44100;        // fraction of the lower rate that must pass flat
const MAX_PHASES = 2048;
const YIELD_EVERY = 1 << 19;            // output samples between yielding to the browser

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function bessel0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 60; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-14 * sum) break; }
  return sum;
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

export interface ResamplerPlan {
  /** taps on each side of the centre */
  half: number;
  /** distinct output phases (L after reducing the ratio, capped at MAX_PHASES) */
  phases: number;
  /** true when the ratio is exact in `phases` (no interpolation between phases) */
  exact: boolean;
  /** input samples advanced per L output samples, after reduction */
  step: number;
  /** [phases + 1][2 * half] kernel table, each row summing to 1 */
  table: Float64Array;
}

export function planResampler(fromRate: number, toRate: number): ResamplerPlan {
  const g = gcd(Math.round(fromRate), Math.round(toRate));
  const L = Math.round(toRate) / g;
  const M = Math.round(fromRate) / g;
  const exact = L <= MAX_PHASES;
  const phases = exact ? L : MAX_PHASES;
  const lower = Math.min(fromRate, toRate);
  const cutoff = 0.5 * lower / fromRate;                                  // cycles per input sample, centre of the transition
  const transition = (1 - 2 * PASS_EDGE) * lower / fromRate;              // 0.0930 · lower rate, in cycles per input sample
  const taps = Math.ceil((STOPBAND_DB - 7.95) / (2.285 * 2 * Math.PI * transition));
  const half = Math.max(8, Math.ceil(taps / 2));
  const beta = 0.1102 * (STOPBAND_DB - 8.7);
  const i0 = bessel0(beta);
  const width = 2 * half;
  const table = new Float64Array((phases + 1) * width);
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    let sum = 0;
    for (let j = 0; j < width; j++) {
      const x = frac - (j - half + 1);                                   // distance from the output instant to input sample base + (j − half + 1)
      const r = x / half;
      const w = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0;
      const v = 2 * cutoff * sinc(2 * cutoff * x) * w;
      table[p * width + j] = v;
      sum += v;
    }
    for (let j = 0; j < width; j++) table[p * width + j] /= sum;         // exactly unity gain at DC for every phase
  }
  return { half, phases, exact, step: M, table };
}

export const resampledLength = (length: number, fromRate: number, toRate: number) => Math.max(1, Math.ceil((length * toRate) / fromRate));

/**
 * All channels in one pass (the weights of an output sample are computed once). Yields to the event loop now and then so a long track
 * does not freeze the page. Equal rates return copies of the input.
 */
export async function resampleChannels(channels: Float32Array[], fromRate: number, toRate: number): Promise<Float32Array[]> {
  if (Math.abs(fromRate - toRate) < 0.5) return channels.map((c) => Float32Array.from(c));
  const n = channels[0].length;
  const outLen = resampledLength(n, fromRate, toRate);
  const outs = channels.map(() => new Float32Array(outLen));
  const { half, phases, exact, table } = planResampler(fromRate, toRate);
  const g = gcd(Math.round(fromRate), Math.round(toRate));
  const L = Math.round(toRate) / g;
  const M = Math.round(fromRate) / g;
  const width = 2 * half;
  const w = new Float64Array(width);
  const nCh = channels.length;
  for (let o = 0; o < outLen; o++) {
    const num = o * M;                                                    // exact in a double up to 2^53
    const base = Math.floor(num / L);
    let row: Float64Array | null = null;
    let off = 0;
    if (exact) {
      off = (num - base * L) * width;
    } else {
      const pos = ((num - base * L) / L) * phases;
      const p = Math.min(phases - 1, Math.floor(pos));
      const a = pos - p;
      const t0 = p * width, t1 = t0 + width;
      for (let j = 0; j < width; j++) w[j] = table[t0 + j] * (1 - a) + table[t1 + j] * a;
      row = w;
    }
    const first = base - half + 1;
    const lo = Math.max(0, -first), hi = Math.min(width, n - first);
    for (let c = 0; c < nCh; c++) {
      const x = channels[c];
      let acc = 0;
      if (row) for (let j = lo; j < hi; j++) acc += x[first + j] * row[j];
      else for (let j = lo; j < hi; j++) acc += x[first + j] * table[off + j];
      outs[c][o] = acc;
    }
    if ((o & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return outs;
}
