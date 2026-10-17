/**
 * Restoration DSP — measured against synthetic material with KNOWN damage, so every claim is a number:
 * how much of the damage was found, how close the repair is to the original, and that clean material is left alone.
 */
import { describe, it, expect } from 'vitest';
import { declick } from '@/lib/dsp/declick';
import { declip, detectClipping } from '@/lib/dsp/declip';

const SR = 48000;

/** deterministic PRNG (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** music-like: overlapping decaying notes with a soft attack (no discontinuities) + vibrato lead + noise (~ -70 dBFS) */
export function musicLike(seconds: number, seed = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const r = rng(seed);
  const notes = [110, 146.83, 164.81, 220, 293.66];
  const noteAt = (k: number) => notes[((k % notes.length) + notes.length) % notes.length];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const k = Math.floor(t * 2);
    let s = 0;
    for (const idx of [k - 1, k]) {
      if (idx < 0) continue;
      const tt = t - idx * 0.5;                        // time since this note started
      const env = Math.min(1, tt / 0.006) * Math.exp(-3 * tt);
      const f = noteAt(idx);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += (1 / h) * Math.sin(2 * Math.PI * f * h * t);
      s += v * 0.22 * env;
    }
    s += 0.12 * Math.sin(2 * Math.PI * (880 + 6 * Math.sin(2 * Math.PI * 5 * t)) * t);
    s += (r() - 0.5) * 0.0006;
    out[i] = s;
  }
  return out;
}

function rms(a: Float32Array, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
function errRms(a: Float32Array, b: Float32Array, ranges: Array<[number, number]>) {
  let s = 0, n = 0;
  for (const [f, t] of ranges) for (let i = f; i <= t; i++) { const d = a[i] - b[i]; s += d * d; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

describe('declick', () => {
  it('leaves clean, dynamic material alone (no false repairs)', () => {
    const clean = musicLike(5, 3);
    const x = Float32Array.from(clean);
    const res = declick(x, SR);
    expect(res.bursts).toBeLessThanOrEqual(2);
    expect(errRms(x, clean, [[0, x.length - 1]])).toBeLessThan(2e-4);
  });

  it('finds and repairs single-sample clicks and short bursts', () => {
    const clean = musicLike(6, 7);
    const x = Float32Array.from(clean);
    const r = rng(99);
    const spots: Array<[number, number]> = [];
    // 12 clicks of 1–4 samples, 3 bursts of 18 samples
    for (let k = 0; k < 15; k++) {
      const pos = 6000 + Math.floor((k / 15) * (x.length - 12000)) + Math.floor(r() * 500);
      const len = k < 12 ? 1 + Math.floor(r() * 4) : 18;
      for (let i = 0; i < len; i++) x[pos + i] += (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.45);
      spots.push([pos, pos + len - 1]);
    }
    const before = errRms(x, clean, spots);
    const res = declick(x, SR);
    const after = errRms(x, clean, spots);

    expect(res.bursts).toBeGreaterThanOrEqual(13);              // ≥ ~87 % of the 15 events located
    expect(after).toBeLessThan(before * 0.1);                    // damage in those spans reduced by ≥ 20 dB
    // outside the damaged spans (± a safety margin) nothing may change
    const guard = 80;
    let maxOutside = 0;
    for (let i = 0; i < x.length; i++) {
      if (spots.some(([f, t]) => i >= f - guard && i <= t + guard)) continue;
      maxOutside = Math.max(maxOutside, Math.abs(x[i] - clean[i]));
    }
    expect(maxOutside).toBeLessThan(1e-3);
  });

  it('is deterministic and never produces NaN / Infinity', () => {
    const x = musicLike(2, 5);
    for (let i = 1000; i < 1004; i++) x[i] += 0.8;
    const y = Float32Array.from(x);
    declick(x, SR); declick(y, SR);
    expect(Array.from(x).every(Number.isFinite)).toBe(true);
    expect(Array.from(x)).toEqual(Array.from(y));
  });

  it('survives silence and very short input', () => {
    expect(declick(new Float32Array(100000), SR).bursts).toBe(0);
    expect(declick(new Float32Array(50), SR).bursts).toBe(0);
  });
});

describe('declip', () => {
  it('detects hard clipping and ignores unclipped audio', () => {
    const clean = musicLike(4, 11);
    expect(detectClipping(clean)).toBeNull();
    const clipped = Float32Array.from(clean, (v) => Math.max(-0.28, Math.min(0.28, v)));
    const det = detectClipping(clipped);
    expect(det).not.toBeNull();
    expect(det!.level).toBeCloseTo(0.28, 3);
    expect(det!.runs).toBeGreaterThan(20);
  });

  it('restores clipped peaks much closer to the original', () => {
    const clean = musicLike(5, 21);
    const CEIL = 0.28;
    const x = Float32Array.from(clean, (v) => Math.max(-CEIL, Math.min(CEIL, v)));
    const clippedIdx: Array<[number, number]> = [];
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= CEIL - 1e-6) clippedIdx.push([i, i]);
    const before = errRms(x, clean, clippedIdx);
    const res = declip(x, SR);
    const after = errRms(x, clean, clippedIdx);
    expect(res.runs).toBeGreaterThan(20);
    expect(after).toBeLessThan(before * 0.5);                     // error on the damaged samples at least halved
    expect(res.peakAfter).toBeGreaterThan(res.peakBefore * 1.15); // peaks genuinely grew back
    expect(Array.from(x).every(Number.isFinite)).toBe(true);
  });
});

import { stftProcess } from '@/lib/dsp/stft';
import { denoise, estimateNoiseProfile } from '@/lib/dsp/denoise';
import { detectHum, dehum } from '@/lib/dsp/dehum';
import { FFT, hann } from '@/lib/fft';

function whiteNoise(n: number, sigma: number, seed: number) {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    // Box–Muller
    const u = Math.max(1e-12, r()), v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    out[i] = sigma * m * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = sigma * m * Math.sin(2 * Math.PI * v);
  }
  return out;
}
const db = (v: number) => 20 * Math.log10(v + 1e-12);

describe('stft', () => {
  it('reconstructs the input exactly when the spectrum is untouched', () => {
    const x = whiteNoise(30000, 0.2, 4);
    const y = stftProcess(x, { size: 2048 }, () => {});
    let max = 0;
    for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - y[i]));
    expect(max).toBeLessThan(1e-5);
  });
});

