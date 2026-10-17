/**
 * Track profile: everything the matcher needs to know about a mix, measured once.
 *
 *  - long-term average spectrum of MID and SIDE on a 1/6-octave grid, with quiet passages gated out
 *  - per-band (5 bands) distribution of the short-term level → dynamic range inside each band
 *  - per-band side-to-mid energy ratio → how wide the mix is, and where
 *  - loudness and crest factor
 *
 * Levels are in the detector scale of the multiband compressor: 10·log10 of the band power, so a sine reads as its peak
 * amplitude in dBFS. That makes a threshold derived from the profile directly usable in the compressor.
 */
import { FFT, hann } from '@/lib/fft';
import { measureLoudness } from '@/lib/loudness';

export const DEFAULT_BAND_EDGES = [100, 500, 2500, 8000];
const FFT_SIZE = 8192;
const MAX_FRAMES = 1400;

export interface BandStat {
  p10: number;
  p50: number;
  p95: number;
}

export interface TrackProfile {
  sampleRate: number;
  durationSec: number;
  freqs: number[];
  midDb: number[];
  sideDb: number[];
  edges: number[];
  /** short-term band level distribution, dB (detector scale) */
  level: BandStat[];
  /** p95 − p10 per band, dB */
  dynRange: number[];
  /** side power / mid power per band, dB (−∞ clamps to −60) */
  sideToMid: number[];
  lufs: number;
  lra: number;
  truePeakDb: number;
  /** sample peak − RMS, dB */
  crestDb: number;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return -120;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

const toDb = (p: number) => 10 * Math.log10(p + 1e-20);

export function gridFrequencies(sampleRate: number, points = 100): number[] {
  const lo = 25;
  const hi = Math.min(18000, sampleRate * 0.45);
  return Array.from({ length: points }, (_, i) => lo * Math.pow(hi / lo, i / (points - 1)));
}

export function analyzeProfile(buffer: AudioBuffer, edges: number[] = DEFAULT_BAND_EDGES): TrackProfile {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const fft = new FFT(FFT_SIZE);
  const win = hann(FFT_SIZE);
  let wsum = 0;
  for (let i = 0; i < FFT_SIZE; i++) wsum += win[i];
  const norm = Math.pow(2 / wsum, 2);                  // amplitude² calibration: full-scale sine → 0 dB
  const bins = FFT_SIZE / 2 + 1;
  const binHz = sr / FFT_SIZE;

  const total = Math.max(1, Math.floor((n - FFT_SIZE) / (FFT_SIZE / 2)) + 1);
  const frames = Math.min(MAX_FRAMES, total);
  const hop = total > frames ? (n - FFT_SIZE) / (frames - 1) : FFT_SIZE / 2;

  // pass 1: frame levels (to gate out silence and fade-outs)
  const levels: number[] = [];
  const starts: number[] = [];
  const frameBuf = new Float64Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const start = Math.min(n - FFT_SIZE, Math.round(f * hop));
    if (start < 0) break;
    // total energy of both channels, not just the mid: a pure-side signal must not look silent to the gate
    let s = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const l = L[start + i], r = R ? R[start + i] : l;
      s += (l * l + r * r) * 0.5;
    }
    levels.push(10 * Math.log10(s / FFT_SIZE + 1e-20));
    starts.push(start);
  }
  const maxLevel = Math.max(...levels, -120);
  const gate = Math.max(maxLevel - 40, -75);

  // band bin ranges
  const bandBins = (lo: number, hi: number): [number, number] => [Math.max(1, Math.round(lo / binHz)), Math.min(bins - 1, Math.round(hi / binHz))];
  const bounds = [20, ...edges, Math.min(20000, sr / 2)];
  const bandRanges = bounds.slice(0, -1).map((lo, i) => bandBins(lo, bounds[i + 1]));

  const accM = new Float64Array(bins);
  const accS = new Float64Array(bins);
  const bandLevels: number[][] = bandRanges.map(() => []);
  const bandS = new Float64Array(bandRanges.length);
  const bandM = new Float64Array(bandRanges.length);
  const magM = new Float64Array(bins);
  const magS = new Float64Array(bins);
  let used = 0;

  for (let f = 0; f < starts.length; f++) {
    if (levels[f] < gate) continue;
    const start = starts[f];
    for (let i = 0; i < FFT_SIZE; i++) {
      frameBuf[i] = (R ? (L[start + i] + R[start + i]) * 0.5 : L[start + i]) * win[i];
    }
    fft.magnitude(frameBuf, magM);
    if (R) {
      for (let i = 0; i < FFT_SIZE; i++) frameBuf[i] = (L[start + i] - R[start + i]) * 0.5 * win[i];
      fft.magnitude(frameBuf, magS);
    } else magS.fill(0);

    for (let k = 0; k < bins; k++) {
      const pm = magM[k] * magM[k] * norm;
      const ps = magS[k] * magS[k] * norm;
      accM[k] += pm;
      accS[k] += ps;
    }
    bandRanges.forEach(([a, b], bi) => {
      let pm = 0, ps = 0;
      for (let k = a; k <= b; k++) { pm += magM[k] * magM[k] * norm; ps += magS[k] * magS[k] * norm; }
      bandLevels[bi].push(toDb(pm));
      bandM[bi] += pm;
      bandS[bi] += ps;
    });
    used++;
  }
  if (used === 0) used = 1;

  // 1/6-octave grid, averaged over ± 1/12 octave
  const freqs = gridFrequencies(sr);
  const toGrid = (acc: Float64Array) =>
    freqs.map((fc) => {
      const lo = fc / Math.pow(2, 1 / 12);
      const hi = fc * Math.pow(2, 1 / 12);
      let a = Math.floor(lo / binHz), b = Math.ceil(hi / binHz);
      a = Math.max(1, a); b = Math.min(bins - 1, Math.max(a, b));
      let p = 0;
      for (let k = a; k <= b; k++) p += acc[k];
      return toDb((p / (b - a + 1)) / used);
    });

  const level = bandLevels.map((arr) => {
    const sorted = arr.slice().sort((x, y) => x - y);
    return { p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
  });

  const loud = measureLoudness(buffer);
  let peak = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const m = R ? (L[i] + R[i]) * 0.5 : L[i];
    const a = Math.abs(m);
    if (a > peak) peak = a;
    sq += m * m;
  }
  const rmsDb = 10 * Math.log10(sq / Math.max(1, n) + 1e-20);   // mean-square in dB = RMS level in dBFS

  return {
    sampleRate: sr,
    durationSec: n / sr,
    freqs,
    midDb: toGrid(accM),
    sideDb: toGrid(accS),
    edges,
    level,
    dynRange: level.map((l) => l.p95 - l.p10),
    sideToMid: Array.from(bandM).map((m, i) => Math.max(-60, toDb(bandS[i]) - toDb(m))),
    lufs: loud.integrated,
    lra: loud.lra,
    truePeakDb: loud.truePeak,
    crestDb: 20 * Math.log10(peak + 1e-12) - rmsDb,
  };
}
