/**
 * Native-rate decoding.
 *
 * `AudioContext.decodeAudioData` resamples every file to the context's sample rate (44.1 or 48 kHz depending on the
 * device). For mastering that is wrong: the signal is altered before the first processor runs, hard-clipped peaks stop
 * being flat (so declipping cannot see them) and the export comes out at a rate the user never chose.
 *
 * We read the true sample rate from the container header and decode inside an OfflineAudioContext created at THAT rate,
 * so the browser's decoder returns the samples untouched. Unknown containers fall back to the normal decode.
 */

const MIN_RATE = 8000;
const MAX_RATE = 96000;

const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000],  // MPEG 2.5
};

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

/** IEEE 754 80-bit extended float (AIFF sample rate) */
function readExtended80(b: Uint8Array, at: number): number {
  const exp = ((b[at] & 0x7f) << 8) | b[at + 1];
  let hi = 0;
  for (let i = 0; i < 4; i++) hi = hi * 256 + b[at + 2 + i];
  let lo = 0;
  for (let i = 0; i < 4; i++) lo = lo * 256 + b[at + 6 + i];
  const mant = hi * 4294967296 + lo;
  return Math.round(mant * Math.pow(2, exp - 16383 - 63));
}

/** Sample rate declared in the file's header, or null when the container is not recognised. */
export function readSampleRate(bytes: Uint8Array): number | null {
  const n = bytes.length;
  if (n < 32) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // WAV: RIFF .... WAVE, then chunks; 'fmt ' holds the rate
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    let p = 12;
    while (p + 8 <= n) {
      const id = ascii(bytes, p, 4);
      const size = dv.getUint32(p + 4, true);
      if (id === 'fmt ' && p + 16 <= n) return dv.getUint32(p + 12, true);
      p += 8 + size + (size & 1);
    }
    return null;
  }
  // AIFF / AIFC: FORM .... AIFF, 'COMM' chunk (big-endian)
  if (ascii(bytes, 0, 4) === 'FORM' && (ascii(bytes, 8, 4) === 'AIFF' || ascii(bytes, 8, 4) === 'AIFC')) {
    let p = 12;
    while (p + 8 <= n) {
      const id = ascii(bytes, p, 4);
      const size = dv.getUint32(p + 4, false);
      if (id === 'COMM' && p + 8 + 18 <= n) return readExtended80(bytes, p + 8 + 8);
      p += 8 + size + (size & 1);
    }
    return null;
  }
  // FLAC: 'fLaC' + STREAMINFO (sample rate = 20 bits at byte 18)
  if (ascii(bytes, 0, 4) === 'fLaC' && n >= 22) {
    return (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  }
  // Ogg: Vorbis identification header carries the rate; Opus always decodes at 48 kHz
  if (ascii(bytes, 0, 4) === 'OggS') {
    const head = ascii(bytes, 0, Math.min(n, 400));
    const v = head.indexOf('\x01vorbis');
    if (v >= 0 && v + 16 <= n) return dv.getUint32(v + 12, true);
    if (head.indexOf('OpusHead') >= 0) return 48000;
    return null;
  }
  // MP3: skip an ID3v2 tag, then find the first frame sync
  let p = 0;
  if (ascii(bytes, 0, 3) === 'ID3' && n >= 10) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    p = 10 + size;
  }
  for (let i = p; i + 4 < Math.min(n, p + 8192); i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const ver = (bytes[i + 1] >> 3) & 3;          // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layer = (bytes[i + 1] >> 1) & 3;
      const idx = (bytes[i + 2] >> 2) & 3;
      if (ver !== 1 && layer !== 0 && idx !== 3 && MP3_RATES[ver]) return MP3_RATES[ver][idx];
    }
  }
  return null;
}

/** Decode a file at its own sample rate. Falls back to the context's rate when it cannot. */
export async function decodeNative(arrayBuffer: ArrayBuffer, fallbackCtx: BaseAudioContext): Promise<AudioBuffer> {
  const rate = readSampleRate(new Uint8Array(arrayBuffer));
  if (rate && rate >= MIN_RATE && rate <= MAX_RATE && Math.round(fallbackCtx.sampleRate) !== rate) {
    try {
      const off = new OfflineAudioContext(2, 1, rate);
      // decodeAudioData detaches its input, so give it a copy and keep the original for the fallback
      return await off.decodeAudioData(arrayBuffer.slice(0));
    } catch (e) {
      console.warn('[decodeNative] native-rate decode failed, using the context rate', e);
    }
  }
  return fallbackCtx.decodeAudioData(arrayBuffer);
}
