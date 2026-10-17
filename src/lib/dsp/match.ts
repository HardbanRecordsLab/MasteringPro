/**
 * Reference matching 2.0: spectrum, stereo width and dynamics, all derived from two track profiles.
 *
 *  - EQ: the smoothed difference of the long-term mid spectra, with the broadband level offset removed (that is a
 *    loudness job, not a tone job), soft-limited and tapered at the extremes. Applied as a minimum-phase FIR (matchEq.ts).
 *  - Stereo: the difference of the side/mid energy ratio per band, expressed as gains for the mid/side EQ's side channel.
 *  - Dynamics: how much each band's short-term level range must shrink to reach a target, turned into threshold + ratio
 *    for the multiband compressor (auto-tune).
 */
import type { MatchCurve } from '@/lib/dsp/matchEq';
import type { TrackProfile } from '@/lib/dsp/profile';
import type { MultibandBandParams } from '@/lib/multiband';

export interface MatchOptions {
  maxBoostDb?: number;   // default 6
  maxCutDb?: number;     // default 9
  smoothOct?: number;    // default 1/3 octave
}

export interface StereoMatch {
  /** dB gains for the side channel of the mid/side EQ (low / mid / high) */
  sideLow: number;
  sideMid: number;
  sideHigh: number;
  /** true when the reference is clearly narrower in the bass than the track */
  bassMonoHint: boolean;
  /** per-band difference, reference − track, dB */
  deltas: number[];
}

export interface MatchResult {
  curve: MatchCurve;
  /** tonal difference reference − track on the curve grid, level offset removed and smoothed, BEFORE limiting (dB) */
  diff: number[];
  /** rms of the remaining tonal difference (dB), before and after applying the curve at full strength */
  rmsBeforeDb: number;
  rmsAfterDb: number;
  /** reference − track, LU */
  loudnessDeltaLu: number;
  stereo: StereoMatch | null;
  /** per-band dynamic range of the track and of the reference, dB */
  dynRangeTrack: number[];
  dynRangeRef: number[];
  notes: string[];
}

/** value at `hz` of a series on a log-frequency grid (linear interpolation) */
function sample(freqs: number[], vals: number[], hz: number): number {
  if (hz <= freqs[0]) return vals[0];
  const last = freqs.length - 1;
  if (hz >= freqs[last]) return vals[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (freqs[m] <= hz) lo = m; else hi = m; }
  const t = Math.log(hz / freqs[lo]) / Math.log(freqs[hi] / freqs[lo]);
  return vals[lo] + (vals[hi] - vals[lo]) * t;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round05 = (v: number) => Math.round(v * 2) / 2;

export function computeMatch(cur: TrackProfile, ref: TrackProfile, opts: MatchOptions = {}): MatchResult {
  const maxBoost = opts.maxBoostDb ?? 6;
  const maxCut = opts.maxCutDb ?? 9;
  const sigma = (opts.smoothOct ?? 1 / 3) / 2;
  const f = cur.freqs;
  const notes: string[] = [];

  // raw difference on the track's grid; bins with (almost) no energy on either side carry no information
  const raw = f.map((hz, i) => {
    const c = cur.midDb[i];
    const r = sample(ref.freqs, ref.midDb, hz);
    return c < -100 || r < -100 ? NaN : r - c;
  });

  // broadband offset over the tonal core, weighted evenly per octave (the grid is log-spaced)
  const core = raw.filter((v, i) => Number.isFinite(v) && f[i] >= 150 && f[i] <= 6000);
  const offset = core.length ? core.reduce((s, v) => s + v, 0) / core.length : 0;
  const centred = raw.map((v) => (Number.isFinite(v) ? v - offset : 0));

  // Gaussian smoothing over log-frequency
  const smooth = centred.map((_, i) => {
    let num = 0, den = 0;
    for (let j = 0; j < f.length; j++) {
      const d = Math.log2(f[j] / f[i]);
      if (Math.abs(d) > sigma * 3) continue;
      const w = Math.exp(-0.5 * (d / sigma) * (d / sigma));
      num += w * centred[j];
      den += w;
    }
    return den ? num / den : 0;
  });

  // soft limit (tanh keeps the shape instead of flat-topping) and taper the extremes where nothing audible lives
  const g = smooth.map((v, i) => {
    const lim = v >= 0 ? maxBoost : maxCut;
    let out = lim * Math.tanh(v / lim);
    const hz = f[i];
    if (hz < 40) out *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, hz - 25)) / 15);
    const top = Math.min(17000, cur.sampleRate * 0.42);
    if (hz > top * 0.8) out *= 0.5 + 0.5 * Math.cos((Math.PI * Math.min(1, (hz - top * 0.8) / (top * 0.2))));
    return Math.round(out * 100) / 100;
  });

  const inBand = (i: number) => f[i] >= 40 && f[i] <= 16000;
  const idx = f.map((_, i) => i).filter(inBand);
  const rms = (arr: number[]) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / Math.max(1, arr.length));
  const rmsBeforeDb = rms(idx.map((i) => centred[i]));
  const rmsAfterDb = rms(idx.map((i) => centred[i] - g[i]));

  if (Math.abs(cur.lufs - ref.lufs) > 0.5) notes.push(`Reference is ${ref.lufs - cur.lufs > 0 ? 'louder' : 'quieter'} by ${Math.abs(ref.lufs - cur.lufs).toFixed(1)} LU (not touched by the EQ match).`);

  // ── stereo ──
  let stereo: StereoMatch | null = null;
  const hasSide = cur.sideToMid.some((v) => v > -50) && ref.sideToMid.some((v) => v > -50);
  if (hasSide) {
    const d = cur.sideToMid.map((v, i) => ref.sideToMid[i] - v);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    stereo = {
      sideLow: round05(clamp(mean(d.slice(0, 2)), -6, 6)),
      sideMid: round05(clamp(d[2], -6, 6)),
      sideHigh: round05(clamp(mean(d.slice(3)), -6, 6)),
      bassMonoHint: ref.sideToMid[0] < cur.sideToMid[0] - 6 && ref.sideToMid[0] < -15,
      deltas: d,
    };
    if (Math.abs(stereo.sideLow) + Math.abs(stereo.sideMid) + Math.abs(stereo.sideHigh) < 1.5 && !stereo.bassMonoHint) {
      notes.push('Stereo width is already close to the reference.');
    }
  } else notes.push('Stereo match skipped (one of the files is mono).');

  return {
    curve: { f, g },
    diff: smooth,
    rmsBeforeDb: Math.round(rmsBeforeDb * 10) / 10,
    rmsAfterDb: Math.round(rmsAfterDb * 10) / 10,
    loudnessDeltaLu: Math.round((ref.lufs - cur.lufs) * 10) / 10,
    stereo,
    dynRangeTrack: cur.dynRange.map((v) => Math.round(v * 10) / 10),
    dynRangeRef: ref.dynRange.map((v) => Math.round(v * 10) / 10),
    notes,
  };
}

