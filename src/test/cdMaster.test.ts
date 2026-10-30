import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  MAX_DISC_SECONDS, SAMPLE_RATE, SECTOR_BYTES, SECTOR_FRAMES, binParts, buildCueSheet, cdText, checkPlan, latin1, layoutDisc, layoutFrames,
  msf, normaliseIsrc, normaliseUpc, pcmFromChannels, pqList, trackStats, validateDisc, type CdDiscIn, type CdTrackIn,
} from '@/lib/cdMaster';

/** interleaved stereo ramp: left counts up from `start`, right is its negative, so a wrong byte order or channel swap shows at once */
function ramp(frames: number, start = 1): Int16Array {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { out[2 * i] = start + (i % 20000); out[2 * i + 1] = -(start + (i % 20000)); }
  return out;
}

const track = (title: string, frames: number, over: Partial<CdTrackIn> = {}): CdTrackIn =>
  ({ title, gapBeforeSec: 2, pcm: ramp(frames, 7), ...over });

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe('CD identifiers', () => {
  it('accepts a well-formed ISRC in any spelling and refuses the rest', () => {
    expect(normaliseIsrc('PL-ABC-26-00001')).toBe('PLABC2600001');
    expect(normaliseIsrc(' plabc2600001 ')).toBe('PLABC2600001');
    expect(normaliseIsrc('PLABC260000')).toBeNull();           // 11 characters
    expect(normaliseIsrc('PLABC26000012')).toBeNull();         // 13
    expect(normaliseIsrc('1LABC2600001')).toBeNull();          // country code is letters
    expect(normaliseIsrc('PLABC26A0001')).toBeNull();          // year + serial are digits
    expect(normaliseIsrc(undefined)).toBeNull();
  });

  it('checks the UPC/EAN check digit and returns the 13-digit form', () => {
    expect(normaliseUpc('036000291452')).toBe('0036000291452');     // the textbook UPC-A
    expect(normaliseUpc('4006381333931')).toBe('4006381333931');    // a real EAN-13
    expect(normaliseUpc('0 36000 29145 2')).toBe('0036000291452');
    expect(normaliseUpc('036000291453')).toBeNull();                // wrong check digit
    expect(normaliseUpc('4006381333932')).toBeNull();
    expect(normaliseUpc('12345')).toBeNull();
    expect(normaliseUpc('')).toBeNull();
  });
});

describe('CD layout', () => {
  it('writes minutes:seconds:frames at 75 frames a second', () => {
    expect(msf(0)).toBe('00:00:00');
    expect(msf(74)).toBe('00:00:74');
    expect(msf(75)).toBe('00:01:00');
    expect(msf(75 * 60 + 5)).toBe('01:00:05');
    expect(msf(75 * 60 * 74)).toBe('74:00:00');
  });

  it('starts every track on a sector, pads the last sector and stores the gap before INDEX 01', () => {
    const l = layoutFrames([SECTOR_FRAMES * 100 + 1, SECTOR_FRAMES * 10, SECTOR_FRAMES * 5], [0, 2, 0]);
    expect(l.tracks[0]).toMatchObject({ index00: null, index01: 0, sectors: 101 });         // 100 sectors and one frame → 101
    expect(l.tracks[1]).toMatchObject({ index00: 101, index01: 101 + 150, sectors: 10 });  // 2 s = 150 sectors of silence
    expect(l.tracks[2]).toMatchObject({ index00: null, index01: 101 + 150 + 10, sectors: 5 });
    expect(l.totalSectors).toBe(101 + 150 + 10 + 5);
  });

  it('ignores the gap of the first track (the burner adds the 2 s lead-in itself)', () => {
    const l = layoutFrames([SECTOR_FRAMES * 4], [9]);
    expect(l.tracks[0]).toMatchObject({ index00: null, index01: 0 });
  });
});

