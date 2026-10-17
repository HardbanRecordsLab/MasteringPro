import { describe, it, expect } from 'vitest';
import { analyzeProfile } from '@/lib/dsp/profile';
import { computeMatch, tuneMultiband, autoTuneMultiband } from '@/lib/dsp/match';
import { curveAt, designMinPhaseFir, firResponseDb } from '@/lib/dsp/matchEq';
import { fakeBuffer, noise, tone, SR, run, loadWorklet, rmsDb } from './harness';

const SEC = 6;

/** coloured noise: white noise through a one-pole filter pair — gives a controllable spectral tilt */
function coloured(seed: number, lowpass: number, gain = 1): Float32Array {
  const w = noise(SEC, 0.2, seed);
  const out = new Float32Array(w.length);
  let y = 0;
  const a = Math.exp(-2 * Math.PI * lowpass / SR);
  for (let i = 0; i < w.length; i++) { y = (1 - a) * w[i] + a * y; out[i] = y * gain; }
  return out;
}
const toBuf = (L: Float32Array, R: Float32Array = L) => fakeBuffer([L, R]);

describe('track profile', () => {
  it('measures the spectral tilt, the stereo ratio and the dynamics of known material', () => {
    const dark = analyzeProfile(toBuf(coloured(1, 800, 3)));
    const bright = analyzeProfile(toBuf(coloured(2, 6000, 3)));
    // higher cut-off → more energy above 4 kHz relative to 200 Hz
    const tilt = (p: typeof dark) => {
      const at = (hz: number) => p.midDb[p.freqs.findIndex((f) => f >= hz)];
      return at(6000) - at(200);
    };
    expect(tilt(bright)).toBeGreaterThan(tilt(dark) + 6);

    // identical channels → no side energy; opposite polarity → all side
    const n = noise(SEC, 0.2, 3);
    const mono = analyzeProfile(toBuf(n, n));
    const wide = analyzeProfile(toBuf(n, Float32Array.from(n, (v) => -v)));
    expect(Math.max(...mono.sideToMid)).toBeLessThan(-40);
    expect(Math.min(...wide.sideToMid)).toBeGreaterThan(20);
  });

  it('reports a larger dynamic range for material whose level swings more', () => {
    const swing = (depthDb: number) => {
      const t = tone(1000, -12, 12);
      for (let i = 0; i < t.length; i++) {
        const lfo = 0.5 + 0.5 * Math.sin((2 * Math.PI * 0.4 * i) / SR);
        t[i] *= Math.pow(10, (-depthDb * (1 - lfo)) / 20);
      }
      return analyzeProfile(toBuf(t));
    };
    const small = swing(4), big = swing(16);
    expect(big.dynRange[2]).toBeGreaterThan(small.dynRange[2] + 6);   // 1 kHz lives in the 500 – 2500 Hz band
  });
});

describe('spectral match', () => {
  const cur = analyzeProfile(toBuf(coloured(10, 1200, 3)));
  const ref = analyzeProfile(toBuf(coloured(11, 5000, 1.5)));    // brighter (and at a different level)

  it('brightens a dark track toward a bright reference, ignoring the level difference', () => {
    const m = computeMatch(cur, ref);
    expect(curveAt(m.curve, 8000)).toBeGreaterThan(1);
    expect(curveAt(m.curve, 60)).toBeLessThan(-0.5);
    // the broadband level difference is NOT in the curve: the average over the tonal core is ~0
    const core = m.curve.f.map((f, i) => ({ f, g: m.curve.g[i] })).filter((x) => x.f >= 150 && x.f <= 6000);
    expect(Math.abs(core.reduce((s, x) => s + x.g, 0) / core.length)).toBeLessThan(2.5);
    // and the residual tonal difference gets much smaller
    expect(m.rmsAfterDb).toBeLessThan(m.rmsBeforeDb * 0.55);
    expect(m.loudnessDeltaLu).toBeCloseTo(ref.lufs - cur.lufs, 1);   // reported, but not part of the curve
  });

  it('respects the boost / cut limits', () => {
    const m = computeMatch(cur, ref, { maxBoostDb: 3, maxCutDb: 4 });
    expect(Math.max(...m.curve.g)).toBeLessThanOrEqual(3.001);
    expect(Math.min(...m.curve.g)).toBeGreaterThanOrEqual(-4.001);
  });

  it('matching a track against itself changes nothing', () => {
    const m = computeMatch(cur, cur);
    expect(Math.max(...m.curve.g.map(Math.abs))).toBeLessThan(0.05);
  });

  it('the designed FIR realises the matched curve when applied to the track', () => {
    const m = computeMatch(cur, ref);
    const fir = designMinPhaseFir(m.curve, 1, SR);
    for (const hz of [80, 300, 1000, 4000, 9000]) {
      expect(Math.abs(firResponseDb(fir, hz, SR) - curveAt(m.curve, hz))).toBeLessThan(0.4);
    }
  });
});