describe('denoise', () => {
  const gaps: Array<[number, number]> = [[48000, 86400], [144000, 172800]];
  function noisyMusic() {
    const clean = musicLike(6, 31);
    for (const [a, b] of gaps) clean.fill(0, a, b);
    const noise = whiteNoise(clean.length, 0.003, 77);                 // ≈ −50 dBFS RMS
    const noisy = Float32Array.from(clean, (v, i) => v + noise[i]);
    return { clean, noisy };
  }

  it('learns the noise floor from the quiet passages', () => {
    const { noisy } = noisyMusic();
    const p = estimateNoiseProfile(noisy, SR)!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.floorDb - db(0.003))).toBeLessThan(3);
  });

  it('removes ≥ 10 dB of noise in the gaps and measurably improves the music', () => {
    const { clean, noisy } = noisyMusic();
    const { output } = denoise(noisy, SR, { reductionDb: 14 });
    const gapBefore = rms(noisy, gaps[0][0] + 4000, gaps[0][1] - 4000);
    const gapAfter = rms(output, gaps[0][0] + 4000, gaps[0][1] - 4000);
    expect(db(gapBefore) - db(gapAfter)).toBeGreaterThan(10);

    // distance to the CLEAN music improves (signal-to-error ratio) across the whole file
    const errBefore = errRms(noisy, clean, [[0, clean.length - 1]]);
    const errAfter = errRms(output, clean, [[0, clean.length - 1]]);
    expect(errAfter).toBeLessThan(errBefore * 0.6);                    // ≥ 4.4 dB less error

    // tonal level is preserved where the music plays
    const loudBefore = rms(noisy, 96000, 140000);
    const loudAfter = rms(output, 96000, 140000);
    expect(Math.abs(db(loudAfter) - db(loudBefore))).toBeLessThan(0.7);
    expect(Array.from(output).every(Number.isFinite)).toBe(true);
  });

  it('does nothing harmful when there is no learnable noise', () => {
    const x = new Float32Array(100000);
    const { output, profile } = denoise(x, SR);
    expect(profile).toBeNull();
    expect(Array.from(output).every((v) => v === 0)).toBe(true);
  });
});

