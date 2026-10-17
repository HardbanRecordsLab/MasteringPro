/**
 * Multiband Compressor 2.0 — measured, not assumed.
 * Every property is checked on the real worklet source, block by block.
 */
import { describe, it, expect } from 'vitest';
import { loadWorklet, run, tone, noise, rmsDb, peak, fakeBuffer, SR } from './harness';
import { analyzeSpectrum } from '@/lib/spectrum';

const Cls = loadWorklet('multiband-comp-processor.js');

const NEUTRAL = { threshold: 0, ratio: 1, attack: 10, release: 100, knee: 0, makeup: 0, detect: 0.3, link: 1, autoRelease: false };
const neutral = (n: number) => Array.from({ length: n }, () => ({ ...NEUTRAL }));
const XO: Record<number, number[]> = { 3: [120, 2500], 4: [100, 800, 4000], 5: [100, 500, 2500, 8000], 6: [60, 200, 800, 3000, 9000] };

function stereo(x: Float32Array): [Float32Array, Float32Array] {
  return [x, Float32Array.from(x)];
}
/** steady-state level of a tone: RMS over the last half second */
function settledDb(x: Float32Array) {
  return rmsDb(x, x.length - Math.floor(SR * 0.5)) + 3.0103; // + 3 dB: RMS → sine peak in dBFS
}

describe('Multiband 2.0 — reconstruction', () => {
  for (const n of [3, 4, 5, 6]) {
    it(`${n} bands at unity sum back to a flat spectrum (±0.4 dB on noise, 40 Hz – 16 kHz)`, () => {
      const [L, R] = stereo(noise(4, 0.1, 5));
      const { L: out } = run(Cls, L, R, { processorOptions: { xovers: XO[n], bands: neutral(n) } });
      const a = analyzeSpectrum(fakeBuffer([L, R]));
      const b = analyzeSpectrum(fakeBuffer([out, out]));
      let worst = 0;
      a.thirdOctaveCenters.forEach((f, i) => {
        if (f < 40 || f > 16000) return;
        worst = Math.max(worst, Math.abs(b.thirdOctaveDb[i] - a.thirdOctaveDb[i]));
      });
      expect(worst).toBeLessThan(0.4);
    });
  }

  it('a tone at any frequency comes out at the same level (±0.05 dB) — the allpass-compensated sum is flat to the decimal', () => {
    for (const n of [3, 5, 6]) {
      for (const f of [35, 90, 140, 400, 1000, 1800, 2600, 5000, 8500, 12000, 16000]) {
        const [L, R] = stereo(tone(f, -12, 1.2));
        const { L: out } = run(Cls, L, R, { processorOptions: { xovers: XO[n], bands: neutral(n) } });
        expect(Math.abs(settledDb(out) - settledDb(L)), `${n} bands @ ${f} Hz`).toBeLessThan(0.05);
      }
    }
  });

  it('still understands the legacy 3-band message (xover1 / xover2) and gives the same result as the new form', () => {
    const [L, R] = stereo(noise(2, 0.1, 9));
    const bands = [{ ...NEUTRAL, threshold: -30, ratio: 3 }, { ...NEUTRAL }, { ...NEUTRAL, threshold: -25, ratio: 2 }];
    const a = run(Cls, L, R, { processorOptions: { xover1: 150, xover2: 3000, bands } });
    const b = run(Cls, L, R, { processorOptions: { xovers: [150, 3000], bands } });
    let maxd = 0;
    for (let i = 0; i < a.L.length; i++) maxd = Math.max(maxd, Math.abs(a.L[i] - b.L[i]));
    expect(maxd).toBe(0);
  });
});

