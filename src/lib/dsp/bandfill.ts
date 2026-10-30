/**
 * Bandwidth fill (EXPERIMENTAL) for tracks whose top end was cut off by a lossy codec or a generator: MP3 / AAC encoders and many AI
 * music generators leave a brick wall at 14–20 kHz with nothing above it.
 *
 * What this is NOT: it does not recover the lost audio (that information is gone). It adds noise-like "air" above the wall whose level
 * follows, moment by moment, the part of the spectrum just below the wall and continues that part's tilt. It suits cymbals, breath and
 * room; it is a taste decision, off by default, and the original stays one click away.
 *
 * What is guaranteed (and tested): nothing is touched below the cutoff (the synthetic signal is ADDED, the original passes through
 * unchanged), silence stays silent, the fill never exceeds the level it continues, nothing is added to a file that is not band-limited,
 * the result is deterministic.
 *
 * How: (1) a long-term average spectrum is searched for a steep edge followed by a flat floor; (2) per STFT frame, the mean level of
 * the band just below the edge is measured; (3) white noise, passed through the same STFT as a time-varying filter, is shaped to that
 * level extended upward with the measured tilt and a raised-cosine run-in and run-out, then added to the signal.
 */
import { FFT } from '@/lib/fft';
import { stftProcess } from '@/lib/dsp/stft';

export interface BandLimit {
  /** where the spectrum has fallen half way (in dB) between the content and the floor */
  cutoffHz: number;
  /** content level just below the edge minus floor level just above it, dB */
  dropDb: number;
  /** content level just below the edge, dBFS per bin (relative; for display) */
  levelBelowDb: number;
  /** tilt of the spectrum below the edge, dB per octave (≤ 0) */
  slopeDbPerOct: number;
}

const WELCH = 4096;
const MIN_DROP_DB = 28;
const MAX_FLOOR_SPREAD_DB = 7;
const MIN_CUTOFF_HZ = 10000;
const MAX_CUTOFF_HZ = 20000;
const MAX_FRAMES = 360;

const clampDb = (v: number) => (v < -200 ? -200 : v);
const toDb = (p: number) => clampDb(10 * Math.log10(p + 1e-20));

/** Mean power spectrum over the louder half of the file (so a long silent tail does not count as "no content up there"). */
function averagePowerSpectrum(x: Float32Array): Float64Array | null {
  const N = WELCH, hop = N / 2;
  if (x.length < N * 8) return null;
  const frames = Math.floor((x.length - N) / hop) + 1;
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0, s = f * hop; i < N; i += 4) e += x[s + i] * x[s + i];
    energy[f] = e;
  }
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const gate = sorted[Math.floor(frames * 0.5)];
  const active: number[] = [];
  for (let f = 0; f < frames; f++) if (energy[f] >= gate && energy[f] > 1e-12) active.push(f);
  if (active.length < 8) return null;
  const stride = Math.max(1, Math.floor(active.length / MAX_FRAMES));
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const acc = new Float64Array(N / 2 + 1);
  let used = 0;
  for (let a = 0; a < active.length; a += stride) {
    const s = active[a] * hop;
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    for (let k = 0; k <= N / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / (N * N);
    used++;
  }
  for (let k = 0; k < acc.length; k++) acc[k] /= used;
  return acc;
}

/** Search the average spectrum for a steep edge with a flat floor above it. Null when the file is not band-limited in that way. */
export function detectBandLimit(channels: Float32Array[], sampleRate: number): BandLimit | null {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return null;
  const mid = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mid[i] += ch[i] / channels.length;
  const P = averagePowerSpectrum(mid);
  if (!P) return null;
  const df = sampleRate / WELCH;
  const nyq = sampleRate / 2;
  const bin = (hz: number) => Math.max(0, Math.min(P.length - 1, Math.round(hz / df)));
  const meanDb = (lo: number, hi: number) => {
    let s = 0, c = 0;
    for (let k = bin(lo); k <= bin(hi); k++) { s += P[k]; c++; }
    return c ? toDb(s / c) : -200;
  };
  const spreadDb = (lo: number, hi: number) => {
    // standard deviation of the dB values over 5-bin groups: a floor is flat, structure is not
    const vals: number[] = [];
    for (let k = bin(lo); k + 4 <= bin(hi); k += 5) { let s = 0; for (let j = 0; j < 5; j++) s += P[k + j]; vals.push(toDb(s / 5)); }
    if (vals.length < 3) return Infinity;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
  };

  const topHz = Math.min(MAX_CUTOFF_HZ, nyq * 0.93);
  let best: { f: number; drop: number; below: number; above: number } | null = null;
  for (let f = MIN_CUTOFF_HZ; f <= topHz; f += 100) {
    const aboveHi = Math.min(f + 1600, nyq * 0.985);
    if (aboveHi - (f + 450) < 600) continue;                       // not enough room above the edge to see a floor
    const below = meanDb(f - 1100, f - 300);
    const above = meanDb(f + 450, aboveHi);
    const drop = below - above;
    if (!best || drop > best.drop) best = { f, drop, below, above };
  }
  if (!best || best.drop < MIN_DROP_DB) return null;
  if (best.below < -105) return null;                               // nothing audible below the edge either
  if (spreadDb(best.f + 450, Math.min(best.f + 1600, nyq * 0.985)) > MAX_FLOOR_SPREAD_DB) return null;

  // the edge is the frequency where the level has fallen half way to the floor
  const half = (best.below + best.above) / 2;
  let edge = best.f;
  for (let hz = best.f - 900; hz <= best.f + 900; hz += df) {
    if (toDb(P[bin(hz)]) < half) { edge = hz; break; }
  }
  const cutoffHz = Math.round(edge / 50) * 50;
  if (cutoffHz < MIN_CUTOFF_HZ || cutoffHz > MAX_CUTOFF_HZ) return null;

  // tilt of the spectrum below the edge (least squares of dB against log2 f), kept within what music does
  const lo = Math.max(3000, cutoffHz - 7000), hi = cutoffHz - 1200;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
  for (let k = bin(lo); k <= bin(hi); k += 2) {
    const x = Math.log2(Math.max(k * df, 1)), y = toDb((P[k] + P[k + 1]) / 2);
    sx += x; sy += y; sxx += x * x; sxy += x * y; cnt++;
  }
  const denom = cnt * sxx - sx * sx;
  const slope = denom > 1e-9 ? (cnt * sxy - sx * sy) / denom : -9;
  return { cutoffHz, dropDb: best.drop, levelBelowDb: best.below, slopeDbPerOct: Math.max(-18, Math.min(-3, slope)) };
}

