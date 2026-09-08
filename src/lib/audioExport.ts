import JSZip from 'jszip';
import type { ProcessingParams } from '@/contexts/AudioContext';
import { renderProcessed } from '@/lib/offlineRender';
import { measureIntegratedLoudness, measureTruePeak } from '@/lib/loudness';

/** Outcome of a loudness-matched render — surfaced to the UI. */
export interface MasterReport {
  integratedLufs: number;   // achieved LUFS (BS.1770-4)
  truePeakDb: number;       // achieved dBTP
  targetLufs: number | null;
  targetPeakDb: number;
  /** dB of extra drive the loop added into the chain to hit the target. */
  driveDb: number;
  iterations: number;
  /** true when |achieved - target| <= 0.3 LU. */
  onTarget: boolean;
  /** set when the chain could not reach the target (loudness-saturated). */
  note?: string;
}

/**
 * Encode AudioBuffer to WAV ArrayBuffer
 */
export type DitherMode = 'none' | 'tpdf' | 'shaped';

/**
 * TPDF dither + optional 2nd-order noise shaping, applied per channel.
 * Only meaningful for fixed-point targets (16/24-bit).
 */
function makeDitherer(bitDepth: 16 | 24 | 32, mode: DitherMode, numChannels: number) {
  if (bitDepth === 32 || mode === 'none') {
    return (sample: number) => sample;
  }
  const lsb = 1 / Math.pow(2, bitDepth - 1);
  const e1 = new Float32Array(numChannels);
  const e2 = new Float32Array(numChannels);
  return (sample: number, ch: number) => {
    let x = sample;
    if (mode === 'shaped') {
      // simple 2nd-order highpass error feedback
      x += 1.8 * e1[ch] - 0.9 * e2[ch];
    }
    // TPDF noise, 1 LSB peak-to-peak
    const noise = (Math.random() - Math.random()) * lsb;
    const dithered = x + noise;
    if (mode === 'shaped') {
      const quantized = Math.round(dithered / lsb) * lsb;
      e2[ch] = e1[ch];
      e1[ch] = quantized - x;
    }
    return dithered;
  };
}

export function encodeWav(
  buffer: AudioBuffer,
  bitDepth: 16 | 24 | 32 = 24,
  dither: DitherMode = 'tpdf',
): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const headerSize = 44;
  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // format (3=float, 1=PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Get channel data
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  const applyDither = makeDitherer(bitDepth, dither, numChannels);

  let offset = headerSize;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, applyDither(channels[c][i], c)));
      if (bitDepth === 16) {
        view.setInt16(offset, sample * 0x7FFF, true);
      } else if (bitDepth === 24) {
        const val = Math.round(sample * 0x7FFFFF);
        view.setUint8(offset, val & 0xFF);
        view.setUint8(offset + 1, (val >> 8) & 0xFF);
        view.setUint8(offset + 2, (val >> 16) & 0xFF);
      } else {
        view.setFloat32(offset, sample, true);
      }
      offset += bytesPerSample;
    }
  }

  return arrayBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** IEEE-754 80-bit extended float (for the AIFF sample-rate field). */
function write80BitFloat(view: DataView, offset: number, value: number) {
  if (value <= 0) { for (let i = 0; i < 10; i++) view.setUint8(offset + i, 0); return; }
  let exponent = Math.floor(Math.log2(value));
  let mantissa = value / Math.pow(2, exponent);
  // normalise so the integer bit is set
  while (mantissa < 1) { mantissa *= 2; exponent -= 1; }
  while (mantissa >= 2) { mantissa /= 2; exponent += 1; }
  const biasedExp = exponent + 16383;
  view.setUint16(offset, biasedExp, false);
  const hi = Math.floor(mantissa * Math.pow(2, 31));
  const lo = Math.floor((mantissa * Math.pow(2, 31) - hi) * Math.pow(2, 32));
  view.setUint32(offset + 2, hi >>> 0, false);
  view.setUint32(offset + 6, lo >>> 0, false);
}

