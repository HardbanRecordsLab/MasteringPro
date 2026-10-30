import { quantizeChannels, type DitherMode } from '@/lib/quantize';
import { tagAiff, tagFlac, tagMp3, tagWav, type ReleaseMeta } from '@/lib/tags';
import { passportInput, type PassportSigner } from '@/lib/passport';
import JSZip from 'jszip';
import type { ProcessingParams } from '@/contexts/AudioContext';
import { renderProcessed } from '@/lib/offlineRender';
import { measureIntegratedLoudness, measureTruePeak } from '@/lib/loudness';
import { applyGain } from '@/lib/gain';
import { codecProofMaster, type CodecProof } from '@/lib/codecProof';

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
  /** Lossy formats only: what the DECODED file measures after the encode-and-check loop (see {@link encodeWithinCeiling}). */
  encoded?: { format: string; truePeakDb: number; trimDb: number; verified: boolean };  /** Codec-proof pass: the highest true peak after MP3 / AAC / Opus (estimated on the loudest passages) and what it cost in level. */
  codecProof?: { ceilingDb: number; trimDb: number; verified: boolean; worst: { id: string; label: string; truePeakDb: number } | null;
    codecs: Array<{ id: string; label: string; truePeakDb: number | null }> };
}

/**
 * Encode AudioBuffer to WAV ArrayBuffer
 */