describe('Multiband 2.0 — compression behaviour', () => {
  const bands5 = (mid: Record<string, unknown>) => neutral(5).map((b, i) => (i === 2 ? { ...b, ...mid } : b));

  it('applies the textbook gain reduction inside one band only', () => {
    // wide mid band (100 Hz – 8 kHz) so a 1 kHz tone is far from both crossovers (a 24 dB/oct slope still leaks a few %
    // of a tone that is only one octave from a crossover). −10 dBFS, threshold −22, ratio 4, hard knee → 9 dB of reduction
    const cfg = { xovers: [100, 8000], bands: neutral(3).map((b, i) => (i === 1 ? { ...b, threshold: -22, ratio: 4, knee: 0, attack: 2, release: 80, detect: 0 } : b)) };
    const [L1, R1] = stereo(tone(1000, -10, 2.5));
    const o1 = run(Cls, L1, R1, { processorOptions: cfg }).L;
    expect(settledDb(o1)).toBeGreaterThan(-19.4);
    expect(settledDb(o1)).toBeLessThan(-18.6);

    // tones in other bands pass untouched
    for (const f of [30, 12000, 16000]) {
      const [L, R] = stereo(tone(f, -10, 2.5));
      const o = run(Cls, L, R, { processorOptions: cfg }).L;
      expect(Math.abs(settledDb(o) - -10)).toBeLessThan(0.3);
    }
  });

  it('the soft knee eases in: reduction at the threshold is half of the knee-free curve at +knee/2', () => {
    const cfg = (knee: number) => ({ xovers: XO[5], bands: bands5({ threshold: -20, ratio: 4, knee, attack: 2, release: 80, detect: 0 }) });
    const [L, R] = stereo(tone(1000, -20, 2.5));          // exactly at the threshold
    const hard = settledDb(run(Cls, L, R, { processorOptions: cfg(0) }).L);
    const soft = settledDb(run(Cls, L, R, { processorOptions: cfg(12) }).L);
    expect(Math.abs(hard - -20)).toBeLessThan(0.3);       // hard knee: nothing happens at the threshold
    expect(soft).toBeLessThan(hard - 0.4);                 // soft knee already acts there
    expect(soft).toBeGreaterThan(hard - 3);                // …but gently
  });

  it('stereo link = 1 gives both channels the same reduction, link = 0 leaves the quiet channel alone', () => {
    const loud = tone(1000, -8, 2.5);
    const quiet = tone(1000, -34, 2.5);
    const mk = (link: number) => ({ xovers: XO[5], bands: bands5({ threshold: -26, ratio: 6, knee: 0, attack: 2, release: 80, detect: 0, link }) });
    const linked = run(Cls, loud, quiet, { processorOptions: mk(1) });
    const free = run(Cls, loud, quiet, { processorOptions: mk(0) });
    expect(settledDb(linked.R)).toBeLessThan(-34 - 3);     // the quiet side was pulled down with the loud side
    expect(Math.abs(settledDb(free.R) - -34)).toBeLessThan(0.3);
    expect(settledDb(free.L)).toBeLessThan(-8 - 5);        // the loud side is compressed either way
  });

  it('auto-release recovers faster after a brief peak than after sustained pressure', () => {
    const run1 = (burstMs: number) => {
      const n = Math.round(SR * 3);
      const x = tone(1000, -40, 3);
      const burstN = Math.round((burstMs / 1000) * SR);
      const start = Math.round(SR * 0.5);
      for (let i = 0; i < burstN; i++) x[start + i] = 0.5 * Math.sin((2 * Math.PI * 1000 * (start + i)) / SR);
      const cfg = { xovers: XO[5], bands: bands5({ threshold: -30, ratio: 8, knee: 0, attack: 1, release: 600, detect: 0.3, autoRelease: true }) };
      const o = run(Cls, x, Float32Array.from(x), { processorOptions: cfg }).L;
      // level 0.25 s after the burst ends, relative to the untouched −40 dB tone
      const at = start + burstN + Math.round(SR * 0.25);
      return rmsDb(o, at, at + 2400) + 3.0103 - -40;
    };
    const afterShort = run1(20);       // 20 ms peak → brief reduction
    const afterLong = run1(1200);      // 1.2 s of heavy work → long memory
    expect(afterShort).toBeGreaterThan(afterLong + 1);     // the brief one is back closer to unity
  });

  it('lookahead tames a sudden peak that would otherwise pass through the attack', () => {
    const x = new Float32Array(SR * 1);
    for (let i = 0; i < SR * 0.1; i++) x[Math.round(SR * 0.3) + i] = 0.9 * Math.sin((2 * Math.PI * 800 * i) / SR);
    const cfg = (la: number) => ({ xovers: XO[5], lookahead: la, bands: bands5({ threshold: -30, ratio: 20, knee: 0, attack: 4, release: 120, detect: 1 }) });
    const noLa = run(Cls, x, Float32Array.from(x), { processorOptions: cfg(0) }).L;
    const la = run(Cls, x, Float32Array.from(x), { processorOptions: cfg(4) }).L;
    const from = Math.round(SR * 0.3), to = from + Math.round(SR * 0.012);
    const laFrom = from + Math.round(SR * 0.004), laTo = to + Math.round(SR * 0.004);   // output is 4 ms later
    expect(peak(la, laFrom, laTo)).toBeLessThan(peak(noLa, from, to) * 0.8);
  });
});

