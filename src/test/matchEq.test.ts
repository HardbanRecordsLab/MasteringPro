import { describe, it, expect } from 'vitest';
import { designMinPhaseFir, firResponseDb, curveAt, type MatchCurve } from '@/lib/dsp/matchEq';

const FREQS = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000];

function curveFrom(fn: (hz: number) => number): MatchCurve {
  return { f: FREQS, g: FREQS.map(fn) };
}

describe('match EQ — minimum-phase FIR design', () => {
  const shapes: Record<string, MatchCurve> = {
    'low shelf +4 / high shelf −3': curveFrom((hz) => 4 / (1 + Math.pow(hz / 150, 2)) - 3 * (hz / (hz + 6000))),
    'smooth presence bump +3 dB @ 3 kHz': curveFrom((hz) => 3 * Math.exp(-Math.pow(Math.log2(hz / 3000) / 0.9, 2))),
    'scoop −5 dB @ 400 Hz': curveFrom((hz) => -5 * Math.exp(-Math.pow(Math.log2(hz / 400) / 0.8, 2))),
  };

  for (const sr of [44100, 48000, 96000]) {
    for (const [name, curve] of Object.entries(shapes)) {
      it(`reproduces "${name}" within ±0.3 dB at ${sr} Hz`, () => {
        const fir = designMinPhaseFir(curve, 1, sr);
        let worst = 0;
        for (let hz = 40; hz <= 16000; hz *= 1.12) {
          worst = Math.max(worst, Math.abs(firResponseDb(fir, hz, sr) - curveAt(curve, hz)));
        }
        expect(worst).toBeLessThan(0.3);
      });
    }
  }

  it('amount scales the correction in dB', () => {
    const c = shapes['smooth presence bump +3 dB @ 3 kHz'];
    const half = designMinPhaseFir(c, 0.5, 48000);
    expect(firResponseDb(half, 3000, 48000)).toBeCloseTo(1.5, 0);
    const none = designMinPhaseFir(c, 0, 48000);
    expect(Math.abs(firResponseDb(none, 3000, 48000))).toBeLessThan(0.05);
  });

  it('a flat curve is a unit impulse (transparent)', () => {
    const fir = designMinPhaseFir(curveFrom(() => 0), 1, 48000);
    expect(fir[0]).toBeCloseTo(1, 3);
    let rest = 0;
    for (let i = 1; i < fir.length; i++) rest += fir[i] * fir[i];
    expect(rest).toBeLessThan(1e-6);
  });

  it('is minimum phase: no pre-ringing, energy arrives immediately', () => {
    const fir = designMinPhaseFir(shapes['low shelf +4 / high shelf −3'], 1, 48000);
    let total = 0, early = 0;
    for (let i = 0; i < fir.length; i++) { total += fir[i] * fir[i]; if (i < 128) early += fir[i] * fir[i]; }
    expect(early / total).toBeGreaterThan(0.95);
    expect(Array.from(fir).every(Number.isFinite)).toBe(true);
  });
});
