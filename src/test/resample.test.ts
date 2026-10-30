import { describe, it, expect } from 'vitest';
import { planResampler, resampleChannels, resampledLength } from '@/lib/resample';

const tone = (f: number, sr: number, seconds: number, amp = 0.5, phase = 0.3) => {
  const x = new Float32Array(Math.round(sr * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * (i / sr) + phase);
  return x;
};

/** amplitude of the component at f (Goertzel), edges trimmed so the start and end of the file do not count */
function level(x: Float32Array, f: number, sr: number, trim = 0.1): number {
  const a = Math.floor(sr * trim), b = x.length - a;
  const w = (2 * Math.PI * f) / sr, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return (2 * Math.sqrt(re * re + im * im)) / (b - a);
}
const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));

describe('resampler — passband', () => {
  it.each([
    [48000, 44100, 1000], [48000, 44100, 10000], [48000, 44100, 18000], [48000, 44100, 20000],
    [96000, 44100, 10000], [96000, 44100, 20000], [88200, 44100, 15000], [44100, 48000, 10000], [44100, 48000, 20000],
    [32000, 44100, 8000], [44100, 96000, 20000],
  ])('%i → %i Hz keeps a %i Hz tone at its level (±0.02 dB)', async (from, to, f) => {
    const [y] = await resampleChannels([tone(f, from, 1.5)], from, to);
    expect(Math.abs(db(level(y, f, to)) - db(0.5))).toBeLessThan(0.02);
  });

  it('reproduces the tone sample by sample (value and phase), not just its level', async () => {
    const [y] = await resampleChannels([tone(5000, 48000, 1)], 48000, 44100);
    let worst = 0;
    for (let o = 4410; o < y.length - 4410; o++) worst = Math.max(worst, Math.abs(y[o] - 0.5 * Math.sin(2 * Math.PI * 5000 * (o / 44100) + 0.3)));
    expect(db(worst)).toBeLessThan(-90);
  });

  it('keeps DC exactly (unity gain in every phase)', async () => {
    for (const [from, to] of [[48000, 44100], [96000, 44100], [44100, 48000], [22050, 44100], [44100, 44101]]) {
      const [y] = await resampleChannels([new Float32Array(from).fill(0.25)], from, to);
      const mid = y.subarray(Math.floor(y.length * 0.2), Math.floor(y.length * 0.8));
      for (let i = 0; i < mid.length; i += 37) expect(Math.abs(mid[i] - 0.25)).toBeLessThan(2e-6);
    }
  });
});

describe('resampler — nothing aliases into the audible band', () => {
  it.each([[96000, 44100, 24500], [96000, 44100, 30000], [96000, 44100, 40000], [88200, 44100, 30000], [192000, 44100, 50000]])(
    '%i → %i Hz: a %i Hz tone is gone (< −90 dBFS at its alias)', async (from, to, f) => {
      const [y] = await resampleChannels([tone(f, from, 1.5)], from, to);
      const alias = ((f % to) > to / 2) ? to - (f % to) : f % to;
      expect(db(level(y, alias, to))).toBeLessThan(-90);
    });

  it('44.1 → 96 kHz: the image of a 10 kHz tone at 34.1 kHz is gone', async () => {
    const [y] = await resampleChannels([tone(10000, 44100, 1.5)], 44100, 96000);
    expect(db(level(y, 34100, 96000))).toBeLessThan(-90);
    expect(db(level(y, 10000, 96000))).toBeGreaterThan(-6.1);
  });

  it('44.1 → 48 kHz: a 20 kHz tone has no image folded back into the band', async () => {
    const [y] = await resampleChannels([tone(20000, 44100, 1.5)], 44100, 48000);
    expect(db(level(y, 48000 - 24100, 48000))).toBeLessThan(-60);          // image at 24.1 kHz sits right at the stopband edge → folds to 23.9 kHz
    expect(db(level(y, 20000, 48000))).toBeGreaterThan(-6.1);
  });
});

describe('resampler — time and shape', () => {
  it('has no delay: an impulse stays at the same instant', async () => {
    for (const [from, to] of [[48000, 44100], [96000, 44100], [44100, 48000]]) {
      const x = new Float32Array(from).fill(0);
      x[Math.round(from * 0.5)] = 1;
      const [y] = await resampleChannels([x], from, to);
      let peak = 0, at = 0;
      for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > peak) { peak = Math.abs(y[i]); at = i; }
      expect(at).toBe(Math.round(to * 0.5));
    }
  });

  it('gives ceil(length × to / from) samples and treats channels independently', async () => {
    const left = tone(1000, 48000, 1), right = tone(3000, 48000, 1);
    const [l, r] = await resampleChannels([left, right], 48000, 44100);
    expect(l.length).toBe(resampledLength(48000, 48000, 44100));
    expect(l.length).toBe(44100);
    expect(db(level(l, 1000, 44100))).toBeCloseTo(db(0.5), 1);
    expect(db(level(l, 3000, 44100))).toBeLessThan(-90);
    expect(db(level(r, 3000, 44100))).toBeCloseTo(db(0.5), 1);
    expect(db(level(r, 1000, 44100))).toBeLessThan(-90);
  });

  it('returns a copy when the rates match, and survives silence and a one-sample input', async () => {
    const x = tone(440, 44100, 0.2);
    const [same] = await resampleChannels([x], 44100, 44100);
    expect(same).not.toBe(x);
    expect(Array.from(same.subarray(0, 50))).toEqual(Array.from(x.subarray(0, 50)));
    const [z] = await resampleChannels([new Float32Array(1000)], 48000, 44100);
    expect(Math.max(...Array.from(z).map(Math.abs))).toBe(0);
    const [one] = await resampleChannels([new Float32Array([0.5])], 96000, 44100);
    expect(one.length).toBe(1);
    expect(Number.isFinite(one[0])).toBe(true);
  });

  it('handles an odd rate whose ratio needs the interpolated table (44100 → 44101)', async () => {
    const plan = planResampler(44100, 44101);
    expect(plan.exact).toBe(false);
    const [y] = await resampleChannels([tone(10000, 44100, 1.5)], 44100, 44101);
    expect(Math.abs(db(level(y, 10000, 44101)) - db(0.5))).toBeLessThan(0.02);
    let worst = 0;
    for (let o = 4410; o < y.length - 4410; o += 7) worst = Math.max(worst, Math.abs(y[o] - 0.5 * Math.sin(2 * Math.PI * 10000 * (o / 44101) + 0.3)));
    expect(db(worst)).toBeLessThan(-85);
  });

  it('uses an exact table for the usual ratios', () => {
    expect(planResampler(48000, 44100)).toMatchObject({ exact: true, phases: 147, step: 160 });
    expect(planResampler(96000, 44100)).toMatchObject({ exact: true, phases: 147, step: 320 });
    expect(planResampler(44100, 48000)).toMatchObject({ exact: true, phases: 160, step: 147 });
    expect(planResampler(48000, 44100).half).toBeLessThanOrEqual(40);
  });
});
