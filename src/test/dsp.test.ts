import { describe, it, expect } from 'vitest';
import { measureLoudness, measureTruePeak } from '@/lib/loudness';
import { FFT, hann } from '@/lib/fft';
import { analyzeSpectrum } from '@/lib/spectrum';
import { limiterLatencySamples } from '@/lib/limiterConfig';
import { computeDynamicsMetrics } from '@/lib/dynamicsMetrics';

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
    // 0 dBFS tone at an irrational fraction of SR → inter-sample peaks above samples
    const s = sine(SR * 0.201, 0, SR, 1);
    const { truePeak, samplePeak } = measureTruePeak(fakeBuffer([s, s.slice()], SR));
    expect(samplePeak).toBeLessThan(0.2);
    expect(truePeak).toBeGreaterThanOrEqual(samplePeak - 0.05);
    expect(truePeak).toBeLessThan(1.5);
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
