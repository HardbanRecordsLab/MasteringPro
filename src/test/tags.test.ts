import { describe, it, expect } from 'vitest';
import { hasMeta, id3v2, normaliseIsrc, tagFlac, tagMp3, tagWav, tagAiff } from '@/lib/tags';
import { encodeWav, encodeAiff } from '@/lib/audioExport';
import { fakeBuffer, tone } from './harness';

const meta = { title: 'Zażółć gęślą', artist: 'CMLP', album: 'Night Drive', year: '2026', genre: 'Electronic', isrc: 'PL-A1B-26-00001', comment: 'test' };
const dec = new TextDecoder();
const str = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const unsync = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function id3Frames(tag: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const size = unsync(tag, 6);
  let o = 10;
  while (o < 10 + size) {
    const id = str(tag, o, 4), len = unsync(tag, o + 4);
    const body = tag.subarray(o + 10, o + 10 + len);
    out[id] = id === 'COMM' ? dec.decode(body.subarray(5)) : dec.decode(body.subarray(1));
    o += 10 + len;
  }
  return out;
}

function riffChunks(b: Uint8Array, le = true): Array<{ id: string; len: number; at: number }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const list: Array<{ id: string; len: number; at: number }> = [];
  let o = 12;
  while (o + 8 <= b.length) {
    const len = v.getUint32(o + 4, le);
    list.push({ id: str(b, o, 4), len, at: o + 8 });
    o += 8 + len + (len & 1);
  }
  expect(o).toBe(b.length);                     // the chunks tile the file exactly
  return list;
}

describe('tags', () => {
  it('ISRC: dashes and case are normalised, invalid codes are rejected', () => {
    expect(normaliseIsrc('pl-a1b-26-00001')).toBe('PLA1B2600001');
    expect(normaliseIsrc('PLA1B260001')).toBeNull();
    expect(normaliseIsrc('12A1B2600001')).toBeNull();
    expect(hasMeta({})).toBe(false);
    expect(hasMeta({ isrc: 'bad' })).toBe(false);
  });

  it('ID3v2.4 carries every field as UTF-8', () => {
    const t = id3v2(meta);
    expect(str(t, 0, 3)).toBe('ID3');
    expect(t[3]).toBe(4);
    const f = id3Frames(t);
    expect(f).toMatchObject({ TIT2: 'Zażółć gęślą', TPE1: 'CMLP', TALB: 'Night Drive', TDRC: '2026', TCON: 'Electronic', TSRC: 'PLA1B2600001', COMM: 'test' });
    expect(f.TSSE).toContain('MasteringPro');
  });

  it('MP3: the tag goes in front; no metadata → bytes untouched', () => {
    const audio = Uint8Array.of(0xff, 0xfb, 1, 2, 3);
    const tagged = tagMp3(audio, meta);
    expect(str(tagged, 0, 3)).toBe('ID3');
    expect(Array.from(tagged.subarray(tagged.length - 5))).toEqual(Array.from(audio));
    expect(tagMp3(audio, {})).toBe(audio);
  });

  it('WAV: LIST/INFO and id3 chunks are appended, RIFF size stays valid, audio untouched', () => {
    const x = tone(1000, -12, 0.1);
    const plain = new Uint8Array(encodeWav(fakeBuffer([x, x]), 24, 'none'));
    const tagged = new Uint8Array(tagWav(plain.slice().buffer, meta));
    const v = new DataView(tagged.buffer);
    expect(v.getUint32(4, true)).toBe(tagged.length - 8);
    const chunks = riffChunks(tagged);
    expect(chunks.map((c) => c.id)).toEqual(['fmt ', 'data', 'LIST', 'id3 ']);
    const data = chunks[1];
    expect(Array.from(tagged.subarray(data.at, data.at + data.len))).toEqual(Array.from(plain.subarray(44)));
    const list = chunks[2];
    const txt = dec.decode(tagged.subarray(list.at, list.at + list.len));
    expect(txt).toContain('INFO');
    expect(txt).toContain('Zażółć gęślą');
    expect(txt).toContain('ISRC PLA1B2600001');
  });

  it('AIFF: NAME / AUTH / ID3 chunks, FORM size valid', () => {
    const x = tone(1000, -12, 0.05);
    const tagged = new Uint8Array(tagAiff(encodeAiff(fakeBuffer([x]), 16, 'none'), meta));
    expect(new DataView(tagged.buffer).getUint32(4, false)).toBe(tagged.length - 8);
    expect(riffChunks(tagged, false).map((c) => c.id)).toEqual(['COMM', 'SSND', 'NAME', 'AUTH', 'ID3 ']);
  });

  it('FLAC: VORBIS_COMMENT is inserted after STREAMINFO and the last-block flag moves', () => {
    // fLaC + STREAMINFO(34 bytes, marked last) + fake audio frames
    const si = new Uint8Array(34).fill(7);
    const flac = Uint8Array.from([...'fLaC'].map((c) => c.charCodeAt(0)).concat([0x80, 0, 0, 34], Array.from(si), [0xff, 0xf8, 9, 9]));
    const out = tagFlac(flac, meta);
    expect(out[4] & 0x80).toBe(0);                  // STREAMINFO no longer last
    expect(out[4] & 0x7f).toBe(0);
    const o = 4 + 4 + 34;
    expect(out[o] & 0x80).toBe(0x80);               // the comment block is last
    expect(out[o] & 0x7f).toBe(4);
    const len = (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3];
    const body = out.subarray(o + 4, o + 4 + len);
    const txt = dec.decode(body);
    expect(txt).toContain('TITLE=Zażółć gęślą');
    expect(txt).toContain('ISRC=PLA1B2600001');
    expect(Array.from(out.subarray(o + 4 + len))).toEqual([0xff, 0xf8, 9, 9]);
    // tagging twice replaces, never duplicates
    const again = tagFlac(out, { ...meta, title: 'B' });
    expect((dec.decode(again).match(/TITLE=/g) || []).length).toBe(1);
  });
});