describe('CD image bytes', () => {
  const disc: CdDiscIn = {
    title: 'Test', performer: 'Band',
    tracks: [track('One', SECTOR_FRAMES * 300 + 100), track('Two', SECTOR_FRAMES * 200, { gapBeforeSec: 1 }), track('Three', SECTOR_FRAMES * 150, { gapBeforeSec: 0 })],
  };
  const layout = layoutDisc(disc);
  const bin = concat(binParts(disc, layout));

  it('is exactly the programme length in 2352-byte sectors', () => {
    expect(bin.length).toBe(layout.totalSectors * SECTOR_BYTES);
    expect(layout.totalSectors).toBe(301 + 75 + 200 + 150);
  });

  it('holds 16-bit little-endian samples, left then right, where INDEX 01 says', () => {
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const at = (sector: number, frame: number) => (sector * SECTOR_BYTES) + frame * 4;
    expect(dv.getInt16(at(0, 0), true)).toBe(7);
    expect(dv.getInt16(at(0, 0) + 2, true)).toBe(-7);
    expect(dv.getInt16(at(0, 5), true)).toBe(12);
    expect(bin[at(0, 0)]).toBe(7);                // low byte first
    expect(bin[at(0, 0) + 1]).toBe(0);
    const t2 = layout.tracks[1].index01;
    expect(dv.getInt16(at(t2, 0), true)).toBe(7);
    expect(dv.getInt16(at(t2, 3), true)).toBe(10);
    const t3 = layout.tracks[2].index01;
    expect(t3).toBe(layout.tracks[1].index01 + 200);          // no gap before track 3
    expect(dv.getInt16(at(t3, 0), true)).toBe(7);
  });

  it('stores the gap and the padding as silence', () => {
    const gap = layout.tracks[1].index00!;
    for (let i = gap * SECTOR_BYTES; i < layout.tracks[1].index01 * SECTOR_BYTES; i += 97) expect(bin[i]).toBe(0);
    const padStart = (300 * SECTOR_BYTES) + 100 * 4;           // the 100 real frames of the last sector of track 1 end here
    for (let i = padStart; i < 301 * SECTOR_BYTES; i++) expect(bin[i]).toBe(0);
    expect(bin[padStart - 4]).not.toBe(0);                      // and the last real frame is still audio
  });

  it('does not copy a track that already fills whole sectors', () => {
    const aligned = pcmFromChannels([new Float32Array(SECTOR_FRAMES * 3).fill(0.25)], 'none');
    const d: CdDiscIn = { title: 't', performer: 'p', tracks: [{ title: 'a', gapBeforeSec: 0, pcm: aligned }] };
    const parts = binParts(d, layoutDisc(d));
    expect(parts).toHaveLength(1);
    expect(parts[0].buffer).toBe(aligned.buffer);
  });
});

describe('pcmFromChannels', () => {
  it('rounds at scale 2^15, clamps, and pads the last sector with zeros', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1, -1, 2, NaN]);
    const right = new Float32Array([0.25, 0, 0, 0, 0, 0, 0]);
    const pcm = pcmFromChannels([left, right], 'none');
    expect(pcm.length).toBe(SECTOR_FRAMES * 2);
    expect(Array.from(pcm.subarray(0, 14))).toEqual([0, 8192, 16384, 0, -16384, 0, 32767, 0, -32768, 0, 32767, 0, 0, 0]);
    expect(pcm[14]).toBe(0);
    expect(pcm[pcm.length - 1]).toBe(0);
  });

  it('uses a mono buffer for both channels', () => {
    const pcm = pcmFromChannels([new Float32Array([0.5, -0.25])], 'none');
    expect(Array.from(pcm.subarray(0, 4))).toEqual([16384, 16384, -8192, -8192]);
  });

  it('dither changes the low bits and nothing else', () => {
    const x = new Float32Array(4000).fill(0.1);
    const plain = pcmFromChannels([x], 'none');
    const dithered = pcmFromChannels([x], 'tpdf');
    let maxDiff = 0;
    for (let i = 0; i < 8000; i++) maxDiff = Math.max(maxDiff, Math.abs(plain[i] - dithered[i]));
    expect(maxDiff).toBeLessThanOrEqual(2);
    expect(maxDiff).toBeGreaterThan(0);
  });
});

