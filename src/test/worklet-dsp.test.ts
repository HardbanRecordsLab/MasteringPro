/**
 * Worklet DSP harness — runs the *actual* AudioWorklet processor source from
 * `public/worklets/` inside Node with a minimal shim, so the block-based DSP is
 * regression-tested in CI (jsdom has no AudioWorklet / OfflineAudioContext).
 *
 * Two guarantees this file locks down:
 *  1. Null / bypass — a neutrally-configured processor is transparent.
 *  2. Contract — the limiter never lets the true peak past its ceiling; the
 *     multiband crossovers reconstruct flat; bass-mono monos only the lows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureTruePeak } from '@/lib/loudness';

const SR = 48000;
const BLOCK = 128;

function fakeBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    sampleRate: SR,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / SR,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

/** Load one worklet file and return its registered processor class. */
function loadWorklet(file: string, sr = SR): any {
  const src = readFileSync(join(process.cwd(), 'public', 'worklets', file), 'utf8');
  let Cls: any = null;
  const AudioWorkletProcessorShim = class {
    port = { postMessage: () => {}, onmessage: null as unknown };
  };
  const registerProcessor = (_name: string, c: any) => { Cls = c; };
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(
    AudioWorkletProcessorShim,
    registerProcessor,
    sr,
  );
  if (!Cls) throw new Error(`no processor registered by ${file}`);
  return Cls;
}

/** Run a processor over a stereo signal, block by block. */
function run(
  Cls: any,
  processorOptions: Record<string, unknown>,
  L: Float32Array,
  R: Float32Array,
  paramOverrides: Record<string, number> = {},
): [Float32Array, Float32Array] {
  const proc = new Cls({ processorOptions });
  const params: Record<string, Float32Array> = {};
  const descs = Cls.parameterDescriptors || [];
  for (const d of descs) params[d.name] = new Float32Array([d.defaultValue]);
  for (const [k, v] of Object.entries(paramOverrides)) params[k] = new Float32Array([v]);

  const n = L.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let off = 0; off + BLOCK <= n; off += BLOCK) {
    const inL = L.subarray(off, off + BLOCK);
    const inR = R.subarray(off, off + BLOCK);
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    proc.process([[inL, inR]], [[oL, oR]], params);
    outL.set(oL, off);
    outR.set(oR, off);
  }
  return [outL, outR];
}

function sine(freq: number, ampDb: number, seconds: number, phase = 0): Float32Array {
  const n = Math.floor(SR * seconds);
  const a = Math.pow(10, ampDb / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
}

/** RMS in dBFS over the settled tail (skip the filter warm-up). */
function tailRmsDb(x: Float32Array, skip = SR / 2): number {
  let sq = 0;
  let c = 0;
  for (let i = skip; i < x.length; i++) { sq += x[i] * x[i]; c++; }
  return 10 * Math.log10(sq / c);
}

describe('worklet — multiband compressor', () => {
  const Cls = loadWorklet('multiband-comp-processor.js');

  it('is transparent when every band is 1:1', () => {
    const flat = { threshold: 0, ratio: 1, attack: 5, release: 100, knee: 0, makeup: 0 };
    const opts = { xover1: 120, xover2: 2500, bands: [flat, flat, flat] };
    for (const f of [60, 500, 6000]) {
      const s = sine(f, -12, 2);
      const [outL] = run(Cls, opts, s, s.slice());
      // crossovers reconstruct flat → tail RMS unchanged within 0.2 dB
      expect(Math.abs(tailRmsDb(outL) - tailRmsDb(s))).toBeLessThan(0.2);
    }
  });

  it('reduces level when a band is driven past threshold', () => {
    const hit = { threshold: -30, ratio: 4, attack: 5, release: 80, knee: 0, makeup: 0 };
    const flat = { threshold: 0, ratio: 1, attack: 5, release: 100, knee: 0, makeup: 0 };
    const opts = { xover1: 120, xover2: 2500, bands: [flat, hit, flat] };
    const s = sine(800, -12, 2); // sits in the mid band, ~18 dB over threshold
    const [outL] = run(Cls, opts, s, s.slice());
    expect(tailRmsDb(s) - tailRmsDb(outL)).toBeGreaterThan(6);
  });
});

describe('worklet — lookahead limiter', () => {
  const Cls = loadWorklet('lookahead-limiter-processor.js');

  it('holds the true peak at or below the ceiling on a hot signal', () => {
    const hot = sine(1000, 6, 2); // +6 dBFS — way over
    const [outL, outR] = run(Cls, {}, hot, hot.slice(), { ceiling: -1, margin: 0.3, release: 50 });
    const { truePeak } = measureTruePeak(fakeBuffer([outL, outR]));
    expect(truePeak).toBeLessThanOrEqual(-1 + 0.3); // ceiling + reconstruction tolerance
  });

  it('is transparent on a signal already below the ceiling', () => {
    const quiet = sine(1000, -12, 2);
    const [outL] = run(Cls, {}, quiet, quiet.slice(), { ceiling: -1, margin: 0.3, release: 50 });
    expect(Math.abs(tailRmsDb(outL) - tailRmsDb(quiet))).toBeLessThan(0.15);
  });

  it('passes audio through unchanged when bypassed', () => {
    const s = sine(1000, 3, 1);
    const [outL] = run(Cls, {}, s, s.slice(), { bypass: 1 });
    // account for the filter/lookahead latency: compare settled RMS
    expect(Math.abs(tailRmsDb(outL) - tailRmsDb(s))).toBeLessThan(0.05);
  });
});

describe('worklet — bass mono-maker', () => {
  const Cls = loadWorklet('bass-mono-processor.js');

  it('sums the lows to mono but leaves the highs stereo', () => {
    // anti-phase L/R: a mono-maker collapses it well below the crossover
    const low = sine(40, -12, 2);
    const [loL, loR] = run(Cls, { freq: 250 }, low, low.map((v) => -v));
    // 2.6 octaves under the 250 Hz split → the high-pass leak is tiny
    let diff = 0;
    for (let i = SR; i < loL.length; i++) diff += Math.abs(loL[i] - loR[i]);
    expect(diff / (loL.length - SR)).toBeLessThan(0.02);

    const high = sine(5000, -12, 2);
    const [hiL, hiR] = run(Cls, { freq: 250 }, high, high.map((v) => -v));
    let hdiff = 0;
    for (let i = SR; i < hiL.length; i++) hdiff += Math.abs(hiL[i] - hiR[i]);
    expect(hdiff / (hiL.length - SR)).toBeGreaterThan(0.1); // still anti-phase up top
  });
});

describe('worklet — compressor', () => {
  const Cls = loadWorklet('compressor-processor.js');

  it('is transparent at 1:1', () => {
    const s = sine(1000, -6, 2);
    const [outL] = run(Cls, { threshold: -30, ratio: 1, makeup: 0, knee: 0 }, s, s.slice());
    expect(Math.abs(tailRmsDb(outL) - tailRmsDb(s))).toBeLessThan(0.05);
  });

  it('applies gain reduction above threshold', () => {
    const s = sine(1000, -6, 2); // 18 dB over a -24 threshold
    const [outL] = run(Cls, { threshold: -24, ratio: 4, makeup: 0, knee: 0, attack: 5, release: 80 }, s, s.slice());
    expect(tailRmsDb(s) - tailRmsDb(outL)).toBeGreaterThan(8);
  });
});
