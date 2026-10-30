import { describe, it, expect } from 'vitest';
import { encodeWithinCeiling, reportEncoded, FORMAT_MAP, type MasterReport } from '@/lib/audioExport';
import { measureTruePeak } from '@/lib/loudness';
import { fakeBuffer, noise, tone, SR } from './harness';

/**
 * The control loop that keeps a LOSSY file under the true-peak ceiling. The real MP3 encoder moved a −1.0 dBTP master to −0.37 dBTP
 * (256 kbps) when measured by decoding its output; the browser decoder is not available in Node, so the codec here is a stand-in
 * with a known, level-proportional overshoot - the loop is what is under test.
 */
const gainDb = (db: number) => Math.pow(10, db / 20);
const scaled = (b: AudioBuffer, g: number) => fakeBuffer(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).map((v) => v * g)), b.sampleRate);
const tpOf = (b: AudioBuffer) => measureTruePeak(b).truePeak;

function masterAt(db: number) {
  const hiss = noise(2, 0.05, 3);
  const mix = tone(440, -6, 2).map((v, i) => v + hiss[i]);
  const g = gainDb(db - tpOf(fakeBuffer([mix, mix])));
  return fakeBuffer([mix.map((v) => v * g), mix.map((v) => v * g)]);
}

/** a codec that adds `overshootDb` to whatever goes in (what the decoder returns = input x overshoot) */
function codec(overshootDb: number) {
  const store: AudioBuffer[] = [];
  const calls = { encode: 0 };
  return {
    calls,
    encode: (b: AudioBuffer) => { calls.encode++; store.push(b); return Uint8Array.of(store.length - 1); },
    decode: async (bytes: Uint8Array) => scaled(store[bytes[0]], gainDb(overshootDb)),
  };
}

describe('encodeWithinCeiling', () => {
  it('trims a master whose encode overshoots, until the DECODED file is under the ceiling', async () => {
    const c = codec(0.6);
    const r = await encodeWithinCeiling(masterAt(-1.0), -1.0, c.encode, c.decode, scaled);
    expect(r.verified).toBe(true);
    expect(r.truePeakDb!).toBeLessThanOrEqual(-1.0 + 0.02);
    expect(r.trimDb).toBeGreaterThan(0.55);                      // had to take the overshoot off ...
    expect(r.trimDb).toBeLessThan(0.8);                          // ... and not much more than that (overshoot + 0.1 dB margin)
    expect(r.passes).toBe(2);
    expect(c.calls.encode).toBe(2);
  });

  it('leaves a master alone when the encoded file already fits', async () => {
    const c = codec(0.6);
    const r = await encodeWithinCeiling(masterAt(-2.0), -1.0, c.encode, c.decode, scaled);
    expect(r).toMatchObject({ verified: true, trimDb: 0, passes: 1 });
    expect(r.truePeakDb!).toBeCloseTo(-1.4, 1);
    expect(c.calls.encode).toBe(1);                              // no second encode, no level change
  });

  it('honours a hot ceiling too (-0.1 dBTP) - the case where an encode would otherwise clip', async () => {
    const c = codec(0.4);
    const r = await encodeWithinCeiling(masterAt(-0.1), -0.1, c.encode, c.decode, scaled);
    expect(r.verified).toBe(true);
    expect(r.truePeakDb!).toBeLessThanOrEqual(-0.1 + 0.02);
  });

  it('delivers the file as encoded, flagged unverified, when the browser cannot decode it', async () => {
    const c = codec(0.6);
    const r = await encodeWithinCeiling(masterAt(-1.0), -1.0, c.encode, async () => { throw new Error('EncodingError'); }, scaled);
    expect(r).toMatchObject({ verified: false, truePeakDb: null, trimDb: 0, passes: 1 });
    expect(c.calls.encode).toBe(1);
  });

  it('gives up after maxPasses instead of looping forever, and says it is still over', async () => {
    const stuck = codec(0.6);
    const r = await encodeWithinCeiling(masterAt(-1.0), -1.0, stuck.encode,
      async (bytes) => scaled(masterAt(-0.5), 1), scaled);       // a decoder that always returns a file 0.5 dB over
    expect(r.verified).toBe(false);
    expect(r.passes).toBe(3);
    expect(stuck.calls.encode).toBe(3);
  });

  it('an MP3-sized overshoot at every ceiling the UI offers converges within 2 encodes', async () => {
    for (const ceiling of [-0.1, -0.5, -1.0, -2.0]) {
      for (const over of [0.15, 0.4, 0.63]) {
        const c = codec(over);
        const r = await encodeWithinCeiling(masterAt(ceiling), ceiling, c.encode, c.decode, scaled);
        expect(r.verified, `${ceiling} dBTP, +${over} dB`).toBe(true);
        expect(r.passes).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('reportEncoded', () => {
  const base: MasterReport = { integratedLufs: -14.0, truePeakDb: -1.0, targetLufs: -14, targetPeakDb: -1, driveDb: 2, iterations: 3, onTarget: true };
  const mp3 = FORMAT_MAP['mp3-256'];

  it('shows the decoded true peak and the loudness given up to the trim', () => {
    const r = reportEncoded(base, mp3, { data: new Uint8Array(1), truePeakDb: -1.04, trimDb: 0.7, passes: 2, verified: true });
    expect(r.truePeakDb).toBe(-1.0);
    expect(r.integratedLufs).toBe(-14.7);
    expect(r.onTarget).toBe(false);                              // 0.7 LU under the target now - the user is told, not left to find out
    expect(r.note).toMatch(/0\.70 dB taken off/);
    expect(r.encoded).toMatchObject({ format: 'mp3-256', verified: true, trimDb: 0.7 });
  });

  it('keeps the report untouched when nothing was checked', () => {
    expect(reportEncoded(base, mp3, undefined)).toBe(base);
    expect(reportEncoded(base, mp3, { data: new Uint8Array(1), truePeakDb: null, trimDb: 0, passes: 1, verified: false })).toBe(base);
  });

  it('a no-trim result still records what the decoded file measured', () => {
    const r = reportEncoded(base, mp3, { data: new Uint8Array(1), truePeakDb: -1.31, trimDb: 0, passes: 1, verified: true });
    expect(r.truePeakDb).toBe(-1.3);
    expect(r.integratedLufs).toBe(-14.0);
    expect(r.onTarget).toBe(true);
    expect(r.note).toBeUndefined();
    expect(SR).toBe(48000);
  });
});
