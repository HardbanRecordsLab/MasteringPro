/**
 * Whole-file spectral analysis via Welch's method (averaged overlapping FFTs).
 * Replaces the old single-43 ms-window DFT — every tonal metric now reflects the
 * entire track, calibrated so a full-scale sine reads ~0 dBFS.
 */
import { FFT, hann } from '@/lib/fft';

export interface Spectrum {
  /** Linear-bin power spectral density, calibrated dBFS. */
  binFreqs: Float32Array;
  binDb: Float32Array;
  /** ISO 1/3-octave rollup, 20 Hz … 20 kHz. */
  thirdOctaveCenters: Float32Array;
  thirdOctaveDb: Float32Array;
  sampleRate: number;
  fftSize: number;
}

const ISO_THIRD_OCTAVE = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
  12500, 16000, 20000,
];

/**
 * @param fftSize power of two; 8192 ≈ 5.9 Hz bins at 48 k — enough for tonal work.
 * @param maxFrames cap the number of averaged frames on very long files.
 */
export function analyzeSpectrum(
  buffer: AudioBuffer,
  fftSize = 8192,
  maxFrames = 512,
): Spectrum {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  // Amplitude normalisation (coherent gain): a full-scale sine peaks near 0 dBFS.
  let winSum = 0;
  for (let i = 0; i < fftSize; i++) winSum += win[i];
  const ampNorm = 2 / winSum; // ·2 folds the negative-frequency half in
  const norm = ampNorm * ampNorm; // amplitude² → power

  const bins = fftSize / 2 + 1;
  const acc = new Float64Array(bins);
  const frame = new Float64Array(fftSize);
  const mag = new Float64Array(bins);

  const usable = Math.max(0, n - fftSize);
  const wantFrames = Math.min(maxFrames, Math.max(1, Math.floor(usable / (fftSize / 2)) + 1));
  const hop = wantFrames > 1 ? Math.floor(usable / (wantFrames - 1)) : fftSize;

  let frames = 0;
  for (let start = 0; start + fftSize <= n; start += hop) {
    for (let i = 0; i < fftSize; i++) {
      const s = ch1 ? (ch0[start + i] + ch1[start + i]) * 0.5 : ch0[start + i];
      frame[i] = s * win[i];
    }
    fft.magnitude(frame, mag);
    for (let k = 0; k < bins; k++) acc[k] += mag[k] * mag[k];
    frames++;
    if (frames >= wantFrames) break;
  }
  if (frames === 0) frames = 1;

  const binFreqs = new Float32Array(bins);
  const binDb = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    binFreqs[k] = (k * sr) / fftSize;
    const power = (acc[k] / frames) * norm;
    binDb[k] = 10 * Math.log10(power + 1e-20);
  }

  // ---- 1/3-octave rollup (sum bin power within each band) ----
  const centers = ISO_THIRD_OCTAVE.filter((f) => f < sr / 2);
  const toc = new Float32Array(centers.length);
  const r = Math.pow(2, 1 / 6);
  for (let b = 0; b < centers.length; b++) {
    const lo = centers[b] / r;
    const hi = centers[b] * r;
    let p = 0;
    for (let k = 1; k < bins; k++) {
      const f = binFreqs[k];
      if (f >= lo && f < hi) p += (acc[k] / frames) * norm;
    }
    toc[b] = 10 * Math.log10(p + 1e-20);
  }

  return {
    binFreqs,
    binDb,
    thirdOctaveCenters: new Float32Array(centers),
    thirdOctaveDb: toc,
    sampleRate: sr,
    fftSize,
  };
}

/** Energy (dB) integrated over [lo, hi] Hz from a computed spectrum. */
export function bandDb(s: Spectrum, lo: number, hi: number): number {
  let p = 0;
  for (let k = 1; k < s.binFreqs.length; k++) {
    const f = s.binFreqs[k];
    if (f >= lo && f < hi) p += Math.pow(10, s.binDb[k] / 10);
  }
  return 10 * Math.log10(p + 1e-20);
}

/** Power-weighted mean frequency (Hz) — perceived brightness. */
export function spectralCentroid(s: Spectrum): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k < s.binFreqs.length; k++) {
    const f = s.binFreqs[k];
    if (f < 20 || f > 20000) continue;
    const p = Math.pow(10, s.binDb[k] / 10);
    num += f * p;
    den += p;
  }
  return den > 0 ? num / den : 0;
}

/** Least-squares slope of level vs log2(freq), in dB/octave (100 Hz … 10 kHz). */
export function spectralTilt(s: Spectrum): number {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = 1; k < s.binFreqs.length; k++) {
    const f = s.binFreqs[k];
    if (f < 100 || f > 10000) continue;
    const x = Math.log2(f);
    const y = s.binDb[k];
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  if (n < 2) return 0;
  const denom = n * sxx - sx * sx;
  return denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
}
