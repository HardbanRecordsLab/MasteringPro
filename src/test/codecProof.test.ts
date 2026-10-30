import { describe, it, expect } from 'vitest';
import { codecProofMaster, loudestRanges } from '@/lib/codecProof';
import { reportCodecProof, type MasterReport } from '@/lib/audioExport';
import type { CodecResult } from '@/lib/delivery';
import { measureTruePeak } from '@/lib/loudness';
import { fakeBuffer, noise, tone, SR } from './harness';

const gainDb = (db: number) => Math.pow(10, db / 20);
const scaled = (b: AudioBuffer, g: number) => fakeBuffer(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).map((v) => v * g)), b.sampleRate);
const tpOf = (b: AudioBuffer) => measureTruePeak(b).truePeak;

function masterAt(db: number) {
  const hiss = noise(2, 0.05, 3);
  const mix = tone(440, -6, 2).map((v, i) => v + hiss[i]);
  const g = gainDb(db - tpOf(fakeBuffer([mix, mix])));
  return fakeBuffer([mix.map((v) => v * g), mix.map((v) => v * g)]);
}

const CODEC = (id: string, label: string, over: number | null) =>
  (b: AudioBuffer): CodecResult => ({ id: id as CodecResult['id'], label, platforms: '', available: over !== null, truePeak: over === null ? null : tpOf(b) + over });

/** codecs with a known, level-proportional overshoot (what the real ones add, measured: MP3 up to +0.95 dB) */
const measureWith = (specs: Array<[string, string, number | null]>) => async (b: AudioBuffer) => specs.map(([id, label, over]) => CODEC(id, label, over)(b));

describe('loudestRanges', () => {
  const sr = 1000;
  const make = (n: number, loud: Array<[number, number]>, spikeAt?: number) => {
    const x = new Float32Array(n).fill(0.01);
    for (const [a, b] of loud) for (let i = a; i < b; i++) x[i] = 0.5;
    if (spikeAt !== undefined) x[spikeAt] = 0.99;
    return x;
  };

  it('returns the loud passages and the one with the highest peak, without overlap, in time order', () => {
    const x = make(60 * sr, [[20 * sr, 27 * sr], [45 * sr, 51 * sr]], 8 * sr);        // loud at 20-27 s and 45-51 s, a lone spike at 8 s
    const r = loudestRanges([x], sr, 6, 3);
    expect(r.length).toBe(3);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThanOrEqual(r[i - 1][1]);   // no overlap
    for (const [s, e] of r) { expect(s).toBeGreaterThanOrEqual(0); expect(e).toBeLessThanOrEqual(x.length); expect(e - s).toBe(6 * sr); }
    expect(r.some(([s, e]) => s <= 8 * sr && e > 8 * sr)).toBe(true);                   // the spike window
    expect(r.some(([s, e]) => s < 27 * sr && e > 20 * sr)).toBe(true);                   // a loud passage
    expect(r.some(([s, e]) => s < 51 * sr && e > 45 * sr)).toBe(true);
  });

  it('a short file is measured whole, an empty one gives nothing', () => {
    expect(loudestRanges([new Float32Array(3 * sr).fill(0.2)], sr, 6, 3)).toEqual([[0, 3 * sr]]);
    expect(loudestRanges([new Float32Array(0)], sr)).toEqual([]);
  });

  it('never asks for more windows than fit', () => {
    const r = loudestRanges([new Float32Array(10 * sr).fill(0.3)], sr, 6, 3);
    expect(r.length).toBeLessThanOrEqual(2);
  });
});

