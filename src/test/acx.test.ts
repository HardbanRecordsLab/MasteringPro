import { describe, it, expect } from 'vitest';
import { ACX, acxChecks, fixForAcx, limitPeaks, measureAcx } from '@/lib/acx';

const SR = 44100;
const lin = (db: number) => Math.pow(10, db / 20);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * A stand-in for narration: syllable-like bursts (a voiced 110 Hz source with harmonics and a little breath noise, shaped by a 4 Hz
 * envelope) in phrases with pauses, over steady room noise, with `head` s / `tail` s of room tone at the ends and a plosive spike.
 */
function narration(opts: { seconds?: number; speechDb?: number; noiseDb?: number; head?: number; tail?: number; spikeDb?: number; seed?: number } = {}) {
  const { seconds = 22, speechDb = -26, noiseDb = -50, head = 0.1, tail = 0.2, spikeDb = -0.5, seed = 3 } = opts;
  const n = Math.round(seconds * SR);
  const r = rng(seed);
  const x = new Float32Array(n);
  const speech = new Float32Array(n);
  const t0 = Math.round(head * SR), t1 = n - Math.round(tail * SR);
  for (let i = t0; i < t1; i++) {
    const t = (i - t0) / SR;
    const phrase = (t % 6) < 4.6 ? 1 : 0;                                // 4.6 s of speech, 1.4 s pause
    const env = phrase * Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4 * t)), 0.7);
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 110 * h * t) / h;
    speech[i] = env * (v + 0.15 * gauss(r));
  }
  let ss = 0;
  for (let i = t0; i < t1; i++) ss += speech[i] * speech[i];
  const g = lin(speechDb) / Math.sqrt(ss / (t1 - t0));                  // speechDb = RMS over the speaking part
  for (let i = 0; i < n; i++) x[i] = speech[i] * g + lin(noiseDb) * gauss(r);
  x[Math.round(7.3 * SR)] = lin(spikeDb);                              // a plosive
  return [x];
}

describe('measureAcx', () => {
  it('measures level, peak, noise floor and the silence at both ends', () => {
    const m = measureAcx(narration({ head: 0.3, tail: 3.0 }), SR);
    expect(m.peakDb).toBeCloseTo(-0.5, 1);
    expect(m.noiseFloorDb!).toBeGreaterThan(-52);
    expect(m.noiseFloorDb!).toBeLessThan(-48);                         // the room noise set at -50 dB RMS
    expect(m.headS).toBeGreaterThan(0.2);
    expect(m.headS).toBeLessThan(0.4);
    expect(m.tailS).toBeGreaterThan(2.8);
    expect(m.tailS).toBeLessThan(3.2);
    expect(m.durationS).toBeCloseTo(22, 3);
    expect(m.rmsDb).toBeLessThan(-26);
    expect(m.rmsDb).toBeGreaterThan(-40);
  });

  it('an RMS of a constant tone is its amplitude over root two', () => {
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const m = measureAcx([x], SR);
    expect(m.rmsDb).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 1);
    expect(m.peakDb).toBeCloseTo(-6.02, 1);
  });

  it('survives empty, very short and silent files', () => {
    expect(measureAcx([new Float32Array(0)], SR).durationS).toBe(0);
    expect(measureAcx([new Float32Array(1000)], SR).noiseFloorDb).toBeNull();
    const silent = measureAcx([new Float32Array(SR * 3)], SR);
    expect(silent.rmsDb).toBeLessThan(-100);
    expect(silent.headS + silent.tailS).toBeGreaterThan(2.9);
  });
});

