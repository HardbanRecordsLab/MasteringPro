import { describe, it, expect } from 'vitest';
import { analyzeProfile } from '@/lib/dsp/profile';
import {
  DEFAULT_ALBUM_SETTINGS, medianProfile, planTrack, brightnessOct, camelot, keyDistance, transitionCost,
  sequenceCost, suggestOrder, cueTime, buildCue, applyFadesToChannel, sanitizeFileName, type AlbumTrack,
} from '@/lib/album/plan';
import { fakeBuffer, noise, SR } from './harness';

function coloured(seed: number, lowpass: number, gain = 1, seconds = 5): Float32Array {
  const w = noise(seconds, 0.2, seed);
  const out = new Float32Array(w.length);
  let y = 0;
  const a = Math.exp((-2 * Math.PI * lowpass) / SR);
  for (let i = 0; i < w.length; i++) { y = (1 - a) * w[i] + a * y; out[i] = y * gain; }
  return out;
}

function track(id: string, lowpass: number, gain: number, extra: Partial<AlbumTrack> = {}): AlbumTrack {
  const x = coloured(id.charCodeAt(0) * 7, lowpass, gain);
  const buf = fakeBuffer([x, x]);
  const profile = analyzeProfile(buf);
  return { id, name: id, durationSec: x.length / SR, lufs: profile.lufs, lra: profile.lra, truePeakDb: profile.truePeakDb, profile, ...extra };
}

describe('album — tonal anchor and loudness plan', () => {
  const dark = track('a', 600, 4);
  const mid = track('b', 2500, 2.5);
  const bright = track('c', 9000, 1.5);
  const all = [dark, mid, bright];

  it('the median profile is the middle track where the others sit on either side', () => {
    const med = medianProfile(all);
    const i = med.freqs.findIndex((f) => f >= 5000);
    expect(med.midDb[i]).toBeCloseTo(mid.profile.midDb[i], 1);
    expect(med.lufs).toBeCloseTo(mid.lufs, 1);
  });

  it('pulls the dark track up and the bright track down toward the album, within the limit', () => {
    const settings = { ...DEFAULT_ALBUM_SETTINGS, toneStrength: 1, maxToneDb: 4 };
    const pd = planTrack(dark, all, settings);
    const pb = planTrack(bright, all, settings);
    const at = (p: ReturnType<typeof planTrack>, hz: number) => p.curve!.g[p.curve!.f.findIndex((f) => f >= hz)];
    expect(at(pd, 8000)).toBeGreaterThan(1);
    expect(at(pb, 8000)).toBeLessThan(-0.5);
    expect(Math.max(...pd.curve!.g)).toBeLessThanOrEqual(4.001);
    expect(Math.min(...pb.curve!.g)).toBeGreaterThanOrEqual(-4.001);
    expect(pd.toneAfterDb).toBeLessThan(pd.toneBeforeDb);
    expect(pb.toneAfterDb).toBeLessThan(pb.toneBeforeDb);
  });

  it('a lower strength corrects less; the anchor track is left alone', () => {
    const full = planTrack(dark, all, { ...DEFAULT_ALBUM_SETTINGS, toneStrength: 1 });
    const half = planTrack(dark, all, { ...DEFAULT_ALBUM_SETTINGS, toneStrength: 0.5 });
    expect(half.toneAfterDb).toBeGreaterThan(full.toneAfterDb);
    const anchored = planTrack(mid, all, { ...DEFAULT_ALBUM_SETTINGS, anchorId: 'b' });
    expect(anchored.curve).toBeNull();
    // with an explicit anchor the OTHER tracks move toward it
    const toAnchor = planTrack(dark, all, { ...DEFAULT_ALBUM_SETTINGS, anchorId: 'c', toneStrength: 1, maxToneDb: 6 });
    const i = toAnchor.curve!.f.findIndex((f) => f >= 8000);
    expect(toAnchor.curve!.g[i]).toBeGreaterThan(2);
  });

  it('loudness balance: 0 puts every track on the target, 1 keeps the original differences', () => {
    const equal = all.map((t) => planTrack(t, all, { ...DEFAULT_ALBUM_SETTINGS, loudnessBalance: 0, targetLufs: -14 }).targetLufs);
    expect(Math.max(...equal) - Math.min(...equal)).toBeCloseTo(0, 5);
    const kept = all.map((t) => planTrack(t, all, { ...DEFAULT_ALBUM_SETTINGS, loudnessBalance: 1, targetLufs: -14 }).targetLufs);
    const orig = all.map((t) => t.lufs);
    expect(kept[0] - kept[2]).toBeCloseTo(orig[0] - orig[2], 1);
  });
});

