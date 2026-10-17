/**
 * Stereo mastering compressor — ballistics and curve, measured on the real worklet.
 * Regression guard for the "attack was 3× the setting" defect (detector AND gain were both smoothed).
 */
import { describe, it, expect } from 'vitest';
import { loadWorklet, run, tone, rmsDb, SR } from './harness';

const Cls = loadWorklet('compressor-processor.js');
const base = { threshold: -20, ratio: 4, attack: 20, release: 200, knee: 0, makeup: 0, mix: 100, detect: 'peak', mode: 'stereo', autoRelease: false, autoMakeup: false };

function stepSignal(fromDb: number, toDb: number, atSec: number, totalSec: number): Float32Array {
  const a = tone(1000, fromDb, totalSec), b = tone(1000, toDb, totalSec);
  const x = new Float32Array(a.length);
  for (let i = 0; i < x.length; i++) x[i] = i < SR * atSec ? a[i] : b[i];
  return x;
}

/** gain (dB, output peak / input peak) in 1 ms windows from `fromSec` */
function gainTrack(inp: Float32Array, out: Float32Array, fromSec: number, toSec: number): number[] {
  const win = Math.round(SR * 0.001);
  const g: number[] = [];
  for (let s = Math.round(SR * fromSec); s + win < SR * toSec; s += win) {
    let pi = 0, po = 0;
    for (let i = s; i < s + win; i++) { pi = Math.max(pi, Math.abs(inp[i])); po = Math.max(po, Math.abs(out[i])); }
    g.push(20 * Math.log10((po + 1e-9) / (pi + 1e-9)));
  }
  return g;
}

const settle = (x: Float32Array) => rmsDb(x, x.length - SR * 0.4) + 3.0103;

describe('compressor — ballistics', () => {
  for (const detect of ['peak', 'rms']) {
    for (const attack of [5, 20, 50]) {
      it(`attack ${attack} ms (${detect}): the gain reaches 63 % of its reduction in ≈ ${attack} ms`, () => {
        const x = stepSignal(-40, -10, 0.5, 2.5);
        const { L } = run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, attack, detect } });
        const g = gainTrack(x, L, 0.5, 2.4);
        const final = g[g.length - 1];
        const t63 = g.findIndex((v) => v <= final * 0.632);
        expect(t63).toBeGreaterThan(attack * 0.55);
        expect(t63).toBeLessThan(attack * 1.4 + (detect === 'rms' ? 7 : 3));   // the RMS window (5 ms) adds its own time
      });
    }
  }

  it('release: the gain recovers 63 % of the way in ≈ the release time', () => {
    for (const release of [100, 300]) {
      const x = stepSignal(-10, -40, 0.8, 3);
      const { L } = run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, attack: 5, release } });
      const g = gainTrack(x, L, 0.8, 2.9);
      const start = g[2];                       // a few ms in: most of the reduction still applied
      const t63 = g.findIndex((v, i) => i > 5 && v >= start * 0.368);
      expect(t63).toBeGreaterThan(release * 0.5);
      expect(t63).toBeLessThan(release * 1.45 + 40);   // the detector fall-back (≤ 30 ms) adds a little on the way down
    }
  });

  it('auto-release recovers faster after a brief peak than after sustained pressure', () => {
    const after = (burstMs: number) => {
      const x = tone(1000, -40, 3);
      const start = Math.round(SR * 0.5), bn = Math.round((burstMs / 1000) * SR);
      for (let i = 0; i < bn; i++) x[start + i] = 0.5 * Math.sin((2 * Math.PI * 1000 * (start + i)) / SR);
      const { L } = run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, threshold: -30, ratio: 8, attack: 1, release: 600, autoRelease: true } });
      const at = start + bn + Math.round(SR * 0.25);
      return rmsDb(L, at, at + 2400) + 3.0103 + 40;          // dB below the untouched −40 dB tone → 0 = fully recovered
    };
    expect(after(20)).toBeGreaterThan(after(1200) + 1);
  });
});

describe('compressor — curve', () => {
  it('peak detector: steady-state reduction matches the textbook value (±0.5 dB)', () => {
    const x = tone(1000, -10, 3);
    const o = run(Cls, x, Float32Array.from(x), { processorOptions: base }).L;
    expect(settle(o)).toBeGreaterThan(-10 - 7.5 - 0.5);
    expect(settle(o)).toBeLessThan(-10 - 7.5 + 0.5);
  });

  it('RMS detector reads a sine 3 dB lower (RMS convention): reduction ≈ 5.25 dB', () => {
    const x = tone(1000, -10, 3);
    const o = run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, detect: 'rms' } }).L;
    expect(Math.abs(settle(o) - (-10 - 5.25))).toBeLessThan(0.5);
  });

  it('soft knee acts at the threshold: ≈ 1.1 dB of reduction with a 12 dB knee', () => {
    const x = tone(1000, -20, 3);
    const hard = settle(run(Cls, x, Float32Array.from(x), { processorOptions: base }).L);
    const soft = settle(run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, knee: 12 } }).L);
    expect(Math.abs(hard - -20)).toBeLessThan(0.3);
    expect(Math.abs(soft - (-20 - 1.125))).toBeLessThan(0.45);
  });

  it('makeup gain and ratio 1:1 are exact', () => {
    const x = tone(500, -12, 2);
    const unity = run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, ratio: 1, makeup: 6 } }).L;
    expect(Math.abs(settle(unity) - (-12 + 6))).toBeLessThan(0.1);
  });

  it('parallel mix blends dry and compressed', () => {
    const x = tone(1000, -10, 2.5);
    const at = (mix: number) => settle(run(Cls, x, Float32Array.from(x), { processorOptions: { ...base, mix } }).L);
    expect(Math.abs(at(0) - -10)).toBeLessThan(0.1);
    expect(at(100)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(0));
  });
});

describe('compressor — stereo handling and robustness', () => {
  it('linked: a loud left channel pulls the quiet right one down; dual-mono leaves it alone', () => {
    const loud = tone(1000, -8, 2.5), quiet = tone(1000, -34, 2.5);
    const linked = run(Cls, loud, quiet, { processorOptions: { ...base, mode: 'stereo' } });
    const dual = run(Cls, loud, quiet, { processorOptions: { ...base, mode: 'dual' } });
    expect(settle(linked.R)).toBeLessThan(-34 - 3);
    expect(Math.abs(settle(dual.R) - -34)).toBeLessThan(0.2);
  });

  it('stays finite on silence, DC, hot signals — and recovers from NaN', () => {
    for (const x of [new Float32Array(SR), new Float32Array(SR).fill(0.7), tone(100, 12, 1)]) {
      const { L } = run(Cls, x, Float32Array.from(x), { processorOptions: base });
      expect(Array.from(L).every(Number.isFinite)).toBe(true);
    }
    const y = tone(500, -12, 1);
    y.fill(NaN, 20000, 20128);
    const { L } = run(Cls, y, Float32Array.from(y), { processorOptions: base });
    expect(Array.from(L.subarray(30000)).every(Number.isFinite)).toBe(true);
  });
});
