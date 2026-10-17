/**
 * Delivery check — what happens to the master AFTER it leaves the studio.
 *
 * 1. Codec true peak: streaming services transcode the upload (AAC on Apple/YouTube, Ogg/AAC on Spotify, Opus on YouTube).
 *    Lossy encoding adds overshoot, so a master at −1.0 dBTP can clip after the transcode. The master is really encoded
 *    (MP3 with our own LAME encoder; AAC and Opus with the browser's WebCodecs when available), decoded again and the true
 *    peak of the DECODED signal is measured.
 * 2. Mono compatibility: phone speakers, club PAs and many smart speakers sum to mono. Per band we measure how much level
 *    is lost when L and R are summed, plus the overall and the worst-moment phase correlation.
 */
import { FFT, hann } from '@/lib/fft';
import { measureTruePeak } from '@/lib/loudness';

// ───────────────────────────── mono compatibility ─────────────────────────────

export interface MonoBand { name: string; lowHz: number; highHz: number; lossDb: number }
export interface MonoReport {
  /** overall phase correlation, −1..+1 (1 = mono, 0 = unrelated, < 0 = out of phase) */
  correlation: number;
  /** lowest correlation of any 400 ms window that carries signal */
  worstCorrelation: number;
  worstAtSec: number;
  /** level change when L+R are summed to mono, per band (0 dB = nothing lost, −3 dB = fully decorrelated, −∞ = cancels) */
  bands: MonoBand[];
}

export const MONO_BANDS: Array<[string, number, number]> = [
  ['Sub', 20, 120],
  ['Low', 120, 500],
  ['Mid', 500, 4000],
  ['High', 4000, 20000],
];

export function analyseMono(buffer: AudioBuffer): MonoReport {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;

  // overall + windowed correlation
  let sLL = 0, sRR = 0, sLR = 0;
  const win = Math.max(1, Math.round(sr * 0.4));
  let worst = 1, worstAt = 0;
  let peakWindowEnergy = 0;
  const windows: Array<{ c: number; e: number; at: number }> = [];
  for (let s = 0; s < L.length; s += win) {
    let ll = 0, rr = 0, lr = 0;
    const e = Math.min(L.length, s + win);
    for (let i = s; i < e; i++) { const l = L[i], r = R[i]; ll += l * l; rr += r * r; lr += l * r; }
    sLL += ll; sRR += rr; sLR += lr;
    const energy = (ll + rr) / (e - s);
    if (energy > peakWindowEnergy) peakWindowEnergy = energy;
    windows.push({ c: ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1, e: energy, at: s / sr });
  }
  for (const w of windows) {
    if (w.e < peakWindowEnergy * 1e-3) continue;          // ignore windows > 30 dB below the loudest (fades, silence)
    if (w.c < worst) { worst = w.c; worstAt = w.at; }
  }
  const correlation = sLL > 0 && sRR > 0 ? sLR / Math.sqrt(sLL * sRR) : 1;

  // per-band mono-sum loss from an STFT
  const N = 4096, hop = 2048;
  const fft = new FFT(N), w = hann(N);
  const mono = new Float64Array(MONO_BANDS.length), stereo = new Float64Array(MONO_BANDS.length);
  const reL = new Float64Array(N), imL = new Float64Array(N), reR = new Float64Array(N), imR = new Float64Array(N);
  const binOf = (hz: number) => Math.min(N / 2, Math.max(1, Math.round((hz * N) / sr)));
  const ranges = MONO_BANDS.map(([, lo, hi]) => [binOf(lo), binOf(Math.min(hi, sr / 2 - 1))]);
  // at most ~600 frames (≈ 25 s at 48 kHz) spread over the whole track — plenty for a stable estimate
  const frames = Math.max(1, Math.floor((L.length - N) / hop));
  const stride = Math.max(1, Math.floor(frames / 600));
  for (let f = 0; f < frames; f += stride) {
    const off = f * hop;
    for (let i = 0; i < N; i++) { reL[i] = L[off + i] * w[i]; imL[i] = 0; reR[i] = R[off + i] * w[i]; imR[i] = 0; }
    fft.transform(reL, imL);
    fft.transform(reR, imR);
    ranges.forEach(([a, b], k) => {
      for (let i = a; i < b; i++) {
        const mr = (reL[i] + reR[i]) * 0.5, mi = (imL[i] + imR[i]) * 0.5;
        mono[k] += mr * mr + mi * mi;
        stereo[k] += (reL[i] * reL[i] + imL[i] * imL[i] + reR[i] * reR[i] + imR[i] * imR[i]) * 0.5;
      }
    });
  }
  const bands = MONO_BANDS.map(([name, lowHz, highHz], k) => ({
    name, lowHz, highHz,
    lossDb: stereo[k] > 1e-20 ? Math.max(-60, 10 * Math.log10(Math.max(mono[k], 1e-30) / stereo[k])) : 0,
  }));
  return { correlation, worstCorrelation: worst, worstAtSec: worstAt, bands };
}

