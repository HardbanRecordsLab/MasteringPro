/**
 * Release metadata written INTO the exported files, so a master reaches the distributor / DJ software already labelled.
 *
 *   WAV  — LIST/INFO (INAM, IART, IPRD, ICRD, IGNR, ICMT, ISFT) + an "id3 " chunk (TSRC = ISRC; read by most tools)
 *   AIFF — NAME / AUTH chunks + an "ID3 " chunk
 *   FLAC — VORBIS_COMMENT block (TITLE, ARTIST, ALBUM, DATE, GENRE, ISRC, COMMENT)
 *   MP3  — ID3v2.4 tag in front of the audio
 *
 * Every function returns the input untouched when there is nothing to write.
 */
export interface ReleaseMeta {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  /** International Standard Recording Code, 12 characters (dashes allowed on input) */
  isrc?: string;
  comment?: string;
}

const SOFTWARE = 'MasteringPro (masteringpro.hardbanrecordslab.online)';
const enc = new TextEncoder();

/** "PL-A1B-26-00001" → "PLA1B2600001"; null when it is not a valid ISRC. */
export function normaliseIsrc(s: string | undefined): string | null {
  if (!s) return null;
  const v = s.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : null;
}

const clean = (m: ReleaseMeta | undefined): Required<Omit<ReleaseMeta, 'isrc'>> & { isrc: string | null } => ({
  title: (m?.title ?? '').trim(),
  artist: (m?.artist ?? '').trim(),
  album: (m?.album ?? '').trim(),
  year: (m?.year ?? '').trim().slice(0, 10),
  genre: (m?.genre ?? '').trim(),
  comment: (m?.comment ?? '').trim(),
  isrc: normaliseIsrc(m?.isrc),
});

export function hasMeta(m: ReleaseMeta | undefined): boolean {
  const c = clean(m);
  return !!(c.title || c.artist || c.album || c.year || c.genre || c.comment || c.isrc);
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u32be = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const syncsafe = (n: number) => Uint8Array.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// ───────────────────────────── ID3v2.4 ─────────────────────────────

export function id3v2(meta: ReleaseMeta | undefined): Uint8Array {
  const c = clean(meta);
  const frames: Uint8Array[] = [];
  const text = (id: string, v: string) => {
    if (!v) return;
    const body = concat([Uint8Array.of(3), enc.encode(v)]);            // 3 = UTF-8
    frames.push(concat([ascii(id), syncsafe(body.length), Uint8Array.of(0, 0), body]));
  };
  text('TIT2', c.title); text('TPE1', c.artist); text('TALB', c.album); text('TDRC', c.year);
  text('TCON', c.genre); text('TSRC', c.isrc ?? ''); text('TSSE', SOFTWARE);
  if (c.comment) {
    const body = concat([Uint8Array.of(3), ascii('eng'), Uint8Array.of(0), enc.encode(c.comment)]);
    frames.push(concat([ascii('COMM'), syncsafe(body.length), Uint8Array.of(0, 0), body]));
  }
  const payload = concat(frames);
  return concat([ascii('ID3'), Uint8Array.of(4, 0, 0), syncsafe(payload.length), payload]);
}

export function tagMp3(mp3: Uint8Array, meta: ReleaseMeta | undefined): Uint8Array {
  return hasMeta(meta) ? concat([id3v2(meta), mp3]) : mp3;
}

// ───────────────────────────── WAV (RIFF, little-endian) ─────────────────────────────

const riffChunk = (id: string, data: Uint8Array, le = true) => {
  const pad = data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0);
  return concat([ascii(id), le ? u32le(data.length) : u32be(data.length), data, pad]);
};

export function tagWav(wav: ArrayBuffer, meta: ReleaseMeta | undefined): ArrayBuffer {
  if (!hasMeta(meta)) return wav;
  const c = clean(meta);
  const info: Uint8Array[] = [];
  const put = (id: string, v: string) => { if (v) info.push(riffChunk(id, concat([enc.encode(v), Uint8Array.of(0)]))); };
  put('INAM', c.title); put('IART', c.artist); put('IPRD', c.album); put('ICRD', c.year); put('IGNR', c.genre);
  put('ICMT', [c.comment, c.isrc ? `ISRC ${c.isrc}` : ''].filter(Boolean).join(' · ')); put('ISFT', SOFTWARE);
  const list = riffChunk('LIST', concat([ascii('INFO'), ...info]));
  const id3 = riffChunk('id3 ', id3v2(meta));
  const out = concat([new Uint8Array(wav), list, id3]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out.buffer;
}

// ───────────────────────────── AIFF (IFF, big-endian) ─────────────────────────────

export function tagAiff(aiff: ArrayBuffer, meta: ReleaseMeta | undefined): ArrayBuffer {
  if (!hasMeta(meta)) return aiff;
  const c = clean(meta);
  const extra: Uint8Array[] = [];
  if (c.title) extra.push(riffChunk('NAME', enc.encode(c.title), false));
  if (c.artist) extra.push(riffChunk('AUTH', enc.encode(c.artist), false));
  extra.push(riffChunk('ID3 ', id3v2(meta), false));
  const out = concat([new Uint8Array(aiff), ...extra]);
  new DataView(out.buffer).setUint32(4, out.length - 8, false);
  return out.buffer;
}

// ───────────────────────────── FLAC ─────────────────────────────

/** Insert (or replace) the VORBIS_COMMENT metadata block. */
export function tagFlac(flac: Uint8Array, meta: ReleaseMeta | undefined): Uint8Array {
  if (!hasMeta(meta)) return flac;
  if (String.fromCharCode(...flac.subarray(0, 4)) !== 'fLaC') return flac;
  const c = clean(meta);
  const fields: string[] = [];
  const put = (k: string, v: string) => { if (v) fields.push(`${k}=${v}`); };
  put('TITLE', c.title); put('ARTIST', c.artist); put('ALBUM', c.album); put('DATE', c.year);
  put('GENRE', c.genre); put('ISRC', c.isrc ?? ''); put('COMMENT', c.comment); put('ENCODER', SOFTWARE);
  const vendor = enc.encode(SOFTWARE);
  const body = concat([u32le(vendor.length), vendor, u32le(fields.length),
    ...fields.flatMap((f) => { const b = enc.encode(f); return [u32le(b.length), b]; })]);

  // walk the metadata blocks
  const blocks: Array<{ type: number; data: Uint8Array }> = [];
  let o = 4, last = false;
  while (!last && o + 4 <= flac.length) {
    last = (flac[o] & 0x80) !== 0;
    const type = flac[o] & 0x7f;
    const len = (flac[o + 1] << 16) | (flac[o + 2] << 8) | flac[o + 3];
    blocks.push({ type, data: flac.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  const audio = flac.subarray(o);
  const kept = blocks.filter((b) => b.type !== 4);
  kept.splice(1, 0, { type: 4, data: body });              // right after STREAMINFO
  const out: Uint8Array[] = [ascii('fLaC')];
  kept.forEach((b, i) => {
    const isLast = i === kept.length - 1;
    out.push(Uint8Array.of((isLast ? 0x80 : 0) | b.type, (b.data.length >> 16) & 0xff, (b.data.length >> 8) & 0xff, b.data.length & 0xff), b.data);
  });
  out.push(audio);
  return concat(out);
}