export type { DitherMode };

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

  let offset = headerSize;
  if (bitDepth === 32) {
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let v = channels[c][i];
        if (!(v - v === 0)) v = 0;
        view.setFloat32(offset, Math.max(-1, Math.min(1, v)), true);
        offset += 4;
      }
    }
    return arrayBuffer;
  }
  const q = quantizeChannels(channels, bitDepth, dither);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const val = q[c][i];
      if (bitDepth === 16) {
        view.setInt16(offset, val, true);
      } else {
        view.setUint8(offset, val & 0xFF);
        view.setUint8(offset + 1, (val >> 8) & 0xFF);
        view.setUint8(offset + 2, (val >> 16) & 0xFF);
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
  const q = quantizeChannels(channels, bitDepth, dither);

  let o = 54;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = q[c][i];
      if (bitDepth === 16) {
        view.setInt16(o, v, false);
      } else {
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
  'mp3-192': { id: 'mp3-192', kind: 'mp3', bitDepth: 16, extension: 'mp3', kbps: 192, suffix: 'mp3-192' },
  'mp3-128': { id: 'mp3-128', kind: 'mp3', bitDepth: 16, extension: 'mp3', kbps: 128, suffix: 'mp3-128' },
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
  /** Release info written into the files (title, artist, album, year, ISRC…). */
  meta?: ReleaseMeta;
  /** Signs a master passport per exported file (needs an account); null = skip. */
  sign?: PassportSigner;
  /** Take off whatever level it takes so the master stays under the ceiling after MP3 / AAC / Opus transcodes. */
  codecProof?: boolean;
}

async function passportFor(sign: PassportSigner | undefined, name: string, data: ArrayBuffer | Uint8Array, fmt: ExportFormat,
  buffer: AudioBuffer, report: MasterReport, meta?: ReleaseMeta): Promise<object | null> {
  if (!sign) return null;
  try {
    const input = await passportInput({ name, data, format: fmt.id, sampleRate: buffer.sampleRate,
      bitDepth: fmt.bitDepth ?? null, channels: buffer.numberOfChannels, durationSec: buffer.duration }, report, meta);
    return await sign(input);
  } catch (e) {
    console.warn('[passport] not signed', e);
    return null;
  }
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

/** Outcome of {@link encodeWithinCeiling}. */
export interface CeilingCheck {
  data: Uint8Array;
  /** true peak of the DECODED file, null when the browser could not decode it back */
  truePeakDb: number | null;
  /** level taken off the master (dB, >= 0) to keep the decoded file under the ceiling */
  trimDb: number;
  /** encode passes used (1 = the first encode already fit) */
  passes: number;
  /** the decoded file measures at or under the ceiling (within tolerance) */
  verified: boolean;
}

/** Decode lossy bytes back with the browser's decoder (the same one players and streaming pipelines resemble). */
export async function decodeInBrowser(bytes: Uint8Array, like: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(like.numberOfChannels, 1, like.sampleRate);
  return ctx.decodeAudioData(bytes.slice().buffer);
}

/**
 * A lossy encode is not level-neutral: MP3 quantisation moves inter-sample peaks, so a master sitting at −1.0 dBTP measured up
 * to −0.4 dBTP after a 256 kbps encode (and +0.15 dB at 320 kbps) with the encoder we ship. The true-peak ceiling the user set
 * must hold for the file that is actually delivered, not for the buffer before encoding.
 *
 * So: encode, decode again, measure; if the decoded file is over the ceiling take the overshoot (plus a small margin) off the
 * master and encode again - at most `maxPasses` encodes. The 0.1 dB margin is there because true-peak meters and decoders differ by a few hundredths of a dB. When the browser cannot decode the result the file is delivered
 * as encoded and reported as unverified.
 */
export async function encodeWithinCeiling(
  master: AudioBuffer,
  ceilingDb: number,
  encode: (b: AudioBuffer) => Uint8Array | Promise<Uint8Array>,
  decode: (bytes: Uint8Array, like: AudioBuffer) => Promise<AudioBuffer> = decodeInBrowser,
  scale: (b: AudioBuffer, gain: number) => AudioBuffer = applyGain,
  { toleranceDb = 0, marginDb = 0.1, maxPasses = 3 } = {},
): Promise<CeilingCheck> {
  let buf = master;
  let trimDb = 0;
  let data = await encode(buf);
  for (let pass = 1; ; pass++) {
    let tp: number;
    try {
      tp = measureTruePeak(await decode(data, buf)).truePeak;
    } catch {
      return { data, truePeakDb: null, trimDb, passes: pass, verified: false };
    }
    if (!Number.isFinite(tp)) return { data, truePeakDb: null, trimDb, passes: pass, verified: false };
    const fits = tp <= ceilingDb + toleranceDb;
    if (fits || pass >= maxPasses) return { data, truePeakDb: tp, trimDb, passes: pass, verified: fits };
    const cut = tp - ceilingDb + marginDb;
    trimDb += cut;
    buf = scale(buf, Math.pow(10, -cut / 20));
    data = await encode(buf);
  }
}

/** Fold the outcome of the encode-and-check loop into the report the user sees (decoded true peak, loudness lost to the trim). */
export function reportEncoded(report: MasterReport, fmt: ExportFormat, check: CeilingCheck | undefined): MasterReport {
  if (!check || check.truePeakDb === null) return report;
  const lufs = report.integratedLufs - check.trimDb;
  const onTarget = report.targetLufs === null ? report.onTarget : Math.abs(lufs - report.targetLufs) <= 0.3;
  const trimmed = check.trimDb > 0.005 ? ` ${fmt.id}: ${check.trimDb.toFixed(2)} dB taken off so the decoded file stays under ${report.targetPeakDb.toFixed(1)} dBTP.` : '';
  return {
    ...report,
    integratedLufs: Math.round(lufs * 10) / 10,
    truePeakDb: Math.round(check.truePeakDb * 10) / 10,
    onTarget,
    note: [report.note, trimmed.trim()].filter(Boolean).join(' ') || undefined,
    encoded: { format: fmt.id, truePeakDb: Math.round(check.truePeakDb * 100) / 100, trimDb: Math.round(check.trimDb * 100) / 100, verified: check.verified },
  };
}

/** Fold a codec-proof pass into the report: the master got quieter by the trim, and the numbers say why. */
export function reportCodecProof(report: MasterReport, proof: CodecProof): MasterReport {
  if (!proof.worst) return report;                                   // no codec could run here: nothing was checked, nothing changes
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const lufs = report.integratedLufs - proof.trimDb;
  const trimmed = proof.trimDb > 0.005 ? `Codec-proof: ${proof.trimDb.toFixed(2)} dB taken off so ${proof.worst.label} stays under ${proof.ceilingDb.toFixed(1)} dBTP.` : '';
  return {
    ...report,
    integratedLufs: r1(lufs),
    truePeakDb: r1(report.truePeakDb - proof.trimDb),
    onTarget: report.targetLufs === null ? report.onTarget : Math.abs(lufs - report.targetLufs) <= 0.3,
    note: [report.note, trimmed].filter(Boolean).join(' ') || undefined,
    codecProof: { ceilingDb: proof.ceilingDb, trimDb: Math.round(proof.trimDb * 100) / 100, verified: proof.verified, worst: proof.worst, codecs: proof.codecs },
  };
}

/** Encode one rendered buffer to the requested container. With `ceilingDb`, an MP3 is checked after encoding (see {@link encodeWithinCeiling}). */
export async function encodeFormat(
  buffer: AudioBuffer,
  fmt: ExportFormat,
  dither: DitherMode,
  meta?: ReleaseMeta,
  ceilingDb?: number,
): Promise<{ data: ArrayBuffer | Uint8Array; mime: string; check?: CeilingCheck }> {
  if (fmt.kind === 'mp3') {
    const { encodeMp3 } = await import('@/lib/encoders/mp3');
    const encode = (b: AudioBuffer) => encodeMp3(b, fmt.kbps ?? 320);
    if (ceilingDb === undefined) return { data: tagMp3(encode(buffer), meta), mime: 'audio/mpeg' };
    const check = await encodeWithinCeiling(buffer, ceilingDb, encode);
    return { data: tagMp3(check.data, meta), mime: 'audio/mpeg', check };
  }
  if (fmt.kind === 'flac') {
    const { encodeFlac } = await import('@/lib/encoders/flac');
    return { data: tagFlac(await encodeFlac(buffer, fmt.bitDepth === 16 ? 16 : 24, dither), meta), mime: 'audio/flac' };
  }
  if (fmt.kind === 'aiff') {
    return { data: tagAiff(encodeAiff(buffer, fmt.bitDepth === 16 ? 16 : 24, dither), meta), mime: 'audio/aiff' };
  }
  return { data: tagWav(encodeWav(buffer, fmt.bitDepth, dither), meta), mime: 'audio/wav' };
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
): Promise<{ blob: Blob; filename: string; report: MasterReport; passport?: object | null }> {
  const { formats, filename, targetPeakDb, targetLufs, processing, dither = 'tpdf', onProgress, meta, sign, codecProof } = options;
  const baseName = filename.replace(/\.[^.]+$/, '');

  // Render through the full mastering chain + closed-loop loudness / true-peak matching
  onProgress?.('Rendering', 0);
  const { buffer: rendered, report: renderedReport } = await renderMaster(buffer, {
    processing, targetPeakDb, targetLufs, onProgress,
  });
  let report = renderedReport;
  onProgress?.('Rendering', 100);

  // Optional sample-rate conversion, shared by every format.
  let master = options.sampleRate
    ? await resampleBuffer(rendered, options.sampleRate)
    : rendered;

  if (codecProof) {
    onProgress?.('Codec check', 0);
    const proof = await codecProofMaster(master, targetPeakDb, { onProgress: (label) => onProgress?.(`Codec check: ${label}`, 0) });
    master = proof.buffer;
    report = reportCodecProof(report, proof);
    onProgress?.('Codec check', 100);
  }

  const ids = formats.filter((id) => FORMAT_MAP[id]);
  if (ids.length === 0) ids.push('wav24');

  if (ids.length === 1) {
    const fmt = FORMAT_MAP[ids[0]];
    onProgress?.(fmt.id, 0);
    const { data, mime, check } = await encodeFormat(master, fmt, dither, meta, targetPeakDb);
    onProgress?.(fmt.id, 100);
    const name = `${baseName}_master.${fmt.extension}`;
    const finalReport = reportEncoded(report, fmt, check);
    return {
      blob: new Blob([data], { type: mime }),
      filename: name,
      report: finalReport,
      passport: await passportFor(sign, name, data, fmt, master, finalReport, meta),
    };
  }

  // Multiple formats → ZIP
  const zip = new JSZip();
  const lossyLines: string[] = [];
  for (const id of ids) {
    const fmt = FORMAT_MAP[id];
    onProgress?.(fmt.id, 0);
    try {
      const { data, check } = await encodeFormat(master, fmt, dither, meta, targetPeakDb);
      const name = `${baseName}_${fmt.suffix}.${fmt.extension}`;
      zip.file(name, data);
      if (check) lossyLines.push(lossyLine(fmt, check, targetPeakDb));
      const pp = await passportFor(sign, name, data, fmt, master, check ? reportEncoded(report, fmt, check) : report, meta);
      if (pp) zip.file(`${name}.passport.json`, JSON.stringify(pp, null, 2));
    } catch (e) {
      console.error(`[export] ${fmt.id} failed, falling back to WAV`, e);
      zip.file(`${baseName}_${fmt.suffix}_FALLBACK.wav`, encodeWav(master, 24, dither));
    }
    onProgress?.(fmt.id, 100);
  }

  const lossyReport = lossyLines.length ? ['', 'Decoded-file check (lossy formats)', ...lossyLines, ''].join('\n') : '';
  zip.file('_MASTER_REPORT.txt', formatReport(report, baseName) + lossyReport);

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

/** A single delivery target for {@link exportAllTargets}. */
export interface DeliveryTarget {
  name: string;
  lufs: number;
  peak: number;
}

/**
 * "One master, all targets" — render the mastering chain once per platform
 * target, each loudness-matched (closed loop) to its own LUFS / true-peak
 * ceiling, and bundle them in a single ZIP with a combined delivery report.
 * The chain settings are identical across targets; only the final drive into
 * the limiter changes, so every file is the same master at the right level.
 */
export async function exportAllTargets(
  buffer: AudioBuffer,
  options: {
    targets: DeliveryTarget[];
    formatId: string;
    filename: string;
    processing: ProcessingParams;
    sampleRate?: number;
    dither?: DitherMode;
    onProgress?: (label: string, pct: number) => void;
    meta?: ReleaseMeta;
    sign?: PassportSigner;
    codecProof?: boolean;
  },
): Promise<{ blob: Blob; filename: string; reports: { name: string; report: MasterReport }[] }> {
  const { targets, formatId, filename, processing, sampleRate, dither = 'shaped', onProgress, meta, sign, codecProof } = options;
  const baseName = filename.replace(/\.[^.]+$/, '');
  const fmt = FORMAT_MAP[formatId] || FORMAT_MAP.wav24;
  const zip = new JSZip();
  const reports: { name: string; report: MasterReport }[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const slug = t.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    const span = 100 / targets.length;
    onProgress?.(t.name, Math.round(i * span));
    const { buffer: rendered, report: renderedReport } = await renderMaster(buffer, {
      processing,
      targetPeakDb: t.peak,
      targetLufs: t.lufs,
      onProgress: (_l, pct) => onProgress?.(t.name, Math.round(i * span + (pct / 100) * span)),
    });
    let master = sampleRate ? await resampleBuffer(rendered, sampleRate) : rendered;
    let report = renderedReport;
    if (codecProof) {
      const proof = await codecProofMaster(master, t.peak);
      master = proof.buffer;
      report = reportCodecProof(report, proof);
    }
    let finalReport = report;
    try {
      const { data, check } = await encodeFormat(master, fmt, dither, meta, t.peak);
      const name = `${baseName}_${slug}.${fmt.extension}`;
      zip.file(name, data);
      if (check) finalReport = reportEncoded(report, fmt, check);
      const pp = await passportFor(sign, name, data, fmt, master, finalReport, meta);
      if (pp) zip.file(`${name}.passport.json`, JSON.stringify(pp, null, 2));
    } catch (e) {
      console.error(`[exportAllTargets] ${t.name} ${fmt.id} failed, WAV fallback`, e);
      zip.file(`${baseName}_${slug}_FALLBACK.wav`, encodeWav(master, 24, dither));
    }
    reports.push({ name: t.name, report: finalReport });
  }

  zip.file(
    '_DELIVERY_REPORT.txt',
    reports
      .map(({ name, report }) => formatReport(report, `${baseName} — ${name}`))
      .join(`\n\n${'='.repeat(60)}\n\n`),
  );

  onProgress?.('ZIP', 0);
  const blob = await zip.generateAsync({ type: 'blob' }, (m) => onProgress?.('ZIP', Math.round(m.percent)));
  onProgress?.('ZIP', 100);
  return { blob, filename: `${baseName}_all-targets.zip`, reports };
}

function lossyLine(fmt: ExportFormat, c: CeilingCheck, ceilingDb: number): string {
  if (c.truePeakDb === null) return `${fmt.id}: could not be decoded back here, true peak not verified`;
  return `${fmt.id}: decoded true peak ${c.truePeakDb.toFixed(2)} dBTP (ceiling ${ceilingDb.toFixed(1)})` +
    (c.trimDb > 0.005 ? `, ${c.trimDb.toFixed(2)} dB taken off the master (${c.passes} encodes)` : ', no trim needed') + (c.verified ? '' : ', STILL OVER the ceiling');
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
  if (r.codecProof) {
    const c = r.codecProof;
    lines.push(
      ``,
      `Codec-proof check (loudest passages; ceiling ${c.ceilingDb.toFixed(1)} dBTP)`,
      ...c.codecs.map((x) => `  ${x.label}: ${x.truePeakDb === null ? 'not available in this browser' : `${x.truePeakDb.toFixed(2)} dBTP after decoding`}`),
      `  Level taken off for it: ${c.trimDb.toFixed(2)} dB${c.verified ? '' : ' (STILL OVER the ceiling)'}`,
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
