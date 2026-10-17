/**
 * Export accuracy — the last link of the chain. PCM quantisation must be unbiased and accurate, dither must have the
 * level and colour it claims, and the processors must behave the same at every sample rate.
 */
import { describe, it, expect } from 'vitest';
import { encodeWav, type DitherMode } from '@/lib/audioExport';
import { fakeBuffer, loadWorklet, run, tone, rmsDb, peak } from './harness';
import { measureTruePeak } from '@/lib/loudness';

function decode16(ab: ArrayBuffer, channels = 1): Float32Array {
  const v = new DataView(ab);
  const n = (ab.byteLength - 44) / 2 / channels;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(44 + i * 2 * channels, true) / 32768;
  return out;
}
function decode24(ab: ArrayBuffer): Float32Array {
  const v = new DataView(ab);
  const n = (ab.byteLength - 44) / 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 3;
    let s = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
    if (s & 0x800000) s -= 0x1000000;
    out[i] = s / 8388608;
  }
  return out;
}

/** noise power (linear) of `e` around frequency f, Hann-windowed single-bin DFT over the whole of `e` */
function bandPower(e: Float32Array, f: number, sr: number): number {
  let re = 0, im = 0, w2 = 0;
  const N = e.length;
  for (let n = 0; n < N; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
    const ph = (2 * Math.PI * f * n) / sr;
    re += e[n] * w * Math.cos(ph);
    im -= e[n] * w * Math.sin(ph);
    w2 += w * w;
  }
  return (re * re + im * im) / w2;
}
const avgPower = (e: Float32Array, freqs: number[], sr: number) => freqs.reduce((s, f) => s + bandPower(e, f, sr), 0) / freqs.length;
const span = (a: number, b: number, n = 40) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const db = (x: number) => 10 * Math.log10(x + 1e-30);

// a quiet, dense-in-LSB programme so quantisation error is exercised (−60 dBFS sine, never exactly on the grid)
const SRATE = 48000;
const orig = tone(997, -60, 1.5, SRATE, 0.3);
const errorOf = (mode: DitherMode, bits: 16 | 24 = 16) => {
  const ab = encodeWav(fakeBuffer([orig], SRATE), bits, mode);
  const dec = bits === 16 ? decode16(ab) : decode24(ab);
  const e = new Float32Array(orig.length);
  for (let i = 0; i < e.length; i++) e[i] = dec[i] - orig[i];
  return e;
};

describe('export — PCM quantisation', () => {
  const LSB16 = 1 / 32768;

  it('16-bit without dither rounds to nearest: error ≤ ½ LSB (+ the 32767/32768 scale), no bias', () => {
    const e = errorOf('none');
    let mx = 0, sum = 0;
    for (const v of e) { mx = Math.max(mx, Math.abs(v)); sum += v; }
    expect(mx).toBeLessThan(0.55 * LSB16);
    expect(Math.abs(sum / e.length)).toBeLessThan(0.05 * LSB16);
  });

  it('16-bit TPDF dither: noise ≈ ½ LSB rms (TPDF + quantisation), white, unbiased', () => {
    const e = errorOf('tpdf');
    let s2 = 0, sum = 0;
    for (const v of e) { s2 += v * v; sum += v; }
    const rms = Math.sqrt(s2 / e.length) / LSB16;
    expect(rms).toBeGreaterThan(0.42);
    expect(rms).toBeLessThan(0.62);
    expect(Math.abs(sum / e.length)).toBeLessThan(0.05 * LSB16);
    const lo = db(avgPower(e, span(1500, 3500), SRATE)), hi = db(avgPower(e, span(15000, 19000), SRATE));
    expect(Math.abs(lo - hi)).toBeLessThan(2.5);                       // flat spectrum
  });

  it('TPDF dither removes the harmonic distortion of plain truncation (no spurs above the noise floor)', () => {
    const plain = errorOf('none');
    const dith = errorOf('tpdf');
    const harm = (e: Float32Array) => db(avgPower(e, [2991, 3988, 4985, 5982], SRATE));
    const floor = (e: Float32Array) => db(avgPower(e, span(2400, 5600), SRATE));
    expect(harm(dith) - floor(dith)).toBeLessThan(6);
    expect(harm(plain) - floor(plain)).toBeGreaterThanOrEqual(harm(dith) - floor(dith) - 3);
  });

  it('noise-shaped dither moves the noise OUT of the sensitive 1–6 kHz region into the top octave', () => {
    const tp = errorOf('tpdf'), sh = errorOf('shaped');
    const mid = (e: Float32Array) => db(avgPower(e, span(2000, 5000), SRATE));
    const top = (e: Float32Array) => db(avgPower(e, span(18000, 22000), SRATE));
    expect(mid(sh)).toBeLessThan(mid(tp) - 3);        // quieter where the ear is most sensitive
    expect(top(sh)).toBeGreaterThan(top(tp));          // paid for at the top
    const rms = (e: Float32Array) => Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length) / LSB16;
    expect(rms(sh)).toBeLessThan(6);                   // and stable: not blown up by the feedback
  });

  it('full scale and over-range samples clip to the integer range instead of wrapping', () => {
    const x = Float32Array.from([1, -1, 1.5, -1.5, 0.99999, -0.99999]);
    const dec = decode16(encodeWav(fakeBuffer([x], SRATE), 16, 'none'));
    expect(dec[0]).toBeGreaterThan(0.999); expect(dec[1]).toBeLessThan(-0.999);
    expect(dec[2]).toBeGreaterThan(0.999); expect(dec[3]).toBeLessThan(-0.999);
    expect(dec[4]).toBeGreaterThan(0.999); expect(dec[5]).toBeLessThan(-0.999);
  });

  it('24-bit is transparent: error ≤ ½ LSB(24) without dither', () => {
    const e = errorOf('none', 24);
    let mx = 0;
    for (const v of e) mx = Math.max(mx, Math.abs(v));
    expect(mx).toBeLessThan(0.6 / 8388608 + 1e-9);          // float32 input resolution is the limit here
  });

  it('writes a valid canonical header for 16/24/32-bit', () => {
    for (const bits of [16, 24, 32] as const) {
      const ab = encodeWav(fakeBuffer([orig.subarray(0, 480), orig.subarray(0, 480)], 44100), bits, 'tpdf');
      const v = new DataView(ab);
      const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
      expect(v.getUint16(20, true)).toBe(bits === 32 ? 3 : 1);
      expect(v.getUint16(22, true)).toBe(2);
      expect(v.getUint32(24, true)).toBe(44100);
      expect(v.getUint16(34, true)).toBe(bits);
      expect(v.getUint32(40, true)).toBe(480 * 2 * (bits / 8));
      expect(ab.byteLength).toBe(44 + 480 * 2 * (bits / 8));
    }
  });
});