describe('CUE sheet', () => {
  const disc: CdDiscIn = {
    title: 'Zażółć "gęślą" jaźń', performer: 'Zespół Łódź', upc: '036000291452',
    tracks: [
      track('Pierwszy', SECTOR_FRAMES * 1000, { isrc: 'PL-ABC-26-00001', songwriter: 'Kamil Skomra' }),
      track('Drugi — remiks', SECTOR_FRAMES * 1500, { isrc: 'PLABC2600002', gapBeforeSec: 2.5 }),
    ],
  };
  const layout = layoutDisc(disc);
  const cue = buildCueSheet(disc, layout, 'my disc.bin');

  it('carries the catalogue number, CD-TEXT, ISRC and both indexes', () => {
    expect(cue).toContain('CATALOG 0036000291452');
    expect(cue).toContain('FILE "my disc.bin" BINARY');
    expect(cue).toContain('TRACK 01 AUDIO');
    expect(cue).toContain('ISRC PLABC2600001');
    expect(cue).toContain('SONGWRITER "Kamil Skomra"');
    expect(cue).toContain('TRACK 02 AUDIO');
    expect(cue).toContain('INDEX 01 00:00:00');
    expect(cue).toContain(`INDEX 00 ${msf(layout.tracks[1].index00!)}`);
    expect(cue).toContain(`INDEX 01 ${msf(layout.tracks[1].index01)}`);
    expect(layout.tracks[1].index01 - layout.tracks[1].index00!).toBe(188);                       // 2.5 s → 187.5 sectors → 188
  });

  it('puts INDEX 00 before INDEX 01 inside each track, in track order', () => {
    const lines = cue.split('\r\n');
    const i00 = lines.findIndex((l) => l.includes('INDEX 00'));
    const i01 = lines.findIndex((l, k) => k > i00 && l.includes('INDEX 01'));
    expect(i00).toBeGreaterThan(lines.findIndex((l) => l.includes('TRACK 02')));
    expect(i01).toBe(i00 + 1);
  });

  it('keeps CD-TEXT inside Latin-1: Polish letters transliterated, no quote or line break left inside a string', () => {
    expect(cue).toContain('TITLE "Zazólc gesla jazn"');                     // ó is Latin-1 and stays; ż ł ć ą ę ś ź ń are transliterated
    expect(cue).toContain('PERFORMER "Zespól Lódz"');
    expect([...cue].every((c) => c.charCodeAt(0) <= 255)).toBe(true);
    for (const line of cue.split('\r\n')) expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    expect(latin1(cue).length).toBe(cue.length);
  });

  it('omits what is invalid instead of writing it', () => {
    const bad = buildCueSheet({ ...disc, upc: '036000291453', tracks: [{ ...disc.tracks[0], isrc: 'nope' }] }, layoutDisc({ ...disc, tracks: [disc.tracks[0]] }), 'a.bin');
    expect(bad).not.toContain('CATALOG');
    expect(bad).not.toContain('ISRC');
  });
});

describe('cdText', () => {
  it('transliterates what Latin-1 cannot hold and trims', () => {
    expect(cdText('Łódź — “zażółć”')).toBe("Lódz - 'zazólc'");
    expect(cdText('Café Ñandú')).toBe('Café Ñandú');                      // already Latin-1
    expect(cdText('  a\r\nb\t"c"  ')).toBe('a b c');
    expect(cdText('x'.repeat(200)).length).toBe(80);
    expect(cdText(undefined)).toBe('');
  });
});