describe('album — sequencing', () => {
  const mk = (id: string, lufs: number, lowpass: number, key: string, bpm: number) =>
    track(id, lowpass, 2, { lufs, key, bpm });
  const pool = [
    mk('a', -18, 700, 'A minor', 90),
    mk('b', -15, 1500, 'C major', 100),
    mk('c', -12, 3000, 'G major', 112),
    mk('d', -9, 6000, 'D major', 124),
    mk('e', -7, 9000, 'A major', 130),
    mk('f', -13, 2200, 'E minor', 104),
  ];
  const shuffled = [pool[4], pool[0], pool[3], pool[1], pool[5], pool[2]];

  it('Camelot wheel distances', () => {
    expect(camelot('C major')).toEqual({ n: 8, minor: false });
    expect(camelot('A minor')).toEqual({ n: 8, minor: true });
    expect(keyDistance('C major', 'C major')).toBe(0);
    expect(keyDistance('C major', 'A minor')).toBe(1);       // relative minor
    expect(keyDistance('C major', 'G major')).toBe(1);       // fifth up
    expect(keyDistance('C major', 'F# major')).toBe(6);      // far side of the wheel
    expect(keyDistance('C major', '—')).toBeNull();
  });

  it('brighter material has a higher centroid; a track costs nothing next to itself', () => {
    expect(brightnessOct(pool[4].profile)).toBeGreaterThan(brightnessOct(pool[0].profile));
    expect(transitionCost(pool[2], pool[2])).toBe(0);
    expect(transitionCost(pool[0], pool[4])).toBeGreaterThan(transitionCost(pool[2], pool[3]));
  });

  it('"flow" returns every track once and is smoother than a random order', () => {
    const order = suggestOrder(shuffled, 'flow');
    expect(order.map((t) => t.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(sequenceCost(order)).toBeLessThan(sequenceCost(shuffled));
  });

  it('"rising" climbs and "arc" peaks late then relaxes', () => {
    const energy = (t: AlbumTrack) => t.lufs + 3 * brightnessOct(t.profile);
    const rising = suggestOrder(shuffled, 'rising').map(energy);
    for (let i = 1; i < rising.length; i++) expect(rising[i]).toBeGreaterThanOrEqual(rising[i - 1]);

    const arc = suggestOrder(shuffled, 'arc');
    const e = arc.map(energy);
    const peakAt = e.indexOf(Math.max(...e));
    expect(peakAt).toBeGreaterThanOrEqual(Math.floor(arc.length / 2));
    expect(peakAt).toBeLessThan(arc.length - 1);
    expect(e[0]).toBeLessThan(e[peakAt]);
  });

  it('keeps tiny albums as they are', () => {
    expect(suggestOrder(pool.slice(0, 2), 'flow').map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('album — CUE sheet, fades, names', () => {
  it('formats CD frame times', () => {
    expect(cueTime(0)).toBe('00:00:00');
    expect(cueTime(2)).toBe('00:02:00');
    expect(cueTime(61.5)).toBe('01:01:38');       // 0.5 s = 37.5 frames, rounded to 38
  });

  it('builds a CUE with a PREGAP only where there is a gap', () => {
    const cue = buildCue({ title: 'Album "X"', performer: 'Artist' }, [
      { title: 'One', file: '01 - One.wav', gapBeforeSec: 0 },
      { title: 'Two', file: '02 - Two.wav', gapBeforeSec: 2 },
      { title: 'Three', file: '03 - Three.wav', gapBeforeSec: 0 },
    ]);
    expect(cue).toContain('TITLE "Album \'X\'"');
    expect(cue).toContain('FILE "02 - Two.wav" WAVE');
    expect(cue.match(/PREGAP 00:02:00/g)).toHaveLength(1);
    expect(cue.match(/INDEX 01 00:00:00/g)).toHaveLength(3);
    expect(cue.indexOf('PREGAP')).toBeGreaterThan(cue.indexOf('TRACK 02'));
    expect(cue.indexOf('PREGAP')).toBeLessThan(cue.indexOf('TRACK 03'));
  });

  it('fades shape only the edges, with a smooth raised-cosine curve', () => {
    const x = new Float32Array(SR * 2).fill(1);
    applyFadesToChannel(x, SR, 100, 200);
    expect(x[0]).toBe(0);
    expect(x[Math.round(SR * 0.05)]).toBeCloseTo(0.5, 1);
    expect(x[Math.round(SR * 0.5)]).toBe(1);
    expect(x[x.length - 1]).toBe(0);
    expect(x[x.length - 1 - Math.round(SR * 0.1)]).toBeCloseTo(0.5, 1);
    for (let i = 1; i < 4800; i++) expect(x[i]).toBeGreaterThanOrEqual(x[i - 1]);       // monotonic fade-in
  });

  it('makes safe file names', () => {
    expect(sanitizeFileName('A/B: "Live"?.wav')).toBe('A_B_ _Live_');
    expect(sanitizeFileName('')).toBe('track');
  });
});