describe('worklets at other sample rates', () => {
  for (const sr of [44100, 96000]) {
    it(`limiter holds the ceiling at ${sr} Hz`, () => {
      const Cls = loadWorklet('lookahead-limiter-processor.js', sr);
      const hot = tone(1000, 6, 1.5, sr);
      const { L, R } = run(Cls, hot, Float32Array.from(hot), { params: { ceiling: -1, margin: 0.3, release: 50 } });
      const tp = measureTruePeak(fakeBuffer([L, R], sr)).truePeak;
      expect(tp).toBeLessThanOrEqual(-1 + 0.35);
      expect(peak(L, sr)).toBeGreaterThan(0.5);               // and it did not just mute the signal
    });

    it(`compressor attack time is the same in milliseconds at ${sr} Hz`, () => {
      const Cls = loadWorklet('compressor-processor.js', sr);
      const x = new Float32Array(Math.round(sr * 1.5));
      const lo = tone(1000, -40, 1.5, sr), hi = tone(1000, -10, 1.5, sr);
      for (let i = 0; i < x.length; i++) x[i] = i < sr * 0.5 ? lo[i] : hi[i];
      const { L } = run(Cls, x, Float32Array.from(x), { processorOptions: { threshold: -20, ratio: 4, attack: 20, release: 200, knee: 0, makeup: 0, mix: 100, detect: 'peak', mode: 'stereo' } });
      const win = Math.round(sr * 0.001);
      const g: number[] = [];
      for (let s = Math.round(sr * 0.5); s + win < sr * 1.4; s += win) {
        let pi = 0, po = 0;
        for (let i = s; i < s + win; i++) { pi = Math.max(pi, Math.abs(x[i])); po = Math.max(po, Math.abs(L[i])); }
        g.push(20 * Math.log10((po + 1e-9) / (pi + 1e-9)));
      }
      const t63 = g.findIndex((v) => v <= g[g.length - 1] * 0.632);
      expect(t63).toBeGreaterThan(11);
      expect(t63).toBeLessThan(31);
    });

    it(`bass-mono keeps the highs stereo and sums the lows at ${sr} Hz`, () => {
      const Cls = loadWorklet('bass-mono-processor.js', sr);
      const l = tone(60, -10, 1, sr), r = tone(60, -10, 1, sr, Math.PI);          // out-of-phase bass
      const out = run(Cls, l, r, { processorOptions: { freq: 140 } });
      expect(rmsDb(out.L, sr * 0.5)).toBeLessThan(-35);                            // cancelled to mono (the rest is the 24 dB/oct HP leakage)
      const hl = tone(5000, -10, 1, sr), hr = tone(5000, -10, 1, sr, Math.PI);
      const o2 = run(Cls, hl, hr, { processorOptions: { freq: 140 } });
      expect(rmsDb(o2.L, sr * 0.5)).toBeGreaterThan(-14);                          // highs untouched
    });

    it(`bass-mono is flat for centred (mono) material at ${sr} Hz — no notch at the crossover`, () => {
      const Cls = loadWorklet('bass-mono-processor.js', sr);
      for (const f of [40, 100, 140, 200, 500, 3000]) {
        const x = tone(f, -12, 1.5, sr);
        const o = run(Cls, x, Float32Array.from(x), { processorOptions: { freq: 140 } });
        expect(Math.abs(rmsDb(o.L, Math.round(sr * 0.7)) - rmsDb(x, Math.round(sr * 0.7)))).toBeLessThan(0.6);
      }
    });
  }
});