/** Encode an AudioBuffer to AIFF (big-endian PCM). 16 or 24-bit. */
export function encodeAiff(
  buffer: AudioBuffer,
  bitDepth: 16 | 24 = 24,
  dither: DitherMode = 'tpdf',
): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const dataSize = length * numChannels * bytesPerSample;
  const ssndSize = dataSize + 8;
  const total = 12 + (8 + 18) + (8 + ssndSize);
  const ab = new ArrayBuffer(total);
  const view = new DataView(ab);

  writeString(view, 0, 'FORM');
  view.setUint32(4, total - 8, false);
  writeString(view, 8, 'AIFF');

  writeString(view, 12, 'COMM');
  view.setUint32(16, 18, false);
  view.setUint16(20, numChannels, false);
  view.setUint32(22, length, false);
  view.setUint16(26, bitDepth, false);
  write80BitFloat(view, 28, buffer.sampleRate);

  writeString(view, 38, 'SSND');
  view.setUint32(42, ssndSize, false);
  view.setUint32(46, 0, false); // offset
  view.setUint32(50, 0, false); // block size

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
  const applyDither = makeDitherer(bitDepth, dither, numChannels);

  let o = 54;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, applyDither(channels[c][i], c)));
      if (bitDepth === 16) {
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, false);
      } else {
        const v = Math.round(s * 0x7fffff);
        view.setUint8(o, (v >> 16) & 0xff);
        view.setUint8(o + 1, (v >> 8) & 0xff);
        view.setUint8(o + 2, v & 0xff);
      }
      o += bytesPerSample;
    }
  }
  return ab;
}

export interface ExportFormat {
  id: string;
  kind: 'wav' | 'aiff' | 'mp3' | 'flac';
  bitDepth: 16 | 24 | 32;
  extension: string;
  /** MP3 bitrate (kbps) */
  kbps?: number;
  suffix: string;
}

export const FORMAT_MAP: Record<string, ExportFormat> = {
  wav24: { id: 'wav24', kind: 'wav', bitDepth: 24, extension: 'wav', suffix: '24bit' },
  wav16: { id: 'wav16', kind: 'wav', bitDepth: 16, extension: 'wav', suffix: '16bit' },
  wav32: { id: 'wav32', kind: 'wav', bitDepth: 32, extension: 'wav', suffix: '32float' },
  aiff24: { id: 'aiff24', kind: 'aiff', bitDepth: 24, extension: 'aiff', suffix: 'aiff-24' },
  aiff16: { id: 'aiff16', kind: 'aiff', bitDepth: 16, extension: 'aiff', suffix: 'aiff-16' },
  flac: { id: 'flac', kind: 'flac', bitDepth: 24, extension: 'flac', suffix: 'flac' },
  'mp3-320': { id: 'mp3-320', kind: 'mp3', bitDepth: 16, extension: 'mp3', kbps: 320, suffix: 'mp3-320' },
  'mp3-256': { id: 'mp3-256', kind: 'mp3', bitDepth: 16, extension: 'mp3', kbps: 256, suffix: 'mp3-256' },
};

export interface ExportOptions {
  formats: string[];
  filename: string;
  targetPeakDb: number;
  /** Target integrated loudness (LUFS). When set, gain is matched to it. */
  targetLufs?: number;
  /** Full mastering chain — when provided the export is rendered through it. */
  processing?: ProcessingParams;
  dither?: DitherMode;
  /** Deliver at this sample rate (resampled from the master). Default: source SR. */
  sampleRate?: number;
  onProgress?: (format: string, progress: number) => void;
}

