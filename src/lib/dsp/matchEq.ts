/**
 * Match EQ: turn a smooth gain curve (dB over frequency) into a minimum-phase FIR filter.
 *
 * A minimum-phase filter has the shortest possible delay and no pre-ringing, which is what you want on a mastering bus:
 * boosts and cuts act exactly where the curve says, without smearing transients backwards in time.
 * Design by the cepstral method (Oppenheim & Schafer): log-magnitude → real cepstrum → fold onto causal part → exp → IFFT.
 */
import { FFT } from '@/lib/fft';

export interface MatchCurve {
  /** ascending frequencies, Hz */
  f: number[];
  /** gain at each frequency, dB */
  g: number[];
}

const N = 16384;

/** gain in dB at frequency `hz`, linear interpolation over log-frequency, flat beyond the ends */
export function curveAt(c: MatchCurve, hz: number): number {
  const { f, g } = c;
  if (f.length === 0) return 0;
  if (hz <= f[0]) return g[0];
  if (hz >= f[f.length - 1]) return g[g.length - 1];
  let lo = 0;
  let hi = f.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid] <= hz) lo = mid; else hi = mid;
  }
  const t = Math.log(hz / f[lo]) / Math.log(f[hi] / f[lo]);
  return g[lo] + (g[hi] - g[lo]) * t;
}

/**
 * @param amount 0 … 1 scales the curve in dB (0 = flat, 1 = full match)
 * @param length FIR taps (default 2048 ≈ 43 ms at 48 kHz; plenty for a smooth, broad curve)
 */
export function designMinPhaseFir(curve: MatchCurve, amount: number, sampleRate: number, length = 2048): Float32Array {
  const fft = new FFT(N);
  const half = N / 2;
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // log-magnitude on the full (symmetric) spectrum
  for (let k = 0; k <= half; k++) {
    const hz = (k * sampleRate) / N;
    const db = curveAt(curve, Math.max(hz, 1)) * amount;
    const ln = (db / 20) * Math.LN10;
    re[k] = ln;
    if (k > 0 && k < half) re[N - k] = ln;
  }
  // real cepstrum: for a real, symmetric input the forward FFT equals N · IFFT
  fft.transform(re, im);
  const c = new Float64Array(N);
  for (let n = 0; n < N; n++) c[n] = re[n] / N;

  // fold to the causal (minimum-phase) cepstrum
  const cm = new Float64Array(N);
  cm[0] = c[0];
  for (let n = 1; n < half; n++) cm[n] = 2 * c[n];
  cm[half] = c[half];

  // H = exp(FFT(cm))
  const r2 = Float64Array.from(cm);
  const i2 = new Float64Array(N);
  fft.transform(r2, i2);
  for (let k = 0; k < N; k++) {
    const mag = Math.exp(r2[k]);
    const ph = i2[k];
    r2[k] = mag * Math.cos(ph);
    i2[k] = mag * Math.sin(ph);
  }
  // inverse FFT via the conjugate trick
  for (let k = 0; k < N; k++) i2[k] = -i2[k];
  fft.transform(r2, i2);

  const out = new Float32Array(length);
  const fade = Math.floor(length * 0.25);
  for (let n = 0; n < length; n++) {
    let w = 1;
    if (n >= length - fade) w = 0.5 + 0.5 * Math.cos((Math.PI * (n - (length - fade))) / fade);
    out[n] = (r2[n] / N) * w;
  }
  return out;
}

/** magnitude response (dB) of an FIR at `hz` — for verification and for drawing the curve */
export function firResponseDb(fir: Float32Array, hz: number, sampleRate: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let n = 0; n < fir.length; n++) {
    re += fir[n] * Math.cos(w * n);
    im -= fir[n] * Math.sin(w * n);
  }
  return 20 * Math.log10(Math.hypot(re, im) + 1e-12);
}
