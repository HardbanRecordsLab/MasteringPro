/**
 * Multiband compressor configuration: types, defaults and the glue between the stored parameters, the real-time engine
 * and the offline render. The worklet itself lives in public/worklets/multiband-comp-processor.js.
 *
 * Stored presets may still hold the old 3-band form (mbXover1 / mbXover2 + 3 bands). The band COUNT is the source of truth:
 * 3 bands → legacy crossovers, anything else → `mbXovers`.
 */

export interface MultibandBandParams {
  threshold: number;      // dB
  ratio: number;          // :1
  attack: number;         // ms
  release: number;        // ms
  knee: number;           // dB
  makeup: number;         // dB
  /** 0 … 1 gentle lift of material well below the threshold (default 0) */
  upward?: number;
  /** 0 … 1 stereo link (default 1) */
  link?: number;
  /** 0 = RMS … 1 = peak (default 0.3) */
  detect?: number;
  /** program-dependent release (default true) */
  autoRelease?: boolean;
  /** largest reduction in dB (default 24) */
  range?: number;
  enabled?: boolean;
}

export interface MultibandConfig {
  xovers: number[];
  bands: MultibandBandParams[];
  /** 0 … 1 parallel mix */
  mix: number;
  /** ms */
  lookahead: number;
}

export interface MultibandStored {
  mbBands: MultibandBandParams[];
  mbXover1: number;
  mbXover2: number;
  mbXovers?: number[];
  /** percent, 0 … 100 */
  mbMix?: number;
  mbLookahead?: number;
}

export const BAND_NAMES: Record<number, string[]> = {
  3: ['Low', 'Mid', 'High'],
  5: ['Low', 'Low-mid', 'Mid', 'High-mid', 'Air'],
};

export const DEFAULT_XOVERS_5 = [100, 500, 2500, 8000];

export const DEFAULT_BANDS_3: MultibandBandParams[] = [
  { threshold: -24, ratio: 2, attack: 20, release: 200, knee: 6, makeup: 0 },
  { threshold: -20, ratio: 2, attack: 15, release: 150, knee: 6, makeup: 0 },
  { threshold: -18, ratio: 2, attack: 10, release: 120, knee: 6, makeup: 0 },
];

export const DEFAULT_BANDS_5: MultibandBandParams[] = [
  { threshold: -22, ratio: 2.2, attack: 30, release: 220, knee: 6, makeup: 0 },
  { threshold: -22, ratio: 2, attack: 20, release: 180, knee: 6, makeup: 0 },
  { threshold: -20, ratio: 2, attack: 12, release: 150, knee: 6, makeup: 0 },
  { threshold: -20, ratio: 2, attack: 6, release: 110, knee: 6, makeup: 0 },
  { threshold: -24, ratio: 1.8, attack: 3, release: 90, knee: 6, makeup: 0 },
];

export function resolveMultiband(p: MultibandStored): MultibandConfig {
  const bands = p.mbBands;
  const n = bands.length;
  let xovers: number[];
  if (n === 3) xovers = [p.mbXover1, p.mbXover2];
  else {
    const given = p.mbXovers ?? [];
    xovers = given.slice(0, n - 1);
    // pad with log-spaced defaults if a preset brings fewer crossovers than bands
    for (let i = xovers.length; i < n - 1; i++) xovers.push(Math.round(100 * Math.pow(80, i / Math.max(1, n - 2))));
  }
  return {
    xovers,
    bands,
    mix: Math.min(1, Math.max(0, (p.mbMix ?? 100) / 100)),
    lookahead: Math.min(5, Math.max(0, p.mbLookahead ?? 0)),
  };
}

/** Switch between the classic 3-band and the 5-band layout, carrying the settings across sensibly. */
export function convertBandCount(p: MultibandStored, target: 3 | 5): Pick<MultibandStored, 'mbBands' | 'mbXover1' | 'mbXover2' | 'mbXovers'> {
  const cur = p.mbBands.length;
  if (cur === target) return { mbBands: p.mbBands, mbXover1: p.mbXover1, mbXover2: p.mbXover2, mbXovers: p.mbXovers };
  if (target === 5) {
    const [lo, mid, hi] = p.mbBands;
    const x1 = p.mbXover1, x2 = p.mbXover2;
    const base = DEFAULT_BANDS_5;
    return {
      mbBands: [
        { ...base[0], ...lo },
        { ...base[1], ...lo, attack: Math.round(lo.attack * 0.7) },
        { ...base[2], ...mid },
        { ...base[3], ...hi, attack: Math.round(hi.attack * 1.2) },
        { ...base[4], ...hi },
      ],
      mbXover1: x1,
      mbXover2: x2,
      mbXovers: [x1, Math.round(Math.sqrt(x1 * x2)), x2, Math.min(12000, Math.round(x2 * 3.2))],
    };
  }
  const xo = p.mbXovers ?? DEFAULT_XOVERS_5;
  const b = p.mbBands;
  const avg = (key: 'threshold' | 'ratio' | 'attack' | 'release' | 'knee' | 'makeup', idx: number[]) =>
    idx.reduce((s, i) => s + (b[i]?.[key] ?? 0), 0) / idx.length;
  const mk = (idx: number[]): MultibandBandParams => ({
    threshold: avg('threshold', idx), ratio: avg('ratio', idx), attack: avg('attack', idx),
    release: avg('release', idx), knee: avg('knee', idx), makeup: avg('makeup', idx),
  });
  return {
    mbBands: [mk([0, 1]), mk([2]), mk([3, 4])],
    mbXover1: xo[1] ?? 500,
    mbXover2: xo[3] ?? 8000,
    mbXovers: p.mbXovers,
  };
}

/** Samples of delay the lookahead adds (the dry path is delayed identically inside the worklet). */
export function multibandLatencySamples(lookaheadMs: number, sampleRate: number): number {
  return Math.round((Math.min(5, Math.max(0, lookaheadMs)) * sampleRate) / 1000);
}
