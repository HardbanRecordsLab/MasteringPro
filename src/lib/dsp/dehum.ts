/**
 * Mains hum removal (50 / 60 Hz and harmonics).
 *
 * Detection looks for narrow spectral lines at the mains frequency and its harmonics that stand clearly above their
 * own neighbourhood in a long-window (≈ 0.7 Hz resolution) averaged spectrum. Removal uses very narrow notch filters
 * run forward AND backward (zero phase), so the rest of the audio keeps its timing and phase.
 */
import { FFT, hann } from '@/lib/fft';

export interface HumDetection {
  /** mains fundamental (50 or 60) */
  fundamental: number;
  /** frequencies that stand out and will be notched (Hz) */
  lines: number[];
  /** prominence of the fundamental above its neighbourhood (dB) */
  prominenceDb: number;
}

const FFT_SIZE = 32768;          // 1.5 Hz bins at 48 kHz
const MAX_SEGMENTS = 24;
const MAX_HZ = 4500;

/**
 * Per-bin LOWER-QUARTILE magnitude over many overlapping segments. Mains hum is stationary, so it is present in every
 * segment and survives; a musical partial that sits on the same frequency comes and goes, so its lower quartile
 * collapses. This is what keeps a 110 Hz bass note from being mistaken for the 100 Hz hum harmonic.
 */
function longSpectrum(x: Float32Array, sr: number): { mag: Float64Array; binHz: number } | null {
  if (x.length < FFT_SIZE * 3) return null;
  const fft = new FFT(FFT_SIZE);
  const win = hann(FFT_SIZE);
  const bins = FFT_SIZE / 2 + 1;
  const maxBin = Math.min(bins - 1, Math.ceil((MAX_HZ * FFT_SIZE) / sr));
  const hop = FFT_SIZE / 2;
  const total = Math.floor((x.length - FFT_SIZE) / hop) + 1;
  const segs = Math.min(MAX_SEGMENTS, total);
  const stride = total > segs ? (total - 1) / (segs - 1) : 1;
  const frame = new Float64Array(FFT_SIZE);
  const mag = new Float64Array(bins);
  const per: Float64Array[] = [];
  for (let s = 0; s < segs; s++) {
    const start = Math.round(s * stride) * hop;
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = x[start + i] * win[i];
    fft.magnitude(frame, mag);
    per.push(Float64Array.from(mag.subarray(0, maxBin + 1)));
  }
  const out = new Float64Array(bins);
  const col = new Float64Array(segs);
  for (let k = 0; k <= maxBin; k++) {
    for (let s = 0; s < segs; s++) col[s] = per[s][k];
    const sorted = Array.from(col).sort((a, b) => a - b);
    out[k] = sorted[Math.floor((segs - 1) * 0.25)];
  }
  return { mag: out, binHz: sr / FFT_SIZE };
}

function prominence(mag: Float64Array, binHz: number, f: number): number {
  const centre = Math.round(f / binHz);
  const reach = Math.max(1, Math.round(1 / binHz));
  let peak = 0;
  for (let k = centre - reach; k <= centre + reach; k++) if (k >= 0 && k < mag.length) peak = Math.max(peak, mag[k]);
  const side: number[] = [];
  const near = Math.round(3 / binHz);
  const far = Math.round(12 / binHz);
  for (let d = near; d <= far; d++) {
    if (centre - d >= 0) side.push(mag[centre - d]);
    if (centre + d < mag.length) side.push(mag[centre + d]);
  }
  if (!side.length) return 0;
  side.sort((a, b) => a - b);
  const med = side[side.length >> 1] + 1e-15;
  return 20 * Math.log10(peak / med + 1e-12);
}

export function detectHum(x: Float32Array, sampleRate: number): HumDetection | null {
  const sp = longSpectrum(x, sampleRate);
  if (!sp) return null;
  let best: HumDetection | null = null;
  let bestScore = 0;
  for (const f0 of [50, 60]) {
    const lines: number[] = [];
    let score = 0;
    let fundProm = 0;
    for (let h = 1; h <= 16; h++) {
      const f = f0 * h;
      if (f > 4000 || f > sampleRate / 2 - 100) break;
      const p = prominence(sp.mag, sp.binHz, f);
      if (h === 1) fundProm = p;
      if (p >= 9) { lines.push(f); score += p; }
    }
    const strong = lines.filter((_, i) => i >= 0).length;
    if ((fundProm >= 10 || strong >= 3) && score > bestScore) {
      bestScore = score;
      best = { fundamental: f0, lines, prominenceDb: fundProm };
    }
  }
  return best;
}

/** RBJ notch coefficients */
function notch(sr: number, f: number, q: number) {
  const w0 = (2 * Math.PI * f) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: (-2 * cosw) / a0, b2: 1 / a0, a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0 };
}

function biquadInPlace(x: Float32Array, c: ReturnType<typeof notch>, reverse: boolean) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = x[i];
    const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** Notch out `lines` (Hz) from one channel, in place, zero-phase. */
export function dehum(x: Float32Array, sampleRate: number, lines: number[], q = 40): void {
  for (const f of lines) {
    if (f <= 0 || f >= sampleRate / 2) continue;
    const c = notch(sampleRate, f, q);
    biquadInPlace(x, c, false);
    biquadInPlace(x, c, true);
  }
}