describe('acxChecks', () => {
  it('flags every failing requirement with a fix, and passes a file that meets them', () => {
    const bad = acxChecks(measureAcx(narration({ speechDb: -30, noiseDb: -50, head: 0.1, tail: 0.2 }), SR), { sampleRate: 48000, channels: 2 });
    const lv = Object.fromEntries(bad.map((c) => [c.id, c.level]));
    expect(lv).toMatchObject({ rms: 'fail', noise: 'fail', head: 'fail', tail: 'fail', format: 'warn' });
    expect(bad.filter((c) => c.level !== 'pass').every((c) => !!c.fix)).toBe(true);
    const good = acxChecks({ rmsDb: -20, peakDb: -4, noiseFloorDb: -64, headS: 0.7, tailS: 2, durationS: 600, quietStart: 0 }, { sampleRate: 44100, channels: 1 });
    expect(good.every((c) => c.level === 'pass')).toBe(true);
  });

  it('applies the published limits at their edges', () => {
    const at = (p: Partial<{ rmsDb: number; peakDb: number; noiseFloorDb: number; headS: number; tailS: number }>) => {
      const base = { rmsDb: -20, peakDb: -4, noiseFloorDb: -64, headS: 0.7, tailS: 2, durationS: 60, quietStart: 0, ...p };
      return Object.fromEntries(acxChecks(base).map((c) => [c.id, c.level]));
    };
    expect(at({ rmsDb: -23 }).rms).toBe('pass');
    expect(at({ rmsDb: -23.1 }).rms).toBe('fail');
    expect(at({ rmsDb: -18 }).rms).toBe('pass');
    expect(at({ rmsDb: -17.9 }).rms).toBe('fail');
    expect(at({ peakDb: -3 }).peak).toBe('pass');
    expect(at({ peakDb: -2.9 }).peak).toBe('fail');
    expect(at({ noiseFloorDb: -60 }).noise).toBe('pass');
    expect(at({ noiseFloorDb: -59.9 }).noise).toBe('fail');
    expect(at({ headS: 0.5 }).head).toBe('pass');
    expect(at({ headS: 0.49 }).head).toBe('fail');
    expect(at({ headS: 1.01 }).head).toBe('fail');
    expect(at({ tailS: 1 }).tail).toBe('pass');
    expect(at({ tailS: 5.01 }).tail).toBe('fail');
  });
});

describe('limitPeaks', () => {
  it('never lets a sample past the ceiling, and leaves quiet audio untouched', () => {
    const x = narration({ spikeDb: 0 })[0];
    const ceiling = lin(-3.4);
    const y = limitPeaks([x], SR, ceiling)[0];
    let pk = 0;
    for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]));
    expect(pk).toBeLessThanOrEqual(ceiling + 1e-6);
    const quiet = Float32Array.from(x, (v) => v * 0.1);
    const same = limitPeaks([quiet], SR, ceiling)[0];
    expect(Array.from(same.subarray(1000, 1100))).toEqual(Array.from(quiet.subarray(1000, 1100)));
  });

  it('pulls the gain down BEFORE the peak (look-ahead) and not for long after it', () => {
    const x = new Float32Array(SR);
    x.fill(0.2);
    x[SR / 2] = 1;
    const y = limitPeaks([x], SR, 0.5, 5, 60)[0];
    expect(y[SR / 2 - 100]).toBeLessThan(0.2);                          // already reduced 2 ms ahead of the peak
    expect(Math.abs(y[SR / 2])).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(y[SR - 10]).toBeCloseTo(0.2, 2);                             // recovered well before the end
  });
});

describe('fixForAcx', () => {
  it('turns a quiet, noisy narration with no room tone into a file that meets every limit', () => {
    const src = narration({ speechDb: -28, noiseDb: -62, head: 0.1, tail: 0.2 });
    const before = acxChecks(measureAcx(src, SR));
    expect(before.some((c) => c.level === 'fail')).toBe(true);
    const { channels, report } = fixForAcx(src, SR);
    const after = acxChecks(measureAcx(channels, SR));
    expect(after.filter((c) => c.level === 'fail').map((c) => `${c.id}: ${c.value}`)).toEqual([]);
    expect(report.after.rmsDb).toBeGreaterThanOrEqual(ACX.rmsMinDb);
    expect(report.after.rmsDb).toBeLessThanOrEqual(ACX.rmsMaxDb);
    expect(report.after.peakDb).toBeLessThanOrEqual(ACX.peakMaxDb);
    expect(report.after.noiseFloorDb!).toBeLessThanOrEqual(ACX.noiseFloorMaxDb);
    expect(report.steps.length).toBeGreaterThanOrEqual(3);
    expect(src[0].length).toBe(Math.round(22 * SR));                      // the input array was not modified in place
  });

  it('says so when the room is too noisy to repair, instead of pretending', () => {
    const { report } = fixForAcx(narration({ speechDb: -34, noiseDb: -38, head: 0.8, tail: 2 }), SR);
    const noise = acxChecks(report.after).find((c) => c.id === 'noise')!;
    expect(noise.level).toBe('fail');                                   // speech only 4 dB above the noise cannot reach a -60 dB floor
    expect(report.denoiseDb).toBeGreaterThan(0);
    expect(report.after.rmsDb).toBeGreaterThanOrEqual(ACX.rmsMinDb - 0.5);   // the rest was still done
  });

  it('trims silence that is too long instead of adding more', () => {
    const src = narration({ speechDb: -22, noiseDb: -70, head: 3.0, tail: 9.0 });
    const { channels, report } = fixForAcx(src, SR);
    expect(report.after.headS).toBeGreaterThanOrEqual(ACX.headMinS);
    expect(report.after.headS).toBeLessThanOrEqual(ACX.headMaxS);
    expect(report.after.tailS).toBeGreaterThanOrEqual(ACX.tailMinS);
    expect(report.after.tailS).toBeLessThanOrEqual(ACX.tailMaxS);
    expect(channels[0].length).toBeLessThan(src[0].length);
  });

  it('leaves a compliant file almost alone (no noise reduction, room tone kept)', () => {
    const src = narration({ speechDb: -19.4, noiseDb: -72, head: 0.7, tail: 2.0, spikeDb: -6 });
    const m = measureAcx(src, SR);
    const pre = acxChecks(m).filter((c) => c.level === 'fail').map((c) => c.id);
    const { report } = fixForAcx(src, SR);
    expect(report.denoiseDb).toBe(0);
    expect(Math.abs(report.gainDb)).toBeLessThan(3);
    expect(report.after.headS).toBeCloseTo(m.headS, 1);
    expect(acxChecks(report.after).every((c) => c.level === 'pass' || c.id === 'format')).toBe(true);
    expect(pre.length).toBeLessThanOrEqual(2);
  });

  it('mixes to mono on request', () => {
    const a = narration({ seed: 5 })[0], b = narration({ seed: 6 })[0];
    const { channels } = fixForAcx([a, b], SR, { mono: true });
    expect(channels.length).toBe(1);
  });

  it('keeps the speech intact: the repaired file correlates with the original through the level change', () => {
    const src = narration({ speechDb: -30, noiseDb: -70, head: 0.7, tail: 2 });
    const { channels } = fixForAcx(src, SR);
    // compare a window of the speech (offset by the unchanged 0.7 s head) after removing the gain difference
    const a = src[0].subarray(Math.round(2 * SR), Math.round(4 * SR)), b = channels[0].subarray(Math.round(2 * SR), Math.round(4 * SR));
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    expect(ab / Math.sqrt(aa * bb)).toBeGreaterThan(0.97);
  });
});

