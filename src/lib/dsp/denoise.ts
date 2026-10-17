/**
 * Broadband noise reduction (hiss, room noise, tape / amp noise).
 *
 * STFT Wiener filter with a decision-directed a-priori SNR estimate (Ephraim & Malah 1984). The decision-directed
 * recursion smooths the gain over time, which is what keeps the artefact known as "musical noise" (warbling
 * residue) from appearing. The noise spectrum is either supplied or learned automatically from the quietest
 * passages of the file.
 */
import { FFT } from '@/lib/fft';
import { stftProcess } from '@/lib/dsp/stft';

const SIZE = 2048;

export interface NoiseProfile {
  /** per-bin noise power of the sqrt-Hann-windowed frame (bins 0 … SIZE/2) */
  psd: Float64Array;
  /** estimated noise floor, dBFS RMS */
  floorDb: number;
  /** 0 … 1 — low when the file has no passage that is clearly quieter than the rest */
  confidence: number;
  frames: number;
}

function frameRms(x: Float32Array, start: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) s += x[start + i] * x[start + i];
  return Math.sqrt(s / len);
}

/** Learn the noise spectrum from the quietest non-silent ~10 % of the file. */
export function estimateNoiseProfile(x: Float32Array, sampleRate: number): NoiseProfile | null {
  const n = x.length;
  if (n < SIZE * 8) return null;
  const hop = SIZE / 2;
  const rmsList: Array<{ start: number; rms: number }> = [];
  for (let s = 0; s + SIZE <= n; s += hop) rmsList.push({ start: s, rms: frameRms(x, s, SIZE) });
  const audible = rmsList.filter((f) => f.rms > 1e-5); // ignore digital silence (≈ −100 dBFS)
  if (audible.length < 16) return null;
  const sorted = audible.slice().sort((a, b) => a.rms - b.rms);
  const take = Math.max(8, Math.min(400, Math.floor(sorted.length * 0.1)));
  const quiet = sorted.slice(0, take);

  const fft = new FFT(SIZE);
  const win = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) win[i] = Math.sin((Math.PI * i) / SIZE);
  const bins = SIZE / 2 + 1;
  const psd = new Float64Array(bins);
  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  let pw = 0;
  for (const f of quiet) {
    for (let i = 0; i < SIZE; i++) { re[i] = x[f.start + i] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    for (let k = 0; k < bins; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    pw += f.rms * f.rms;
  }
  for (let k = 0; k < bins; k++) psd[k] /= quiet.length;
  // light smoothing across frequency: a noise PSD is smooth, a few lucky bins are not
  const sm = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let s = 0, c = 0;
    for (let d = -3; d <= 3; d++) { const j = k + d; if (j >= 0 && j < bins) { s += psd[j]; c++; } }
    sm[k] = s / c;
  }
  const floorDb = 20 * Math.log10(Math.sqrt(pw / quiet.length) + 1e-12);
  const medianRms = sorted[sorted.length >> 1].rms;
  const spreadDb = 20 * Math.log10(medianRms / (quiet[quiet.length >> 1].rms + 1e-12));
  const confidence = Math.max(0, Math.min(1, (spreadDb - 3) / 15));
  void sampleRate;
  return { psd: sm, floorDb, confidence, frames: quiet.length };
}

export interface DenoiseOptions {
  /** maximum attenuation of noise-only components. Default 12 dB. */
  reductionDb?: number;
  /** scales the noise estimate: > 1 removes more (and risks artefacts), < 1 is gentler. Default 1. */
  sensitivity?: number;
  /** 0 … 1 — more smoothing = fewer artefacts, slower reaction to transients. Default 0.6. */
  smoothing?: number;
  /** noise spectrum; learned from the file when omitted */
  profile?: NoiseProfile | null;
}

export interface DenoiseResult {
  output: Float32Array;
  profile: NoiseProfile | null;
  /** noise floor of the output (same estimator as the input) */
  floorAfterDb: number | null;
}

/** Denoise one channel. Returns a new array. */
export function denoise(
  x: Float32Array,
  sampleRate: number,
  opts: DenoiseOptions = {},
  onProgress?: (f: number) => void,
): DenoiseResult {
  const profile = opts.profile === undefined ? estimateNoiseProfile(x, sampleRate) : opts.profile;
  if (!profile) return { output: Float32Array.from(x), profile: null, floorAfterDb: null };

  const reduction = Math.min(40, Math.max(0, opts.reductionDb ?? 12));
  const gMin = Math.pow(10, -reduction / 20);
  const sens = Math.min(4, Math.max(0.25, opts.sensitivity ?? 1));
  const smoothing = Math.min(1, Math.max(0, opts.smoothing ?? 0.6));
  const alpha = 0.90 + 0.09 * smoothing;       // decision-directed memory 0.90 … 0.99
  const bins = SIZE / 2 + 1;
  const lambda = new Float64Array(bins);
  for (let k = 0; k < bins; k++) lambda[k] = Math.max(profile.psd[k] * sens, 1e-24);

  const prevClean = new Float64Array(bins); // |Ĝ·Y|² of the previous frame
  const g = new Float64Array(bins);
  const gs = new Float64Array(bins);
  let first = true;

  const output = stftProcess(
    x,
    { size: SIZE, hop: SIZE / 4 },
    (re, im) => {
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        const gamma = p / lambda[k];
        const xi = first
          ? Math.max(gamma - 1, 0)
          : alpha * (prevClean[k] / lambda[k]) + (1 - alpha) * Math.max(gamma - 1, 0);
        g[k] = xi / (1 + xi);
      }
      first = false;
      // smooth the gain across frequency (3-tap) — removes isolated "lucky" bins
      for (let k = 0; k < bins; k++) {
        const a = g[k > 0 ? k - 1 : k];
        const b = g[k];
        const c = g[k < bins - 1 ? k + 1 : k];
        gs[k] = 0.25 * a + 0.5 * b + 0.25 * c;
      }
      for (let k = 0; k < bins; k++) {
        const gain = Math.max(gMin, gs[k]);
        re[k] *= gain;
        im[k] *= gain;
        prevClean[k] = (re[k] * re[k] + im[k] * im[k]);
      }
    },
    onProgress,
  );

  const after = estimateNoiseProfile(output, sampleRate);
  return { output, profile, floorAfterDb: after ? after.floorDb : null };
}
