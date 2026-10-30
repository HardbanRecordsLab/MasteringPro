/**
 * Bandwidth fill — measured on synthetic material whose truth is known: a tilted broadband signal with transients, brick-walled at a
 * chosen frequency (what a lossy encoder leaves). Every claim is a number: where the wall is found, what is added above it, that
 * nothing below it moves, that silence stays silent and that a file without a wall is left alone.
 */
import { describe, it, expect } from 'vitest';
import { detectBandLimit, fillBand } from '@/lib/dsp/bandfill';
import { restoreChannels, diagnose } from '@/lib/dsp/restore';
import { stftProcess } from '@/lib/dsp/stft';
import { FFT } from '@/lib/fft';

function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (n: number, seed: number) => { const r = prng(seed); const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); return o; };

/** tilted broadband "music-like" signal: −9 dB/octave above 1 kHz, hat-like bursts every 250 ms over a steady bed, rms ≈ 0.1 */
function material(seconds: number, sr: number, seed = 3, tilt = -1.5): Float32Array {
  const n = Math.round(seconds * sr);
  const shaped = stftProcess(gauss(n, seed), { size: 4096 }, (re, im) => {
    for (let k = 1; k < re.length / 2 + 1; k++) { const f = (k * sr) / 4096; const g = f > 1000 ? Math.pow(f / 1000, tilt) : 1; re[k] *= g; im[k] *= g; }
  });
  let e = 0;
  for (let i = 0; i < n; i++) { const t = i / sr; const env = 0.25 + 0.75 * Math.exp(-((t % 0.25)) * 18); shaped[i] *= env; e += shaped[i] * shaped[i]; }
  const g = 0.1 / Math.sqrt(e / n);
  for (let i = 0; i < n; i++) shaped[i] *= g;
  return shaped;
}

/** brick wall: everything above `hz` removed (≈ 40 Hz wide edge) */
function wall(x: Float32Array, sr: number, hz: number): Float32Array {
  return stftProcess(x, { size: 4096 }, (re, im) => { for (let k = Math.round((hz * 4096) / sr); k < re.length / 2 + 1; k++) { re[k] = 0; im[k] = 0; } });
}

/** mean level (dB) of the band [lo, hi] Hz from a Hann-windowed average spectrum */
function bandDb(x: Float32Array, sr: number, lo: number, hi: number, from = 0, to = x.length): number {
  const N = 4096, fft = new FFT(N), re = new Float64Array(N), im = new Float64Array(N);
  let acc = 0, cnt = 0;
  const k0 = Math.round((lo * N) / sr), k1 = Math.round((hi * N) / sr);
  for (let s = from; s + N <= to; s += N / 2) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
    fft.transform(re, im);
    for (let k = k0; k <= k1; k++) { acc += (re[k] * re[k] + im[k] * im[k]) / (N * N); cnt++; }
  }
  return 10 * Math.log10(acc / Math.max(1, cnt) + 1e-20);
}
const diff = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; };
const same = (a: Float32Array, b: Float32Array) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const rmsDb = (x: Float32Array) => { let e = 0; for (const v of x) e += v * v; return 10 * Math.log10(e / x.length + 1e-20); };

const SR = 44100;

describe('detectBandLimit', () => {
  it.each([12000, 16000, 19000])('finds a brick wall at %i Hz', (hz) => {
    const x = wall(material(10, SR), SR, hz);
    const d = detectBandLimit([x], SR);
    expect(d).not.toBeNull();
    expect(Math.abs(d!.cutoffHz - hz)).toBeLessThanOrEqual(150);
    expect(d!.dropDb).toBeGreaterThan(40);
    expect(d!.slopeDbPerOct).toBeGreaterThan(-12);
    expect(d!.slopeDbPerOct).toBeLessThan(-6);                       // the material tilts −9 dB/oct
  });

  it('finds it at other sample rates and in a stereo file', () => {
    expect(Math.abs(detectBandLimit([wall(material(10, 48000), 48000, 16000)], 48000)!.cutoffHz - 16000)).toBeLessThanOrEqual(150);
    expect(Math.abs(detectBandLimit([wall(material(10, 96000), 96000, 16000)], 96000)!.cutoffHz - 16000)).toBeLessThanOrEqual(150);
    const l = wall(material(10, SR, 3), SR, 16000), r = wall(material(10, SR, 4), SR, 16000);
    expect(Math.abs(detectBandLimit([l, r], SR)!.cutoffHz - 16000)).toBeLessThanOrEqual(150);
  });

  it('leaves alone what is not band-limited', () => {
    expect(detectBandLimit([material(10, SR)], SR)).toBeNull();                                            // full band, tilted
    expect(detectBandLimit([gauss(SR * 10, 5).map((v) => v * 0.1)], SR)).toBeNull();                      // white noise
    const dark = new Float32Array(SR * 10); const w = gauss(SR * 10, 6); let y = 0;
    for (let i = 0; i < dark.length; i++) { y = 0.35 * w[i] + 0.65 * y; dark[i] = y * 0.1; }               // gentle one-pole low-pass: a dark mix, not a wall
    expect(detectBandLimit([dark], SR)).toBeNull();
    expect(detectBandLimit([new Float32Array(SR * 10)], SR)).toBeNull();                                  // silence
    expect(detectBandLimit([material(0.05, SR)], SR)).toBeNull();                                         // too short
    expect(detectBandLimit([], SR)).toBeNull();
  });

  it('ignores a wall too high to matter (above 20 kHz)', () => {
    expect(detectBandLimit([wall(material(10, 48000), 48000, 21500)], 48000)).toBeNull();
  });
});