export interface FillOptions {
  cutoffHz: number;
  /** tilt used to continue the spectrum upward, dB per octave (≤ 0) */
  slopeDbPerOct?: number;
  /** 0 … 1: share of the continued level that is added (default 0.6, i.e. 4.4 dB under the trend) */
  amount?: number;
  /** the fill ends here (default 20 kHz, never above 0.45 × the sample rate) */
  targetHz?: number;
  seed?: number;
}

export interface FillReport { cutoffHz: number; filledToHz: number; amount: number; slopeDbPerOct: number }

const FRAME = 2048;
const HOP = 512;
const RUN_IN_HZ = 500;
const RUN_OUT_HZ = 1500;

/** mulberry32 → Gaussian by Box–Muller, deterministic */
function gaussianNoise(n: number, seed: number): Float32Array {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297; };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(u())), ph = 2 * Math.PI * u();
    out[i] = r * Math.cos(ph);
    if (i + 1 < n) out[i + 1] = r * Math.sin(ph);
  }
  return out;
}

/** mean magnitude (RMS over bins) of the band just under the edge, per STFT frame; same framing as stftProcess so the two line up */
function sourceLevels(x: Float32Array, loBin: number, hiBin: number): Float64Array {
  const fft = new FFT(FRAME);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = Math.sin((Math.PI * i) / FRAME);
  const padded = new Float32Array(x.length + 2 * FRAME);
  padded.set(x, FRAME);
  const frames = Math.floor((padded.length - FRAME) / HOP) + 1;
  const out = new Float64Array(frames);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const s = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = padded[s + i] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    let p = 0;
    for (let k = loBin; k <= hiBin; k++) p += re[k] * re[k] + im[k] * im[k];
    out[f] = Math.sqrt(p / (hiBin - loBin + 1));
  }
  return out;
}

/** Returns the signal plus the synthetic top end. The input is not modified. */
export function fillBand(x: Float32Array, sampleRate: number, o: FillOptions): { output: Float32Array; report: FillReport } {
  const amount = Math.max(0, Math.min(1, o.amount ?? 0.6));
  const slope = Math.max(-18, Math.min(0, o.slopeDbPerOct ?? -9));
  const target = Math.min(o.targetHz ?? 20000, 0.45 * sampleRate);
  const report: FillReport = { cutoffHz: o.cutoffHz, filledToHz: target, amount, slopeDbPerOct: slope };
  if (amount === 0 || target <= o.cutoffHz + RUN_IN_HZ || x.length < FRAME * 2) return { output: Float32Array.from(x), report: { ...report, filledToHz: o.cutoffHz } };

  const df = sampleRate / FRAME;
  const srcLo = Math.max(1, Math.round((o.cutoffHz - 2500) / df));
  const srcHi = Math.max(srcLo + 1, Math.round((o.cutoffHz - 500) / df));
  const refHz = Math.sqrt(srcLo * df * srcHi * df);
  const levels = sourceLevels(x, srcLo, srcHi);

  // per-bin shape above the edge: tilt × run-in × run-out
  const half = FRAME / 2;
  const shape = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const f = k * df;
    if (f <= o.cutoffHz || f >= target) continue;
    const runIn = f < o.cutoffHz + RUN_IN_HZ ? 0.5 - 0.5 * Math.cos((Math.PI * (f - o.cutoffHz)) / RUN_IN_HZ) : 1;
    const runOut = f > target - RUN_OUT_HZ ? 0.5 + 0.5 * Math.cos((Math.PI * (f - (target - RUN_OUT_HZ))) / RUN_OUT_HZ) : 1;
    shape[k] = amount * Math.pow(10, (slope * Math.log2(f / refHz)) / 20) * runIn * runOut;
  }
  const firstBin = Math.max(0, Math.floor(o.cutoffHz / df));
  const lastBin = Math.min(half, Math.ceil(target / df));
  // white noise of unit variance has E|bin|² = Σ window² = FRAME / 2 in this STFT
  const noiseRef = Math.sqrt(FRAME / 2);
  const noise = gaussianNoise(x.length, o.seed ?? 1);
  const synth = stftProcess(noise, { size: FRAME, hop: HOP }, (re, im, frame) => {
    const e = levels[frame] ?? 0;
    for (let k = 0; k < firstBin; k++) { re[k] = 0; im[k] = 0; }
    for (let k = lastBin + 1; k <= half; k++) { re[k] = 0; im[k] = 0; }
    for (let k = firstBin; k <= lastBin; k++) {
      const g = (e * shape[k]) / noiseRef;
      re[k] *= g; im[k] *= g;
    }
  });
  const output = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) output[i] = x[i] + synth[i];
  return { output, report };
}