// ───────────────────────────── codec true peak ─────────────────────────────

export interface CodecResult {
  id: 'mp3-320' | 'aac-256' | 'opus-160';
  label: string;
  /** used by */
  platforms: string;
  available: boolean;
  /** true peak of the decoded signal, dBTP (null when not available) */
  truePeak: number | null;
  note?: string;
}

const CODECS: Array<{ id: CodecResult['id']; label: string; platforms: string }> = [
  { id: 'aac-256', label: 'AAC 256 kbps', platforms: 'Apple Music, YouTube, Tidal, Amazon' },
  { id: 'opus-160', label: 'Opus 160 kbps', platforms: 'YouTube, Spotify (Web)' },
  { id: 'mp3-320', label: 'MP3 320 kbps', platforms: 'downloads, Beatport, SoundCloud' },
];

function toBuffer(channels: Float32Array[], sr: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: sr });
  channels.forEach((c, i) => out.copyToChannel(c, i));
  return out;
}

async function resample(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === rate) return buffer;
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, Math.ceil((buffer.length * rate) / buffer.sampleRate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/** Encode + decode through WebCodecs. Returns null when the browser has no encoder for this codec. */
async function webCodecsRoundTrip(buffer: AudioBuffer, codec: string, bitrate: number, rate: number): Promise<AudioBuffer | null> {
  const W = globalThis as unknown as { AudioEncoder?: any; AudioDecoder?: any; AudioData?: any };
  if (!W.AudioEncoder || !W.AudioDecoder || !W.AudioData) return null;
  const src = await resample(buffer, rate);
  const ch = Math.min(2, src.numberOfChannels);
  const encCfg = { codec, sampleRate: rate, numberOfChannels: ch, bitrate };
  const sup = await W.AudioEncoder.isConfigSupported(encCfg).catch(() => ({ supported: false }));
  if (!sup.supported) return null;

  const chunks: any[] = [];
  let decoderConfig: any = null;
  let failure: unknown = null;
  const enc = new W.AudioEncoder({
    output: (chunk: any, meta: any) => { chunks.push(chunk); if (meta?.decoderConfig) decoderConfig = meta.decoderConfig; },
    error: (e: unknown) => { failure = e; },
  });
  enc.configure(encCfg);
  const FRAME = 4800;
  const planar = new Float32Array(FRAME * ch);
  for (let off = 0; off < src.length; off += FRAME) {
    const n = Math.min(FRAME, src.length - off);
    for (let c = 0; c < ch; c++) planar.set(src.getChannelData(c).subarray(off, off + n), c * n);
    const data = new W.AudioData({
      format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch,
      timestamp: Math.round((off / rate) * 1e6), data: planar.subarray(0, n * ch),
    });
    enc.encode(data);
    data.close();
  }
  await enc.flush();
  enc.close();
  if (failure || !decoderConfig) return null;

  const decoded: Float32Array[][] = Array.from({ length: ch }, () => []);
  const dec = new W.AudioDecoder({
    output: (d: any) => {
      for (let c = 0; c < ch; c++) {
        const part = new Float32Array(d.numberOfFrames);
        d.copyTo(part, { planeIndex: c, format: 'f32-planar' });
        decoded[c].push(part);
      }
      d.close();
    },
    error: (e: unknown) => { failure = e; },
  });
  dec.configure(decoderConfig);
  for (const c of chunks) dec.decode(c);
  await dec.flush();
  dec.close();
  if (failure) return null;
  const join = (parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  return toBuffer(decoded.map(join), rate);
}

async function mp3RoundTrip(buffer: AudioBuffer): Promise<AudioBuffer> {
  const { encodeMp3 } = await import('@/lib/encoders/mp3');
  const bytes = encodeMp3(buffer, 320);
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, 1, buffer.sampleRate);
  return ctx.decodeAudioData(bytes.slice().buffer);
}

export async function codecTruePeaks(buffer: AudioBuffer, onProgress?: (label: string) => void): Promise<CodecResult[]> {
  const out: CodecResult[] = [];
  for (const c of CODECS) {
    onProgress?.(c.label);
    try {
      const decoded = c.id === 'mp3-320'
        ? await mp3RoundTrip(buffer)
        : c.id === 'aac-256'
          ? await webCodecsRoundTrip(buffer, 'mp4a.40.2', 256_000, buffer.sampleRate === 44100 ? 44100 : 48000)
          : await webCodecsRoundTrip(buffer, 'opus', 160_000, 48000);
      if (!decoded) {
        out.push({ ...c, available: false, truePeak: null, note: 'this browser has no encoder for it (Chrome / Edge do)' });
        continue;
      }
      out.push({ ...c, available: true, truePeak: measureTruePeak(decoded).truePeak });
    } catch (e) {
      out.push({ ...c, available: false, truePeak: null, note: 'encoding failed in this browser' });
      console.warn('[delivery]', c.id, e);
    }
  }
  return out;
}

// ───────────────────────────── verdict ─────────────────────────────

export interface Finding { level: 'ok' | 'warn' | 'fail'; text: string }

/** Recommended ceiling after a lossy transcode (Spotify / Apple guidance). */
export const CODEC_CEILING_DB = -1.0;

export function deliveryVerdict(masterTruePeak: number, codecs: CodecResult[], mono: MonoReport): Finding[] {
  const f: Finding[] = [];
  const measured = codecs.filter((c) => c.available && c.truePeak != null);
  const worst = measured.reduce<CodecResult | null>((a, c) => (!a || (c.truePeak as number) > (a.truePeak as number) ? c : a), null);
  if (worst) {
    const over = (worst.truePeak as number) - CODEC_CEILING_DB;
    if (over > 0.05) {
      const ceiling = Math.floor((masterTruePeak - over - 0.1) * 10) / 10;
      f.push({
        level: (worst.truePeak as number) > 0 ? 'fail' : 'warn',
        text: `After ${worst.label} the peak reaches ${(worst.truePeak as number).toFixed(1)} dBTP (${worst.platforms}). Set the limiter ceiling to about ${ceiling.toFixed(1)} dBTP so the transcoded file stays under ${CODEC_CEILING_DB} dBTP.`,
      });
    } else {
      f.push({ level: 'ok', text: `Codec-safe: every transcode stays under ${CODEC_CEILING_DB} dBTP (worst: ${worst.label}, ${(worst.truePeak as number).toFixed(1)} dBTP).` });
    }
  }
  if (mono.correlation < 0) {
    f.push({ level: 'fail', text: `Overall phase correlation is ${mono.correlation.toFixed(2)} — large parts cancel in mono. Check for a polarity-flipped channel.` });
  } else if (mono.worstCorrelation < -0.3) {
    f.push({ level: 'warn', text: `At ${fmt(mono.worstAtSec)} the correlation drops to ${mono.worstCorrelation.toFixed(2)} — that passage loses body in mono (wide reverb or stereo widener?).` });
  }
  for (const b of mono.bands) {
    const limit = b.name === 'Sub' || b.name === 'Low' ? -1.5 : b.name === 'Mid' ? -4.5 : -6;
    if (b.lossDb < limit) {
      f.push({
        level: b.name === 'Sub' || b.name === 'Low' ? 'fail' : 'warn',
        text: `${b.name} (${b.lowHz}–${b.highHz} Hz) drops ${(-b.lossDb).toFixed(1)} dB in mono.${b.name === 'Sub' || b.name === 'Low' ? ' Use Bass Mono below ~120–150 Hz so the low end survives phones and club systems.' : ' Narrow the stereo image of this range a little.'}`,
      });
    }
  }
  if (!f.some((x) => x.level !== 'ok') && mono.correlation >= 0) {
    f.push({ level: 'ok', text: `Mono-safe: correlation ${mono.correlation.toFixed(2)}, low end ${mono.bands[1].lossDb.toFixed(1)} dB in mono.` });
  }
  return f;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