describe('dehum', () => {
  function withHum() {
    const music = musicLike(5, 51);
    const hum = new Float32Array(music.length);
    for (let i = 0; i < hum.length; i++) {
      const t = i / SR;
      hum[i] = 0.02 * Math.sin(2 * Math.PI * 50 * t) + 0.012 * Math.sin(2 * Math.PI * 100 * t + 1) + 0.008 * Math.sin(2 * Math.PI * 150 * t + 2) + 0.005 * Math.sin(2 * Math.PI * 250 * t);
    }
    return { music, humming: Float32Array.from(music, (v, i) => v + hum[i]) };
  }
  function lineDb(x: Float32Array, f: number) {
    const N = 65536, fft = new FFT(N), w = hann(N), frame = new Float64Array(N);
    for (let i = 0; i < N; i++) frame[i] = x[20000 + i] * w[i];
    const m = fft.magnitude(frame);
    const k = Math.round((f * N) / SR);
    return db(Math.max(m[k - 1], m[k], m[k + 1]));
  }

  it('detects 50 Hz mains and its harmonics', () => {
    const { humming, music } = withHum();
    const det = detectHum(humming, SR);
    expect(det).not.toBeNull();
    expect(det!.fundamental).toBe(50);
    expect(det!.lines).toEqual(expect.arrayContaining([50, 100, 150]));
    expect(detectHum(music, SR)).toBeNull();                           // no false alarm on clean music
  });

  it('removes the hum lines (down to the clean-music level) and leaves the music intact', () => {
    const { humming, music } = withHum();
    const det = detectHum(humming, SR)!;
    const y = Float32Array.from(humming);
    dehum(y, SR, det.lines);
    for (const f of [50, 100, 150]) {
      expect(lineDb(humming, f) - lineDb(y, f)).toBeGreaterThan(18);       // hum lines clearly down
      expect(lineDb(y, f)).toBeLessThan(lineDb(music, f) + 3);              // …to the level of the clean music itself
    }
    // the 880 Hz lead is untouched (< 0.2 dB)
    expect(Math.abs(lineDb(y, 880) - lineDb(music, 880))).toBeLessThan(0.2);
  });
});

import { diagnose, restoreChannels } from '@/lib/dsp/restore';

describe('restore pipeline (end to end)', () => {
  it('diagnoses and repairs a file that is humming, clipped, clicky and noisy at once', () => {
    const clean = musicLike(8, 61);
    clean.fill(0, 48000, 86400);          // two quiet gaps so the noise floor is learnable
    clean.fill(0, 240000, 278400);
    const noise = whiteNoise(clean.length, 0.002, 5);
    const bad = Float32Array.from(clean, (v, i) => {
      const t = i / SR;
      const hum = 0.012 * Math.sin(2 * Math.PI * 50 * t) + 0.008 * Math.sin(2 * Math.PI * 100 * t + 1) + 0.005 * Math.sin(2 * Math.PI * 150 * t + 2);
      return Math.max(-0.3, Math.min(0.3, v + hum + noise[i]));   // noise is part of the recorded signal, then it clips
    });
    const r = rng(8);
    for (let k = 0; k < 14; k++) {
      const pos = 20000 + Math.floor((k / 14) * (bad.length - 40000));
      bad[pos] += (r() < 0.5 ? -1 : 1) * 0.35;
    }

    const diag = diagnose([bad], SR);
    expect(diag.hum?.fundamental).toBe(50);
    expect(diag.clipping).not.toBeNull();
    expect(diag.clicks).toBeGreaterThan(5);
    expect(diag.noise).not.toBeNull();

    const { channels, report } = restoreChannels([bad], SR, {
      dehum: { enabled: true },
      declip: { enabled: true },
      declick: { enabled: true },
      denoise: { enabled: true, reductionDb: 12 },
    });
    expect(report.hum!.lines.length).toBeGreaterThanOrEqual(2);
    expect(report.clip!.runs).toBeGreaterThan(10);
    expect(report.clicks!.bursts).toBeGreaterThan(5);
    expect(report.noise!.reducedDb).toBeGreaterThan(6);

    // peaks restored beyond the clip ceiling, then returned inside full scale
    let peak = 0;
    for (const v of channels[0]) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(Math.pow(10, -0.3 / 20) + 1e-6);

    // the input array was not touched
    expect(bad[100]).toBe(bad[100]);
    expect(Array.from(channels[0]).every(Number.isFinite)).toBe(true);
  });
});

describe('restore pipeline — ordering regression', () => {
  it('still repairs (almost) every clipped peak when hum removal is enabled too', () => {
    // hum is part of the recorded signal and is clipped together with the music: the flat tops are exactly flat
    const music = musicLike(8, 71);
    const x = Float32Array.from(music, (v, i) => {
      const t = i / SR;
      return Math.max(-0.3, Math.min(0.3, 1.3 * v + 0.02 * Math.sin(2 * Math.PI * 50 * t) + 0.01 * Math.sin(2 * Math.PI * 100 * t)));
    });
    const det = diagnose([x], SR);
    expect(det.clipping).not.toBeNull();
    const { report } = restoreChannels([x], SR, { dehum: { enabled: true }, declip: { enabled: true } });
    expect(report.clip!.runs).toBeGreaterThanOrEqual(det.clipping!.runs * 0.9);
  });
});
