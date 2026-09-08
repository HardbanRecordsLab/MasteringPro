/**
 * Encode an AudioBuffer to FLAC via libflac.js (asm.js build — no separate WASM
 * asset, bundles cleanly). Lazy-loaded on first use.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let flacModPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getFlac(): Promise<any> {
  if (!flacModPromise) {
    flacModPromise = import('libflacjs/dist/libflac.js').then((m) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Flac: any = (m as any).default ?? m;
      return new Promise((resolve) => {
        if (Flac.isReady && Flac.isReady()) resolve(Flac);
        else Flac.on('ready', () => resolve(Flac));
      });
    });
  }
  return flacModPromise;
}

export async function encodeFlac(buffer: AudioBuffer, bps: 16 | 24 = 24): Promise<Uint8Array> {
  const Flac = await getFlac();
  const channels = Math.min(2, buffer.numberOfChannels);
  const samples = buffer.length;
  const full = 2 ** (bps - 1) - 1;

  const enc = Flac.create_libflac_encoder(buffer.sampleRate, channels, bps, 5, samples, false, 0);
  if (!enc) throw new Error('FLAC encoder init failed');

  const parts: Uint8Array[] = [];
  const status = Flac.init_encoder_stream(
    enc,
    (data: Uint8Array) => {
      parts.push(new Uint8Array(data)); // copy — the view is reused
    },
    () => {},
  );
  if (status !== 0) {
    Flac.FLAC__stream_encoder_delete(enc);
    throw new Error(`FLAC init_encoder_stream status ${status}`);
  }

  // per-channel Int32 buffers
  const chBufs: Int32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const src = buffer.getChannelData(c);
    const dst = new Int32Array(samples);
    for (let i = 0; i < samples; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      dst[i] = Math.round(s * full);
    }
    chBufs.push(dst);
  }

  const CHUNK = 1 << 16;
  for (let off = 0; off < samples; off += CHUNK) {
    const len = Math.min(CHUNK, samples - off);
    const slice = chBufs.map((b) => b.subarray(off, off + len));
    if (!Flac.FLAC__stream_encoder_process(enc, slice, len)) {
      Flac.FLAC__stream_encoder_delete(enc);
      throw new Error('FLAC encode error');
    }
  }

  Flac.FLAC__stream_encoder_finish(enc);
  Flac.FLAC__stream_encoder_delete(enc);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