describe('fillBand', () => {
  const cutoff = 16000;
  const src = material(10, SR);
  const x = wall(src, SR, cutoff);
  const det = detectBandLimit([x], SR)!;
  const { output: y, report } = fillBand(x, SR, { cutoffHz: det.cutoffHz, slopeDbPerOct: det.slopeDbPerOct });

  it('adds a top end where there was nothing', () => {
    expect(bandDb(x, SR, 17000, 19000)).toBeLessThan(-110);
    expect(bandDb(y, SR, 17000, 19000)).toBeGreaterThan(bandDb(x, SR, 13500, 15500) - 25);
    expect(report.filledToHz).toBeGreaterThanOrEqual(19000);
  });

  it('continues the spectrum: the level matches the trend of the part just below (±3 dB), at 60 % strength', () => {
    const base = bandDb(x, SR, 13500, 15500);
    const refHz = Math.sqrt(13500 * 15500);
    for (const [lo, hi] of [[16800, 17300], [17300, 17800], [17800, 18300]]) {            // below the run-out that starts 1.5 kHz under the 20 kHz target
      const mid = Math.sqrt(lo * hi);
      const expected = base + det.slopeDbPerOct * Math.log2(mid / refHz) + 20 * Math.log10(0.6);
      expect(Math.abs(bandDb(y, SR, lo, hi) - expected)).toBeLessThan(3);
    }
  });

  it('does not touch anything below the cutoff (the fill is added, the original passes through)', () => {
    const d = diff(y, x);
    expect(bandDb(d, SR, 100, 15400) - bandDb(x, SR, 100, 15400)).toBeLessThan(-70);
  });

  it('has no step at the edge and stays within what it continues', () => {
    const step = bandDb(y, SR, 16700, 17000) - bandDb(y, SR, 15000, 15300);
    expect(Math.abs(step)).toBeLessThan(12);
    expect(bandDb(y, SR, 16700, 17000)).toBeLessThan(bandDb(x, SR, 15000, 15300));        // never louder than the band it continues
  });

  it('follows the transients of the band below (hat bursts stay hat bursts)', () => {
    const win = Math.round(SR * 0.01), n = Math.floor(y.length / win);
    const env = (sig: Float32Array, lo: number, hi: number) => { const o: number[] = []; for (let i = 6; i < n - 6; i += 3) o.push(bandDb(sig, SR, lo, hi, i * win - 2048, i * win + 2048)); return o; };
    const a = env(y, 17000, 19000), b = env(x, 12000, 14000);
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    expect(sab / Math.sqrt(saa * sbb)).toBeGreaterThan(0.8);
  });

  it('is noise-like: no tones in the filled band', () => {
    const N = 4096, fft = new FFT(N), re = new Float64Array(N), im = new Float64Array(N);
    const acc = new Float64Array(N / 2);
    let frames = 0;
    for (let s = 0; s + N <= y.length; s += N / 2) {
      for (let i = 0; i < N; i++) { re[i] = y[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
      fft.transform(re, im);
      for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
      frames++;
    }
    const k0 = Math.round((17200 * N) / SR), k1 = Math.round((18800 * N) / SR);
    const db = (k: number) => 10 * Math.log10(acc[k] / frames + 1e-30) - det.slopeDbPerOct * Math.log2((k * SR) / N / 17000);
    const vals: number[] = []; for (let k = k0; k <= k1; k++) vals.push(db(k));
    const sorted = [...vals].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1] - sorted[Math.floor(sorted.length / 2)]).toBeLessThan(5);       // strongest bin vs median, after removing the tilt
  });

  it('keeps level and peaks essentially where they were', () => {
    expect(rmsDb(y) - rmsDb(x)).toBeLessThan(0.3);
    let px = 0, py = 0;
    for (let i = 0; i < x.length; i++) { px = Math.max(px, Math.abs(x[i])); py = Math.max(py, Math.abs(y[i])); }
    expect(20 * Math.log10(py / px)).toBeLessThan(1);
  });

  it('keeps silence silent and does not hiss in the gaps', () => {
    const gap = new Float32Array(SR * 6);
    gap.set(x.subarray(0, SR * 2), 0);
    gap.set(x.subarray(0, SR * 2), SR * 4);
    const out = fillBand(gap, SR, { cutoffHz: 16000, slopeDbPerOct: -9 }).output;
    let worst = 0;
    for (let i = Math.round(SR * 2.3); i < Math.round(SR * 3.7); i++) worst = Math.max(worst, Math.abs(out[i]));
    expect(20 * Math.log10(worst + 1e-12)).toBeLessThan(-110);
  });

  it('is deterministic, and different seeds give different noise', () => {
    const again = fillBand(x, SR, { cutoffHz: det.cutoffHz, slopeDbPerOct: det.slopeDbPerOct }).output;
    expect(same(again, y)).toBe(true);
    const other = fillBand(x, SR, { cutoffHz: det.cutoffHz, slopeDbPerOct: det.slopeDbPerOct, seed: 2 }).output;
    expect(rmsDb(diff(other, y))).toBeGreaterThan(rmsDb(diff(y, x)) - 6);
  });

  it('is a no-op at amount 0 and when there is no room above the cutoff', () => {
    expect(same(fillBand(x, SR, { cutoffHz: 16000, amount: 0 }).output, x)).toBe(true);
    expect(same(fillBand(x, SR, { cutoffHz: 19900, targetHz: 20000 }).output, x)).toBe(true);
  });

  it('scales with the amount (0.3 sits 6 dB under 0.6)', () => {
    const lo = fillBand(x, SR, { cutoffHz: det.cutoffHz, slopeDbPerOct: det.slopeDbPerOct, amount: 0.3 }).output;
    expect(Math.abs(bandDb(y, SR, 17500, 18500) - bandDb(lo, SR, 17500, 18500) - 6.02)).toBeLessThan(1);
  });

  it('stops at 20 kHz on a 96 kHz file and adds nothing in the ultrasonic range', () => {
    const x96 = wall(material(8, 96000), 96000, 16000);
    const d96 = detectBandLimit([x96], 96000)!;
    const out = fillBand(x96, 96000, { cutoffHz: d96.cutoffHz, slopeDbPerOct: d96.slopeDbPerOct }).output;
    expect(bandDb(out, 96000, 17000, 19000)).toBeGreaterThan(-90);
    expect(bandDb(out, 96000, 22000, 40000)).toBeLessThan(-115);
  });

  it('gives the two channels of a stereo file different noise (air, not a mono smear) and identical content below the wall', () => {
    const lx = wall(material(10, SR, 3), SR, cutoff), rx = wall(material(10, SR, 4), SR, cutoff);
    const r = restoreChannels([lx, rx], SR, { bandfill: { enabled: true } });
    const fl = diff(r.channels[0], lx), fr = diff(r.channels[1], rx);
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < fl.length; i++) { sab += fl[i] * fr[i]; saa += fl[i] ** 2; sbb += fr[i] ** 2; }
    expect(Math.abs(sab / Math.sqrt(saa * sbb))).toBeLessThan(0.1);
    expect(r.report.bandfill).not.toBeNull();
    expect(Math.abs((r.report.bandfill?.cutoffHz ?? 0) - cutoff)).toBeLessThanOrEqual(150);
  });
});

describe('in the restoration pipeline', () => {
  it('diagnose reports the wall, and a file without one gets no fill and an unchanged signal', () => {
    const walled = wall(material(10, SR), SR, 16000);
    expect(Math.abs((diagnose([walled], SR).bandLimit?.cutoffHz ?? 0) - 16000)).toBeLessThanOrEqual(150);
    const open = material(10, SR);
    expect(diagnose([open], SR).bandLimit).toBeNull();
    const r = restoreChannels([open], SR, { bandfill: { enabled: true } });
    expect(r.report.bandfill).toBeNull();
    expect(Array.from(r.channels[0].subarray(1000, 1100))).toEqual(Array.from(open.subarray(1000, 1100)));
  });
});
