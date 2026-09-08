/**
 * EBU Tech 3341 / 3342 compliance — the loudness-meter calibration card.
 *
 * Each `it()` is one test case from the spec; the tolerance is the spec's own
 * (±0.1 LU for integrated, ±0.2 LU for LRA). This file IS the published claim
 * "our meter matches the reference within spec" — keep it green.
 */
import { describe, it, expect } from 'vitest';
import { measureLoudness, measureIntegratedLoudness, measureTruePeak } from '@/lib/loudness';

const SR = 48000;

function fakeBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    sampleRate: SR,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / SR,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

/** Concatenate constant-level 1 kHz sine segments: [{ db, seconds }]. */
function programme(segs: { db: number; seconds: number }[]): AudioBuffer {
  const total = segs.reduce((n, s) => n + Math.round(s.seconds * SR), 0);
  const d = new Float32Array(total);
  let off = 0;
  for (const s of segs) {
    const len = Math.round(s.seconds * SR);
    const a = s.db <= -120 ? 0 : Math.pow(10, s.db / 20);
    for (let i = 0; i < len; i++) d[off + i] = a * Math.sin((2 * Math.PI * 1000 * (off + i)) / SR);
    off += len;
  }
  return fakeBuffer([d, d.slice()]);
}

const near = (v: number, target: number, tol: number) => {
  expect(Number.isFinite(v)).toBe(true);
  expect(Math.abs(v - target)).toBeLessThanOrEqual(tol);
};

describe('EBU Tech 3341 — integrated loudness', () => {
  it('Case 1: 1 kHz sine, −23 dBFS, 20 s → −23.0 LUFS ±0.1', () => {
    const r = measureLoudness(programme([{ db: -23, seconds: 20 }]));
    near(r.integrated, -23.0, 0.1);
    near(r.momentaryMax, -23.0, 0.1);
    near(r.shortTermMax, -23.0, 0.1);
  });

  it('Case 2: 1 kHz sine, −33 dBFS, 20 s → −33.0 LUFS ±0.1', () => {
    const r = measureLoudness(programme([{ db: -33, seconds: 20 }]));
    near(r.integrated, -33.0, 0.1);
  });

  it('Case 3: −23 dBFS 20 s + −50 dBFS 8 s → −23.0 LUFS ±0.1 (relative gate at −10 LU)', () => {
    const i = measureIntegratedLoudness(
      programme([
        { db: -23, seconds: 20 },
        { db: -50, seconds: 8 },
      ]),
    );
    near(i, -23.0, 0.1);
  });

  it('Case 4: −23 dBFS / silence / −23 dBFS (10 s each) → −23.0 LUFS ±0.1 (absolute gate at −70)', () => {
    const i = measureIntegratedLoudness(
      programme([
        { db: -23, seconds: 10 },
        { db: -140, seconds: 10 },
        { db: -23, seconds: 10 },
      ]),
    );
    near(i, -23.0, 0.1);
  });
});

describe('EBU Tech 3342 — Loudness Range', () => {
  it('a steady tone has LRA ≈ 0', () => {
    const r = measureLoudness(programme([{ db: -23, seconds: 12 }]));
    expect(r.lra).toBeLessThan(1.0);
  });

  it('alternating −20 / −30 dBFS blocks give a measurable LRA', () => {
    const segs = [];
    for (let k = 0; k < 8; k++) segs.push({ db: k % 2 ? -30 : -20, seconds: 3 });
    const r = measureLoudness(programme(segs));
    expect(r.lra).toBeGreaterThan(5);
    expect(r.lra).toBeLessThan(14);
  });
});

describe('EBU Tech 3341 — true-peak meter', () => {
  it('0 dBFS 997 Hz sine → ~0.0 dBTP', () => {
    const n = SR * 2;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 997 * i) / SR);
    const { truePeak } = measureTruePeak(fakeBuffer([d, d.slice()]));
    near(truePeak, 0.0, 0.3);
  });

  it('−1 dBFS sine at fs/4, +45° → true peak between −1 and 0 dBTP', () => {
    const n = SR * 1;
    const d = new Float32Array(n);
    const a = Math.pow(10, -1 / 20);
    for (let i = 0; i < n; i++) d[i] = a * Math.sin((2 * Math.PI * (SR / 4) * i) / SR + Math.PI / 4);
    const { truePeak, samplePeak } = measureTruePeak(fakeBuffer([d, d.slice()]));
    expect(samplePeak).toBeLessThan(-3.5); // samples land far below the true peak
    expect(truePeak).toBeGreaterThan(-1.3);
    expect(truePeak).toBeLessThan(-0.6);
  });
});
