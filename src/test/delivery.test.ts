import { describe, it, expect } from 'vitest';
import { analyseMono, deliveryVerdict, type CodecResult } from '@/lib/delivery';
import { fakeBuffer, noise, tone, SR } from './harness';

const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
const neg = (a: Float32Array) => a.map((v) => -v);

describe('delivery — mono compatibility', () => {
  it('identical channels: correlation 1, nothing lost in mono', () => {
    const x = add(tone(80, -12, 3), add(tone(1000, -18, 3), tone(8000, -24, 3)));
    const r = analyseMono(fakeBuffer([x, Float32Array.from(x)]));
    expect(r.correlation).toBeGreaterThan(0.999);
    for (const b of r.bands) expect(Math.abs(b.lossDb)).toBeLessThan(0.1);
  });

  it('unrelated channels: correlation ≈ 0, about −3 dB in mono', () => {
    const r = analyseMono(fakeBuffer([noise(3, 0.1, 1), noise(3, 0.1, 2)]));
    expect(Math.abs(r.correlation)).toBeLessThan(0.05);
    for (const b of r.bands) expect(b.lossDb).toBeGreaterThan(-3.6), expect(b.lossDb).toBeLessThan(-2.4);
  });

  it('out-of-phase bass under in-phase highs: the low band cancels, the highs survive', () => {
    const bass = tone(70, -10, 3), hi = tone(3000, -16, 3);
    const r = analyseMono(fakeBuffer([add(bass, hi), add(neg(bass), hi)]));
    const sub = r.bands.find((b) => b.name === 'Sub')!, mid = r.bands.find((b) => b.name === 'Mid')!;
    expect(sub.lossDb).toBeLessThan(-30);
    expect(Math.abs(mid.lossDb)).toBeLessThan(0.3);
  });

  it('finds the worst passage and ignores silence', () => {
    const n = SR * 4;
    const a = noise(4, 0.1, 3);
    const b = Float32Array.from(a);
    for (let i = SR * 2; i < SR * 2.8; i++) b[i] = -a[i];          // 0.8 s out of phase at 2.0 s
    for (let i = SR * 3.5; i < n; i++) { a[i] = 0; b[i] = 0; }      // trailing silence
    const r = analyseMono(fakeBuffer([a, b]));
    expect(r.worstCorrelation).toBeLessThan(-0.9);
    expect(r.worstAtSec).toBeGreaterThanOrEqual(1.9);
    expect(r.worstAtSec).toBeLessThan(2.5);
  });

  it('a mono file is perfectly mono-compatible', () => {
    const r = analyseMono(fakeBuffer([tone(440, -12, 2)]));
    expect(r.correlation).toBeCloseTo(1, 5);
  });
});

describe('delivery — verdict', () => {
  const okMono = { correlation: 0.6, worstCorrelation: 0.2, worstAtSec: 10, bands: [
    { name: 'Sub', lowHz: 20, highHz: 120, lossDb: -0.1 }, { name: 'Low', lowHz: 120, highHz: 500, lossDb: -0.4 },
    { name: 'Mid', lowHz: 500, highHz: 4000, lossDb: -1.5 }, { name: 'High', lowHz: 4000, highHz: 20000, lossDb: -2 }] };
  const codec = (tp: number | null, available = true): CodecResult => ({ id: 'aac-256', label: 'AAC 256 kbps', platforms: 'Apple', available, truePeak: tp });

  it('codec overshoot past −1 dBTP gives a concrete lower ceiling', () => {
    const f = deliveryVerdict(-1.0, [codec(-0.2)], okMono);
    expect(f[0].level).toBe('warn');
    expect(f[0].text).toContain('-1.9');               // −1.0 − 0.8 overshoot − 0.1 margin
  });

  it('over 0 dBFS after the transcode is a fail; under −1 is codec-safe', () => {
    expect(deliveryVerdict(-0.3, [codec(0.6)], okMono)[0].level).toBe('fail');
    expect(deliveryVerdict(-2, [codec(-1.4)], okMono)[0].level).toBe('ok');
  });

  it('a low band that cancels in mono fails and points at Bass Mono', () => {
    const bad = { ...okMono, bands: okMono.bands.map((b) => (b.name === 'Sub' ? { ...b, lossDb: -9 } : b)) };
    const f = deliveryVerdict(-2, [codec(-1.5)], bad);
    const sub = f.find((x) => x.text.startsWith('Sub'))!;
    expect(sub.level).toBe('fail');
    expect(sub.text).toContain('Bass Mono');
  });

  it('codecs the browser cannot encode are simply skipped', () => {
    const f = deliveryVerdict(-2, [codec(null, false)], okMono);
    expect(f.every((x) => x.level === 'ok')).toBe(true);
  });
});