/** Resample a buffer to `targetRate` (browser OfflineAudioContext resampler). */
export async function resampleBuffer(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  if (Math.abs(buffer.sampleRate - targetRate) < 1) return buffer;
  const frames = Math.max(1, Math.ceil((buffer.length / buffer.sampleRate) * targetRate));
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, frames, targetRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/** Encode one rendered buffer to the requested container. */
export async function encodeFormat(
  buffer: AudioBuffer,
  fmt: ExportFormat,
  dither: DitherMode,
): Promise<{ data: ArrayBuffer | Uint8Array; mime: string }> {
  if (fmt.kind === 'mp3') {
    const { encodeMp3 } = await import('@/lib/encoders/mp3');
    return { data: encodeMp3(buffer, fmt.kbps ?? 320), mime: 'audio/mpeg' };
  }
  if (fmt.kind === 'flac') {
    const { encodeFlac } = await import('@/lib/encoders/flac');
    return { data: await encodeFlac(buffer, fmt.bitDepth === 16 ? 16 : 24), mime: 'audio/flac' };
  }
  if (fmt.kind === 'aiff') {
    return { data: encodeAiff(buffer, fmt.bitDepth === 16 ? 16 : 24, dither), mime: 'audio/aiff' };
  }
  return { data: encodeWav(buffer, fmt.bitDepth, dither), mime: 'audio/wav' };
}

/** Apply a static gain to a buffer (returns a new buffer). */
function applyGain(buffer: AudioBuffer, gain: number): AudioBuffer {
  if (gain === 1) return buffer;
  const out = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) {
      const v = src[i] * gain;
      dst[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return out;
}

/**
 * Render through the mastering chain and match integrated loudness (BS.1770-4)
 * to a target while respecting the true-peak ceiling.
 *
 * Closed loop: render → measure → adjust the drive into the chain → re-render,
 * converging to within ±0.3 LU (≤5 passes). Extra loudness comes from feeding
 * more level through the limiter — never from a static post-gain that would clip.
 */
export async function renderMaster(
  buffer: AudioBuffer,
  opts: {
    processing?: ProcessingParams;
    targetPeakDb: number;
    targetLufs?: number;
    onProgress?: (label: string, pct: number) => void;
  },
): Promise<{ buffer: AudioBuffer; report: MasterReport }> {
  const { processing, targetPeakDb, targetLufs, onProgress } = opts;
  const ceilingLin = Math.pow(10, targetPeakDb / 20);

  const renderAt = (driveDb: number) =>
    processing
      ? renderProcessed(buffer, { ...processing, inputGain: processing.inputGain + driveDb })
      : Promise.resolve(applyGain(buffer, Math.pow(10, driveDb / 20)));

  // --- No loudness target: render once, normalise true peak to the ceiling ---
  if (targetLufs === undefined) {
    onProgress?.('Rendering', 20);
    let out = processing ? await renderProcessed(buffer, processing) : buffer;
    const { truePeak } = measureTruePeak(out);
    if (Number.isFinite(truePeak)) {
      out = applyGain(out, ceilingLin / Math.pow(10, truePeak / 20));
    }
    const lufs = measureIntegratedLoudness(out);
    const tp = measureTruePeak(out).truePeak;
    onProgress?.('Rendering', 100);
    return {
      buffer: out,
      report: {
        integratedLufs: round1(lufs), truePeakDb: round1(tp),
        targetLufs: null, targetPeakDb, driveDb: 0, iterations: 1, onTarget: true,
      },
    };
  }

  // --- Loudness target: iterate ---
  const TOL = 0.3;
  const MAX_ITERS = 5;
  let drive = 0;
  let prevErr = Infinity;
  let best: { buf: AudioBuffer; lufs: number; tp: number; err: number; drive: number } | null = null;

  for (let i = 0; i < MAX_ITERS; i++) {
    onProgress?.('Matching loudness', Math.round(((i + 0.5) / MAX_ITERS) * 100));
    const buf = await renderAt(drive);
    const lufs = measureIntegratedLoudness(buf);
    const { truePeak: tp } = measureTruePeak(buf);
    const err = Number.isFinite(lufs) ? targetLufs - lufs : 0; // + = too quiet

    if (!best || Math.abs(err) < Math.abs(best.err)) best = { buf, lufs, tp, err, drive };
    if (Math.abs(err) <= TOL) break;

    // Loudness-saturated: pushing more drive stopped moving LUFS meaningfully.
    if (i > 0 && err > 0 && prevErr - err < 0.1 && err - prevErr < 0.1) break;

    // Damped step, clamped so one iteration can't overshoot wildly.
    drive += Math.max(-6, Math.min(6, err * 0.9));
    prevErr = err;
  }

  let out = best!.buf;
  let { lufs, tp } = best!;

  // Safety net — the limiter should already guarantee this, but never ship over ceiling.
  if (tp > targetPeakDb + 0.05) {
    out = applyGain(out, ceilingLin / Math.pow(10, tp / 20));
    lufs = measureIntegratedLoudness(out);
    tp = measureTruePeak(out).truePeak;
  }

  const onTarget = Math.abs(targetLufs - lufs) <= TOL + 0.05;
  onProgress?.('Matching loudness', 100);
  return {
    buffer: out,
    report: {
      integratedLufs: round1(lufs),
      truePeakDb: round1(tp),
      targetLufs,
      targetPeakDb,
      driveDb: round1(best!.drive),
      iterations: Math.min(MAX_ITERS, (best!.drive === 0 ? 1 : Math.abs(Math.round(best!.drive)) + 1)),
      onTarget,
      note: onTarget
        ? undefined
        : lufs < targetLufs
          ? `Chain reached ${round1(lufs)} LUFS — ${round1(targetLufs - lufs)} LU short of target (material/limiter saturated). Push the limiter or add drive for more.`
          : `Landed ${round1(lufs - targetLufs)} LU over target.`,
    },
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Export audio to selected formats, returns a ZIP blob if multiple or single WAV
 */
export async function exportAudio(
  buffer: AudioBuffer,
  options: ExportOptions
): Promise<{ blob: Blob; filename: string; report: MasterReport }> {
  const { formats, filename, targetPeakDb, targetLufs, processing, dither = 'tpdf', onProgress } = options;
  const baseName = filename.replace(/\.[^.]+$/, '');

  // Render through the full mastering chain + closed-loop loudness / true-peak matching
  onProgress?.('Rendering', 0);
  const { buffer: rendered, report } = await renderMaster(buffer, {
    processing, targetPeakDb, targetLufs, onProgress,
  });
  onProgress?.('Rendering', 100);

  // Optional sample-rate conversion, shared by every format.
  const master = options.sampleRate
    ? await resampleBuffer(rendered, options.sampleRate)
    : rendered;

  const ids = formats.filter((id) => FORMAT_MAP[id]);
  if (ids.length === 0) ids.push('wav24');

  if (ids.length === 1) {
    const fmt = FORMAT_MAP[ids[0]];
    onProgress?.(fmt.id, 0);
    const { data, mime } = await encodeFormat(master, fmt, dither);
    onProgress?.(fmt.id, 100);
    return {
      blob: new Blob([data], { type: mime }),
      filename: `${baseName}_master.${fmt.extension}`,
      report,
    };
  }

  // Multiple formats → ZIP
  const zip = new JSZip();
  for (const id of ids) {
    const fmt = FORMAT_MAP[id];
    onProgress?.(fmt.id, 0);
    try {
      const { data } = await encodeFormat(master, fmt, dither);
      zip.file(`${baseName}_${fmt.suffix}.${fmt.extension}`, data);
    } catch (e) {
      console.error(`[export] ${fmt.id} failed, falling back to WAV`, e);
      zip.file(`${baseName}_${fmt.suffix}_FALLBACK.wav`, encodeWav(master, 24, dither));
    }
    onProgress?.(fmt.id, 100);
  }

  zip.file('_MASTER_REPORT.txt', formatReport(report, baseName));

  onProgress?.('ZIP', 0);
  const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta) => {
    onProgress?.('ZIP', Math.round(meta.percent));
  });
  onProgress?.('ZIP', 100);

  return {
    blob: zipBlob,
    filename: `${baseName}_masters.zip`,
    report,
  };
}

/** Human-readable delivery report bundled with a ZIP export. */
function formatReport(r: MasterReport, name: string): string {
  const lines = [
    `MasteringPro — master report`,
    `Track: ${name}`,
    `Date:  ${new Date().toISOString()}`,
    ``,
    `Integrated loudness : ${r.integratedLufs.toFixed(1)} LUFS  (BS.1770-4, gated)`,
    `True peak            : ${r.truePeakDb.toFixed(1)} dBTP`,
  ];
  if (r.targetLufs !== null) {
    lines.push(
      `Target              : ${r.targetLufs.toFixed(1)} LUFS / ${r.targetPeakDb.toFixed(1)} dBTP`,
      `On target           : ${r.onTarget ? 'yes (±0.3 LU)' : 'no'}`,
      `Loudness passes      : ${r.iterations}`,
      `Drive into chain     : ${r.driveDb >= 0 ? '+' : ''}${r.driveDb.toFixed(1)} dB`,
    );
  }
  if (r.note) lines.push(``, `Note: ${r.note}`);
  return lines.join('\n') + '\n';
}

/**
 * Trigger browser download
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