describe('checks before and after rendering', () => {
  const ok = (over: Record<string, unknown> = {}) => ({ title: 'T', isrc: 'PLABC2600001', gapBeforeSec: 2, seconds: 200, ...over });

  it('passes a sound plan with no errors', () => {
    const c = checkPlan('036000291452', [ok(), ok({ isrc: 'PLABC2600002' })]);
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
  });

  it('refuses short tracks, bad or repeated ISRC, a bad UPC, bad gaps and an empty disc', () => {
    const c = checkPlan('123', [ok({ seconds: 3 }), ok({ isrc: 'xx' }), ok({ isrc: 'PLABC2600001' }), ok({ isrc: 'PLABC2600001', gapBeforeSec: 11 })]);
    const text = c.errors.join('\n');
    expect(text).toMatch(/Track 1.*shorter than 4 s/);
    expect(text).toMatch(/Track 2.*not a valid ISRC/);
    expect(text).toMatch(/Track 3.*repeats the ISRC of track 1/);
    expect(text).toMatch(/Track 4.*repeats the ISRC of track 1/);
    expect(text).toMatch(/Track 4.*gap/);
    expect(text).toMatch(/UPC\/EAN/);
    expect(checkPlan(undefined, []).errors[0]).toMatch(/at least one track/);
  });

  it('refuses more than 99 tracks and more than 79:57, warns past 74:00', () => {
    expect(checkPlan(undefined, Array.from({ length: 100 }, (_, i) => ok({ isrc: undefined, title: String(i), seconds: 10, gapBeforeSec: 0 }))).errors.join()).toMatch(/at most 99 tracks/);
    expect(checkPlan(undefined, [ok({ seconds: MAX_DISC_SECONDS + 5 })]).errors.join()).toMatch(/79:57/);
    expect(checkPlan(undefined, [ok({ seconds: 75 * 60 })]).warnings.join()).toMatch(/74:00/);
    expect(checkPlan(undefined, [ok({ seconds: MAX_DISC_SECONDS - 1 })]).errors).toEqual([]);
  });

  it('counts the gaps and the sector padding in the programme time', () => {
    const c = checkPlan(undefined, [ok({ seconds: 100 }), ok({ seconds: 100, gapBeforeSec: 10 })]);
    expect(c.totalSeconds).toBeGreaterThanOrEqual(210);
    expect(c.totalSeconds).toBeLessThan(210.1);
  });

  it('warns about full-scale samples in the real audio', () => {
    const loud = new Int16Array(SECTOR_FRAMES * 2 * 400);
    loud.fill(32767);
    const c = validateDisc({ title: 't', performer: 'p', tracks: [{ title: 'Loud', gapBeforeSec: 0, pcm: loud, isrc: 'PLABC2600001' }] });
    expect(c.warnings.join()).toMatch(/full scale/);
    expect(trackStats(loud).fullScaleSamples).toBe(loud.length);
    expect(trackStats(new Int16Array(10)).peakDb).toBe(-Infinity);
  });
});

describe('PQ list', () => {
  it('lists every track with its indexes, ISRC and peak, and the total', () => {
    const disc: CdDiscIn = { title: 't', performer: 'p', tracks: [track('A', SECTOR_FRAMES * 750, { isrc: 'PLABC2600001' }), track('B', SECTOR_FRAMES * 750)] };
    const text = pqList(disc, layoutDisc(disc));
    expect(text).toContain('PLABC2600001');
    expect(text).toContain('------------');                    // B has no ISRC
    expect(text).toMatch(/Total programme: 00:22:00 \(1650 sectors/);
  });
});

/** A real disc on disk for the ffmpeg check (npx cross-env CD_OUT_DIR=... vitest run src/test/cdMaster.test.ts) */
describe.skipIf(!process.env.CD_OUT_DIR)('disc written to disk', () => {
  it('writes disc.bin, disc.cue and the source tracks as raw files', () => {
    const dir = process.env.CD_OUT_DIR as string;
    mkdirSync(dir, { recursive: true });
    const tone = (hz: number, seconds: number, amp: number) => {
      const n = Math.round(seconds * SAMPLE_RATE);
      const l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) { l[i] = amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE); r[i] = amp * Math.sin((2 * Math.PI * hz * 1.5 * i) / SAMPLE_RATE); }
      return pcmFromChannels([l, r], 'none');
    };
    const tracks: CdTrackIn[] = [
      { title: 'Alpha', isrc: 'PLABC2600001', gapBeforeSec: 0, pcm: tone(440, 7.3, 0.5) },
      { title: 'Beta', isrc: 'PLABC2600002', gapBeforeSec: 2, pcm: tone(880, 5.1, 0.4) },
      { title: 'Gamma', isrc: 'PLABC2600003', gapBeforeSec: 0, pcm: tone(220, 6.2, 0.3) },
    ];
    const disc: CdDiscIn = { title: 'Disc', performer: 'Artist', upc: '036000291452', tracks };
    const layout = layoutDisc(disc);
    writeFileSync(`${dir}/disc.bin`, concat(binParts(disc, layout)));
    writeFileSync(`${dir}/disc.cue`, latin1(buildCueSheet(disc, layout, 'disc.bin')));
    tracks.forEach((t, i) => writeFileSync(`${dir}/src${i + 1}.raw`, new Uint8Array(t.pcm.buffer, t.pcm.byteOffset, t.pcm.byteLength)));
    writeFileSync(`${dir}/layout.json`, JSON.stringify(layout, null, 2));
    expect(layout.totalSectors).toBeGreaterThan(0);
  });
});
