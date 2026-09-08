import { Mp3Encoder } from '@breezystack/lamejs';

/**
 * Encode an AudioBuffer to MP3 (CBR). Pure-JS (lamejs) — no WASM.
 * @param kbps 128 | 192 | 256 | 320
 */
export function encodeMp3(buffer: AudioBuffer, kbps = 320): Uint8Array {
  const channels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const enc = new Mp3Encoder(channels, sampleRate, kbps);

  const left = floatToInt16(buffer.getChannelData(0));
  const right = channels > 1 ? floatToInt16(buffer.getChannelData(1)) : left;

  const BLOCK = 1152;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const r = right.subarray(i, i + BLOCK);
    const mp3 = channels > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (mp3.length) chunks.push(new Uint8Array(mp3));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
