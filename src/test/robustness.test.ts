/**
 * Every worklet must survive hostile input: silence, DC, over-range signals and a burst of NaN. A single bad sample must
 * never leave a processor permanently broken (a poisoned IIR state or envelope would mute the audio until reload).
 */
import { describe, it, expect } from 'vitest';
import { loadWorklet, run, tone, SR } from './harness';

const FILES = [
  'noise-gate-processor.js', 'mid-side-eq-processor.js', 'multiband-comp-processor.js', 'dynamics-eq-processor.js',
  'resonance-suppressor-processor.js', 'compressor-processor.js', 'bass-mono-processor.js', 'lookahead-limiter-processor.js',
];

/** options that switch each processor ON, so its state machinery is really exercised */
const OPTIONS: Record<string, Record<string, unknown>> = {
  'dynamics-eq-processor.js': {
    deEss: { enabled: true, freq: 6500, threshold: -30, range: 8, attack: 1, release: 60 },
    dyn: { enabled: true, freq: 300, q: 2, threshold: -30, range: 6, attack: 10, release: 120, mode: 'cut' },
  },
  'resonance-suppressor-processor.js': { enabled: true, amount: 60, strength: 0.6, depth: 9, threshold: 6, attack: 12, release: 120, lowHz: 100, highHz: 12000 },
  'bass-mono-processor.js': { freq: 140 },
};

describe.each(FILES)('robustness — %s', (file) => {
  const Cls = loadWorklet(file);
  const opts = { processorOptions: OPTIONS[file] ?? {} };
  const finite = (x: Float32Array) => Array.from(x).every(Number.isFinite);

  it('stays finite on silence, DC, full-scale and +12 dBFS', () => {
    for (const x of [new Float32Array(SR / 2), new Float32Array(SR / 2).fill(0.6), tone(1000, 0, 0.5), tone(100, 12, 0.5)]) {
      const o = run(Cls, x, Float32Array.from(x), opts);
      expect(finite(o.L) && finite(o.R)).toBe(true);
    }
  });

  it('recovers from a burst of NaN within half a second', () => {
    const x = tone(500, -12, 1.5);
    x.fill(NaN, 24000, 24128);
    const o = run(Cls, x, Float32Array.from(x), opts);
    const tail = o.L.subarray(24000 + Math.round(SR * 0.5));
    expect(finite(tail)).toBe(true);
    // and it still passes audio afterwards (not stuck at zero / closed)
    let e = 0;
    for (let i = 0; i < tail.length; i++) e += tail[i] * tail[i];
    expect(Math.sqrt(e / tail.length)).toBeGreaterThan(0.01);
  });

  it('recovers from Infinity as well', () => {
    const x = tone(500, -12, 1.5);
    x[30000] = Infinity; x[30001] = -Infinity;
    const o = run(Cls, x, Float32Array.from(x), opts);
    const tail = o.L.subarray(30000 + Math.round(SR * 0.5));
    expect(finite(tail)).toBe(true);
  });
});