import { PODCAST, fixForPodcast } from '@/lib/acx';
import { measureIntegratedLoudness } from '@/lib/loudness';

const asBuf = (ch: Float32Array[]) => ({ sampleRate: SR, length: ch[0].length, numberOfChannels: ch.length, duration: ch[0].length / SR, getChannelData: (c: number) => ch[c] }) as unknown as AudioBuffer;

describe('fixForPodcast', () => {
  it('brings a quiet speech episode to -16 LUFS with the peaks under the ceiling', () => {
    const src = narration({ speechDb: -30, noiseDb: -70, spikeDb: -1 });
    const before = measureIntegratedLoudness(asBuf(src));
    expect(before).toBeLessThan(-26);
    const { channels, report } = fixForPodcast(src, SR);
    const after = measureIntegratedLoudness(asBuf(channels));
    expect(Math.abs(after - PODCAST.lufs)).toBeLessThanOrEqual(0.3);
    expect(report.peakDb).toBeLessThanOrEqual(PODCAST.ceilingDb - 0.5 + 0.01);         // half a dB of room left for the MP3 encode
    expect(report.reached).toBe(true);
    expect(report.beforeLufs).toBeCloseTo(before, 3);
    expect(src[0].length).toBe(channels[0].length);                          // nothing trimmed or padded
  });

  it('brings a too-loud episode down as well', () => {
    const { channels } = fixForPodcast(narration({ speechDb: -9, noiseDb: -70, spikeDb: -0.5 }), SR);
    expect(Math.abs(measureIntegratedLoudness(asBuf(channels)) - PODCAST.lufs)).toBeLessThanOrEqual(0.5);
  });

  it('mixes to mono on request and honours another target', () => {
    const { channels, report } = fixForPodcast([narration({ seed: 5 })[0], narration({ seed: 6 })[0]], SR, { mono: true, targetLufs: -19 });
    expect(channels.length).toBe(1);
    expect(Math.abs(report.afterLufs + 19)).toBeLessThanOrEqual(0.5);
  });

  it('does nothing harmful to silence, and says when a target cannot be reached', () => {
    const silent = fixForPodcast([new Float32Array(SR * 3)], SR);
    expect(silent.report.steps[0]).toMatch(/silent/);
    expect(silent.channels[0].every((v) => v === 0)).toBe(true);
    const hot = fixForPodcast(narration({ speechDb: -40, noiseDb: -70 }), SR, { targetLufs: -6, ceilingDb: -6 });
    expect(hot.report.reached).toBe(false);
    expect(hot.report.steps.join(' ')).toMatch(/could not reach/);
    expect(hot.report.peakDb).toBeLessThanOrEqual(-6 + 0.01);
  });
});
