import { describe, it, expect } from 'vitest';
import { measureLoudness, measureTruePeak } from '@/lib/loudness';
import { FFT, hann } from '@/lib/fft';
import { analyzeSpectrum } from '@/lib/spectrum';
import { limiterLatencySamples } from '@/lib/limiterConfig';
import { computeDynamicsMetrics } from '@/lib/dynamicsMetrics';
import { makeSaturationCurve } from '@/lib/saturationCurve';

/** Minimal AudioBuffer stand-in for the pure DSP functions. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    sampleRate,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

function sine(freq: number, ampDb: number, sr: number, seconds: number): Float32Array {
  const n = Math.floor(sr * seconds);
  const a = Math.pow(10, ampDb / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

const SR = 48000;

describe('BS.1770-4 loudness', () => {
  it('measures a -23 dBFS 1 kHz sine at ~-23 LUFS (EBU Tech 3341 case 1)', () => {
    const s = sine(1000, -23, SR, 4);
    const r = measureLoudness(fakeBuffer([s, s.slice()], SR));
    expect(r.integrated).toBeGreaterThan(-23.7);
    expect(r.integrated).toBeLessThan(-22.3);
  });

  it('tracks a 3 dB level change to within 0.3 LU', () => {
    const a = sine(1000, -23, SR, 4);
    const b = sine(1000, -20, SR, 4);
    const la = measureLoudness(fakeBuffer([a, a.slice()], SR)).integrated;
    const lb = measureLoudness(fakeBuffer([b, b.slice()], SR)).integrated;
    expect(lb - la).toBeGreaterThan(2.7);
    expect(lb - la).toBeLessThan(3.3);
  });

  it('reports LRA near zero for a steady tone', () => {
    const s = sine(1000, -20, SR, 6);
    const r = measureLoudness(fakeBuffer([s, s.slice()], SR));
    expect(r.lra).toBeLessThan(1.0);
  });
});

describe('true peak', () => {
  it('sample peak ~= 0 dBFS, true peak >= sample peak for a hot tone', () => {
    const s = sine(SR * 0.201, 0, SR, 1);
    const { truePeak, samplePeak } = measureTruePeak(fakeBuffer([s, s.slice()], SR));
    expect(samplePeak).toBeLessThan(0.2);
    expect(truePeak).toBeGreaterThanOrEqual(samplePeak - 0.05);
    expect(truePeak).toBeLessThan(1.5);
  });

  it('recovers the ~3 dB inter-sample peak of an fs/4 +45° tone', () => {
    // sample peaks land at −3 dBFS, the reconstructed peak is near full scale
    const n = SR;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = 0.998 * Math.sin((2 * Math.PI * (SR / 4) * i) / SR + Math.PI / 4);
    const { truePeak, samplePeak } = measureTruePeak(fakeBuffer([d, d.slice()], SR));
    expect(samplePeak).toBeLessThan(-2.7);
    expect(truePeak).toBeGreaterThan(-0.3);
    expect(truePeak).toBeLessThan(0.1);
  });
});

describe('FFT', () => {
  it('transforms a unit impulse to a flat spectrum', () => {
    const fft = new FFT(16);
    const frame = new Float64Array(16);
    frame[0] = 1;
    const mag = fft.magnitude(frame);
    for (const m of mag) expect(m).toBeCloseTo(1, 5);
  });

  it('puts a sine on the right bin', () => {
    const N = 1024;
    const fft = new FFT(N);
    const w = hann(N);
    const frame = new Float64Array(N);
    for (let i = 0; i < N; i++) frame[i] = Math.sin((2 * Math.PI * 64 * i) / N) * w[i];
    const mag = fft.magnitude(frame);
    let peakBin = 0;
    for (let k = 1; k < mag.length; k++) if (mag[k] > mag[peakBin]) peakBin = k;
    expect(peakBin).toBe(64);
  });
});

describe('spectrum calibration', () => {
  it('reads a full-scale 1 kHz sine near 0 dBFS in its 1/3-octave band', () => {
    const s = sine(1000, 0, SR, 2);
    const spec = analyzeSpectrum(fakeBuffer([s, s.slice()], SR), 8192);
    const bandIdx = spec.thirdOctaveCenters.findIndex((f) => f === 1000);
    expect(bandIdx).toBeGreaterThanOrEqual(0);
    // A full-scale sine lands within a few dB of 0 dBFS in its band (summed
    // band power; exact value depends on window lobe capture).
    expect(spec.thirdOctaveDb[bandIdx]).toBeGreaterThan(-3);
    expect(spec.thirdOctaveDb[bandIdx]).toBeLessThan(3);
    // neighbouring bands are far lower — the tone is localised
    expect(spec.thirdOctaveDb[bandIdx] - spec.thirdOctaveDb[bandIdx - 4]).toBeGreaterThan(20);
  });
});

describe('limiter latency', () => {
  it('is positive and ~5 ms at 48 kHz', () => {
    const lat = limiterLatencySamples(48000);
    expect(lat).toBeGreaterThan(200);
    expect(lat).toBeLessThan(320);
  });
});

describe('dynamics metrics', () => {
  it('TT DR: low for a steady sine, high when peaks stick out above RMS', () => {
    const steady = sine(1000, -0.5, SR, 12);
    const bS = fakeBuffer([steady, steady.slice()], SR);
    expect(computeDynamicsMetrics(bS, measureLoudness(bS)).dr).toBeLessThanOrEqual(3);

    // low-level tone + periodic sharp spikes → high crest → high DR
    const n = SR * 12;
    const peaky = new Float32Array(n);
    for (let i = 0; i < n; i++) peaky[i] = 0.03 * Math.sin((2 * Math.PI * 300 * i) / SR);
    for (let i = 0; i < n; i += Math.round(SR * 0.5)) peaky[i] = 0.9;
    const bP = fakeBuffer([peaky, peaky.slice()], SR);
    expect(computeDynamicsMetrics(bP, measureLoudness(bP)).dr).toBeGreaterThan(12);
  });

  it('counts clip runs at full scale', () => {
    const s = new Float32Array(SR);
    for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / SR);
    for (let i = 1000; i < 1010; i++) s[i] = 1.0; // one 10-sample clip run
    const buf = fakeBuffer([s, s.slice()], SR);
    const d = computeDynamicsMetrics(buf, measureLoudness(buf));
    expect(d.clipEvents).toBe(2); // one per channel
    expect(d.clippedSamples).toBe(20);
  });
});

describe('saturation curves', () => {
  const mid = (c: Float32Array) => c[c.length / 2]; // x = 0

  it('is a clean pass-through at zero drive', () => {
    const c = makeSaturationCurve(0, 'tape');
    for (let i = 0; i < c.length; i += 97) {
      const x = (i * 2) / c.length - 1;
      expect(Math.abs(c[i] - x)).toBeLessThan(1e-6);
    }
  });

  it('is monotonic and bounded for every mode', () => {
    for (const m of ['tape', 'tube', 'transformer', 'clip'] as const) {
      const c = makeSaturationCurve(80, m);
      for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1] - 1e-7);
      for (let i = 0; i < c.length; i++) expect(Math.abs(c[i])).toBeLessThanOrEqual(1.05);
    }
  });

  it('tape stays symmetric, tube is asymmetric (2nd-harmonic bias)', () => {
    const tape = makeSaturationCurve(70, 'tape');
    const tube = makeSaturationCurve(70, 'tube');
    const at = (c: Float32Array, x: number) => c[Math.round(((x + 1) / 2) * (c.length - 1))];
    // odd symmetry: f(x) ≈ -f(-x)
    expect(Math.abs(at(tape, 0.6) + at(tape, -0.6))).toBeLessThan(0.02);
    expect(Math.abs(at(tube, 0.6) + at(tube, -0.6))).toBeGreaterThan(0.02);
    // near-zero the curve still passes signal ~unchanged
    expect(Math.abs(mid(tape))).toBeLessThan(0.01);
  });
});

describe('musical content — key detection', () => {
  it('detects C major from a sustained C-E-G triad', async () => {
    const { detectKey } = await import('@/lib/musicAnalysis');
    const n = SR * 3;
    const data = new Float32Array(n);
    for (const f of [261.63, 329.63, 392.0]) {
      for (let i = 0; i < n; i++) data[i] += 0.25 * Math.sin((2 * Math.PI * f * i) / SR);
    }
    const { key } = detectKey(fakeBuffer([data, data.slice()], SR));
    expect(key).toContain('C');
    expect(key).toContain('major');
  });
});

import { readSampleRate } from '@/lib/audioDecode';

describe('native-rate decoding — container header parsing', () => {
  const b = (...n: number[]) => Uint8Array.from(n);
  it('reads the rate of a WAV (any chunk order)', () => {
    const wav = new Uint8Array(64);
    wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    wav.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
    wav.set([...'LIST'].map((c) => c.charCodeAt(0)), 12); new DataView(wav.buffer).setUint32(16, 4, true); // a 4-byte chunk first
    wav.set([...'fmt '].map((c) => c.charCodeAt(0)), 24); new DataView(wav.buffer).setUint32(28, 16, true);
    new DataView(wav.buffer).setUint32(36, 96000, true);                                          // sample rate at fmt+4
    expect(readSampleRate(wav)).toBe(96000);
  });
  it('reads the rate of FLAC, MP3 and AIFF', () => {
    const flac = new Uint8Array(40); flac.set([0x66, 0x4c, 0x61, 0x43], 0);
    flac[18] = 0x0b; flac[19] = 0xb8; flac[20] = 0x00;                                             // 48000 = 0x0BB80, 20 bits
    expect(readSampleRate(flac)).toBe(48000);

    const mp3 = new Uint8Array(40); mp3.set([0xff, 0xfb, 0x90, 0x00], 0);                          // MPEG1 L3, 44.1 kHz
    expect(readSampleRate(mp3)).toBe(44100);
    const mp3b = new Uint8Array(40); mp3b.set([0xff, 0xfb, 0x94, 0x00], 0);                        // MPEG1 L3, 48 kHz
    expect(readSampleRate(mp3b)).toBe(48000);

    const aiff = new Uint8Array(64);
    aiff.set([...'FORM'].map((c) => c.charCodeAt(0)), 0); aiff.set([...'AIFF'].map((c) => c.charCodeAt(0)), 8);
    aiff.set([...'COMM'].map((c) => c.charCodeAt(0)), 12); new DataView(aiff.buffer).setUint32(16, 18, false);
    aiff.set([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0], 28);                                       // 44100 as 80-bit extended
    expect(readSampleRate(aiff)).toBe(44100);
  });
  it('returns null for unknown data', () => {
    expect(readSampleRate(new Uint8Array(100))).toBeNull();
    expect(readSampleRate(b(1, 2, 3))).toBeNull();
  });
});