describe('codecProofMaster', () => {
  it('takes the worst codec overshoot off the master, until every codec is under the ceiling', async () => {
    const measure = measureWith([['aac-256', 'AAC 256 kbps', 0.3], ['opus-160', 'Opus 160 kbps', 0.5], ['mp3-320', 'MP3 320 kbps', 0.7]]);
    const r = await codecProofMaster(masterAt(-1.0), -1.0, { measure, scale: scaled });
    expect(r.verified).toBe(true);
    expect(r.worst!.id).toBe('mp3-320');
    expect(r.worst!.truePeakDb).toBeLessThanOrEqual(-1.0);
    expect(r.trimDb).toBeGreaterThan(0.75);                       // the worst codec's 0.7 dB + the 0.1 dB margin ...
    expect(r.trimDb).toBeLessThan(0.9);                           // ... and not much more
    expect(r.passes).toBe(2);
    expect(r.codecs.map((c) => c.id)).toEqual(['aac-256', 'opus-160', 'mp3-320']);
  });

  it('leaves a master alone when every codec already fits', async () => {
    const measure = measureWith([['opus-160', 'Opus 160 kbps', 0.4], ['mp3-320', 'MP3 320 kbps', 0.5]]);
    const m = masterAt(-2.0);
    const r = await codecProofMaster(m, -1.0, { measure, scale: scaled });
    expect(r).toMatchObject({ verified: true, trimDb: 0, passes: 1 });
    expect(r.buffer).toBe(m);                                     // the very same buffer: no copy, no level change
  });

  it('ignores a codec this browser cannot run, and says nothing was checked when none can', async () => {
    const some = await codecProofMaster(masterAt(-1.0), -1.0, { measure: measureWith([['aac-256', 'AAC 256 kbps', null], ['mp3-320', 'MP3 320 kbps', 0.4]]), scale: scaled });
    expect(some.verified).toBe(true);
    expect(some.worst!.id).toBe('mp3-320');
    expect(some.codecs.find((c) => c.id === 'aac-256')!.truePeakDb).toBeNull();

    const m = masterAt(-1.0);
    const none = await codecProofMaster(m, -1.0, { measure: measureWith([['aac-256', 'AAC 256 kbps', null], ['mp3-320', 'MP3 320 kbps', null]]), scale: scaled });
    expect(none).toMatchObject({ verified: false, trimDb: 0, worst: null });
    expect(none.buffer).toBe(m);
  });

  it('stops after maxPasses and reports that it is still over', async () => {
    let calls = 0;
    const measure = async () => { calls++; return [{ id: 'mp3-320', label: 'MP3 320 kbps', platforms: '', available: true, truePeak: -0.4 } as CodecResult]; };
    const r = await codecProofMaster(masterAt(-1.0), -1.0, { measure, scale: scaled });
    expect(r.verified).toBe(false);
    expect(r.passes).toBe(3);
    expect(calls).toBe(3);
  });

  it('converges within two passes for the overshoots measured in the real encoders, at every ceiling the UI offers', async () => {
    for (const ceiling of [-0.1, -0.3, -1.0, -2.0]) {
      for (const over of [0.15, 0.63, 0.95]) {
        const r = await codecProofMaster(masterAt(ceiling), ceiling, { measure: measureWith([['mp3-320', 'MP3 320 kbps', over]]), scale: scaled });
        expect(r.verified, `${ceiling} dBTP, +${over} dB`).toBe(true);
        expect(r.passes).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('reportCodecProof', () => {
  const base: MasterReport = { integratedLufs: -14.0, truePeakDb: -1.0, targetLufs: -14, targetPeakDb: -1, driveDb: 2, iterations: 3, onTarget: true };

  it('shows the cost in loudness and peak, and which codec drove it', () => {
    const proof = { buffer: masterAt(-1.0), trimDb: 0.7, passes: 2, verified: true, ceilingDb: -1.0,
      codecs: [{ id: 'mp3-320', label: 'MP3 320 kbps', truePeakDb: -1.05 }], worst: { id: 'mp3-320', label: 'MP3 320 kbps', truePeakDb: -1.05 } };
    const r = reportCodecProof(base, proof);
    expect(r.integratedLufs).toBe(-14.7);
    expect(r.truePeakDb).toBe(-1.7);
    expect(r.onTarget).toBe(false);
    expect(r.note).toMatch(/0\.70 dB taken off so MP3 320 kbps stays under -1\.0 dBTP/);
    expect(r.codecProof).toMatchObject({ trimDb: 0.7, verified: true, ceilingDb: -1 });
  });

  it('leaves the report untouched when no codec could be run', () => {
    const proof = { buffer: masterAt(-1.0), trimDb: 0, passes: 1, verified: false, ceilingDb: -1.0, codecs: [], worst: null };
    expect(reportCodecProof(base, proof)).toBe(base);
    expect(SR).toBe(48000);
  });
});