describe('stereo match', () => {
  it('asks for more side where the reference is wider, and less where it is narrower', () => {
    const base = noise(SEC, 0.2, 5);
    const other = noise(SEC, 0.2, 6);
    const make = (sideAmount: number) => toBuf(
      Float32Array.from(base, (v, i) => v + sideAmount * other[i]),
      Float32Array.from(base, (v, i) => v - sideAmount * other[i]),
    );
    const narrow = analyzeProfile(make(0.15));
    const wide = analyzeProfile(make(0.8));
    const toWide = computeMatch(narrow, wide).stereo!;
    expect(toWide.sideMid).toBeGreaterThan(3);
    const toNarrow = computeMatch(wide, narrow).stereo!;
    expect(toNarrow.sideMid).toBeLessThan(-3);
    expect(computeMatch(wide, wide).stereo!.sideMid).toBeCloseTo(0, 0);
  });

  it('skips the stereo step for mono material', () => {
    const n = noise(SEC, 0.2, 7);
    const m = computeMatch(analyzeProfile(toBuf(n, n)), analyzeProfile(toBuf(n, n)));
    expect(m.stereo).toBeNull();
  });
});

describe('multiband auto-tune closes the loop', () => {
  const Cls = loadWorklet('multiband-comp-processor.js');
  const NEUTRAL = { threshold: 0, ratio: 1, attack: 10, release: 100, knee: 0, makeup: 0 };

  function swinging(depthDb: number) {
    const t = tone(1000, -10, 16);
    for (let i = 0; i < t.length; i++) {
      const lfo = 0.5 + 0.5 * Math.sin((2 * Math.PI * 0.35 * i) / SR);
      t[i] *= Math.pow(10, (-depthDb * (1 - lfo)) / 20);
    }
    return t;
  }

  it('reduces the level range of a band by roughly the requested amount', () => {
    const x = swinging(18);
    const before = analyzeProfile(toBuf(x));
    const target = before.dynRange.map((r, i) => (i === 2 ? Math.max(5, r - 6) : r));
    const bands = tuneMultiband(before, target);
    expect(bands[2].ratio).toBeGreaterThan(1.2);
    expect(bands[0].ratio).toBe(1);                       // bands that need nothing are left alone

    const { L, R } = run(Cls, x, Float32Array.from(x), { processorOptions: { xovers: before.edges, bands: bands.map((b) => ({ ...NEUTRAL, ...b })) } });
    const after = analyzeProfile(toBuf(L, R));
    const gained = before.dynRange[2] - after.dynRange[2];
    expect(gained).toBeGreaterThan(3.5);                   // asked for 6 dB; the detector is not the profile, ±2.5 dB is honest
    expect(gained).toBeLessThan(9);
    expect(rmsDb(L)).toBeLessThan(rmsDb(x));              // it really compressed
  });

  it('auto-tune modes are ordered gentle < balanced < dense', () => {
    const p = analyzeProfile(toBuf(swinging(18)));
    const r = (m: 'gentle' | 'balanced' | 'dense') => autoTuneMultiband(p, m)[2].ratio;
    expect(r('gentle')).toBeLessThanOrEqual(r('balanced'));
    expect(r('balanced')).toBeLessThanOrEqual(r('dense'));
  });
});