// ───────────────────────── dynamics: multiband auto-tune ─────────────────────────

const BASE_ATTACK = [30, 20, 12, 6, 3];
const BASE_RELEASE = [220, 180, 150, 110, 90];

/**
 * Turn "this band's level range must shrink to `target` dB" into a compressor setting.
 * The compressor works on the loud half of the distribution: with the threshold at the median and ratio R, the part of
 * the range above the median shrinks by (1 − 1/R). If that is not enough, the threshold moves down into the lower half.
 */
export function tuneMultiband(cur: TrackProfile, targetRange: number[], strength = 1): MultibandBandParams[] {
  return cur.level.map((lv, b) => {
    const want = targetRange[b];
    const have = lv.p95 - lv.p10;
    const need = Math.max(0, (have - want) * strength);
    const base: MultibandBandParams = {
      threshold: 0, ratio: 1, attack: BASE_ATTACK[b] ?? 10, release: BASE_RELEASE[b] ?? 150, knee: 6, makeup: 0,
      link: 1, detect: 0.3, autoRelease: true,
    };
    if (need < 0.5) return base;
    const top = lv.p95 - lv.p50;
    let thr = lv.p50;
    let span = top;
    if (need > top * 0.85) {
      thr = lv.p50 - (need - top * 0.85);
      span = lv.p95 - thr;
    }
    const ratio = clamp(span / Math.max(0.5, span - need), 1.2, 8);
    return { ...base, threshold: clamp(round05(thr), -48, -1), ratio: Math.round(ratio * 10) / 10 };
  });
}

export type TuneMode = 'gentle' | 'balanced' | 'dense';
const REDUCE_BY: Record<TuneMode, number> = { gentle: 1.5, balanced: 3, dense: 5 };

/** Auto-tune without a reference: shrink every band's range by a fixed amount, never below 5 dB. */
export function autoTuneMultiband(cur: TrackProfile, mode: TuneMode = 'balanced'): MultibandBandParams[] {
  const target = cur.dynRange.map((r) => Math.max(5, r - REDUCE_BY[mode]));
  return tuneMultiband(cur, target);
}