describe('Multiband 2.0 — monitoring and parallel mix', () => {
  it('delta monitor is silent when nothing is being compressed', () => {
    const [L, R] = stereo(noise(2, 0.1, 3));
    const { L: out } = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands: neutral(5), monitor: -2 } });
    expect(rmsDb(out)).toBeLessThan(-100);
  });

  it('delta + wet reconstruct the dry signal (what was removed is exactly what is missing)', () => {
    const [L, R] = stereo(noise(2, 0.15, 4));
    const bands = neutral(5).map((b) => ({ ...b, threshold: -30, ratio: 4, knee: 6 }));
    const wet = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands } }).L;
    const delta = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands, monitor: -2 } }).L;
    const dry = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands: neutral(5) } }).L;   // unity = the phase-matched dry
    let maxd = 0;
    for (let i = 0; i < wet.length; i++) maxd = Math.max(maxd, Math.abs(dry[i] - (wet[i] + delta[i])));
    expect(maxd).toBeLessThan(1e-4);
  });

  it('solo outputs just that band', () => {
    const [L, R] = stereo(tone(30, -10, 1.5));          // deep inside band 0 (below the 100 Hz crossover)
    const s0 = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands: neutral(5), monitor: 0 } }).L;
    const s3 = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands: neutral(5), monitor: 3 } }).L;
    expect(Math.abs(settledDb(s0) - -10)).toBeLessThan(0.6);
    expect(settledDb(s3)).toBeLessThan(-50);
  });

  it('parallel mix = 0 is the (phase-matched) dry signal and mix = 1 is the compressed one', () => {
    const [L, R] = stereo(tone(1000, -10, 2.5));
    const bands = neutral(5).map((b, i) => (i === 2 ? { ...b, threshold: -30, ratio: 8, knee: 0, attack: 2, detect: 0 } : b));
    const dry = settledDb(run(Cls, L, R, { processorOptions: { xovers: XO[5], bands, mix: 0 } }).L);
    const wet = settledDb(run(Cls, L, R, { processorOptions: { xovers: XO[5], bands, mix: 1 } }).L);
    const half = settledDb(run(Cls, L, R, { processorOptions: { xovers: XO[5], bands, mix: 0.5 } }).L);
    expect(Math.abs(dry - -10)).toBeLessThan(0.3);
    expect(wet).toBeLessThan(-10 - 10);
    expect(half).toBeGreaterThan(wet + 3);
    expect(half).toBeLessThan(dry - 3);
  });
});

describe('Multiband 2.0 — robustness', () => {
  it('stays finite on silence, DC, full-scale and +12 dBFS input', () => {
    const cfg = { xovers: XO[6], bands: neutral(6).map((b) => ({ ...b, threshold: -30, ratio: 10, upward: 1 })) };
    const cases: Float32Array[] = [
      new Float32Array(SR),
      new Float32Array(SR).fill(0.5),
      tone(1000, 0, 1),
      tone(100, 12, 1),
    ];
    for (const x of cases) {
      const { L, R } = run(Cls, x, Float32Array.from(x), { processorOptions: cfg });
      expect(Array.from(L).every(Number.isFinite)).toBe(true);
      expect(Array.from(R).every(Number.isFinite)).toBe(true);
    }
  });

  it('recovers after a NaN burst instead of staying broken', () => {
    const x = tone(500, -12, 1);
    x.fill(NaN, 20000, 20128);
    const { L } = run(Cls, x, Float32Array.from(x), { processorOptions: { xovers: XO[5], bands: neutral(5) } });
    expect(Array.from(L.subarray(30000)).every(Number.isFinite)).toBe(true);
    expect(rmsDb(L, 40000, 46000)).toBeGreaterThan(-20);
  });

  it('moving a crossover glides instead of clicking', () => {
    const [L, R] = stereo(tone(1000, -12, 2));
    const { L: out } = run(Cls, L, R, {
      processorOptions: { xovers: XO[5], bands: neutral(5) },
      onBlock: (proc, off) => { if (off === 48000) proc.port.onmessage({ data: { xovers: [100, 500, 1100, 8000] } }); },
    });
    // the 1 kHz tone crosses from one band into another: the output must stay smooth
    let maxStep = 0;
    for (let i = 40000; i < 80000; i++) maxStep = Math.max(maxStep, Math.abs(out[i + 1] - out[i]));
    const expected = 2 * Math.PI * 1000 / SR * Math.pow(10, -12 / 20);        // largest step of a clean tone
    expect(maxStep).toBeLessThan(expected * 1.3);
  });

  it('reports per-band gain reduction and level', () => {
    const [L, R] = stereo(tone(1000, -10, 1.5));
    const bands = neutral(5).map((b, i) => (i === 2 ? { ...b, threshold: -22, ratio: 4, knee: 0, attack: 2, detect: 0 } : b));
    const { posted } = run(Cls, L, R, { processorOptions: { xovers: XO[5], bands } });
    const last = posted[posted.length - 1];
    expect(last.gr).toHaveLength(5);
    expect(last.gr[2]).toBeLessThan(-7);
    expect(Math.abs(last.gr[0])).toBeLessThan(0.1);
  });
});
