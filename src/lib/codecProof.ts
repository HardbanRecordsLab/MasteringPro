/**
 * Codec-proof master.
 *
 * Every lossy codec moves inter-sample peaks: with the MP3 encoder we ship a master at −1.0 dBTP measured as high as −0.05 dBTP
 * after decoding. Streaming services re-encode what they receive (AAC, Opus, MP3), so a master that is clean as a WAV can clip on
 * the listener's side. This takes the worst overshoot of all codecs we can run in the browser off the master, so the file the user
 * delivers stays under the ceiling after any of them.
 *
 * Encoding a whole track several times is slow (MP3 ≈ 12× real time, the true-peak meter ≈ 3 s per minute), so the codecs are
 * measured on the loudest passages only - where the limiter works hardest and the overshoot is largest. That is an estimate, and
 * the report says so; the lossy export itself (`encodeWithinCeiling`) still verifies the real file.
 */
import { codecTruePeaks, type CodecResult } from '@/lib/delivery';
import { applyGain } from '@/lib/gain';

/** Sample ranges [start, end) of the `count` loudest, non-overlapping windows, plus the window around the highest sample peak. */
export function loudestRanges(channels: Float32Array[], sampleRate: number, windowSec = 6, count = 3): Array<[number, number]> {
  const n = channels[0]?.length ?? 0;
  const win = Math.min(n, Math.max(1, Math.round(windowSec * sampleRate)));
  if (n === 0) return [];
  if (n <= win) return [[0, n]];
  const block = Math.max(1, Math.round(0.5 * sampleRate));
  const blocks = Math.ceil(n / block);
  const energy = new Float64Array(blocks);
  let peakAt = 0, peakVal = 0;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      energy[(i / block) | 0] += v * v;
      const a = v < 0 ? -v : v;
      if (a > peakVal) { peakVal = a; peakAt = i; }
    }
  }
  const per = Math.max(1, Math.round(win / block));
  const prefix = new Float64Array(blocks + 1);
  for (let b = 0; b < blocks; b++) prefix[b + 1] = prefix[b] + energy[b];
  const scored: Array<{ b: number; e: number }> = [];
  for (let b = 0; b + per <= blocks; b++) scored.push({ b, e: prefix[b + per] - prefix[b] });
  scored.sort((x, y) => y.e - x.e);

  const picked: Array<[number, number]> = [];
  const free = (s: number, e: number) => picked.every(([ps, pe]) => e <= ps || s >= pe);
  const clamp = (s: number): [number, number] => { const st = Math.max(0, Math.min(n - win, s)); return [st, st + win]; };
  const peakWin = clamp(peakAt - (win >> 1));
  picked.push(peakWin);
  for (const { b } of scored) {
    if (picked.length >= count) break;
    const r = clamp(b * block);
    if (free(r[0], r[1])) picked.push(r);
  }
  return picked.sort((a, b) => a[0] - b[0]);
}

function slice(buffer: AudioBuffer, [start, end]: [number, number], fadeMs = 50): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: end - start, sampleRate: buffer.sampleRate });
  const fade = Math.min((end - start) >> 1, Math.round((fadeMs / 1000) * buffer.sampleRate));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    d.set(buffer.getChannelData(c).subarray(start, end));
    for (let i = 0; i < fade; i++) { const g = i / fade; d[i] *= g; d[d.length - 1 - i] *= g; }   // no new peaks from the cut edges
  }
  return out;
}

/** Worst true peak per codec over the loudest passages of the master. */
export async function measureCodecsOnLoudest(buffer: AudioBuffer, onProgress?: (label: string) => void): Promise<CodecResult[]> {
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const ranges = loudestRanges(chans, buffer.sampleRate);
  let merged: CodecResult[] | null = null;
  for (const r of ranges) {
    const res = await codecTruePeaks(slice(buffer, r), onProgress);
    if (!merged) { merged = res; continue; }
    merged = merged.map((m, i) => {
      const x = res[i];
      if (!x.available || x.truePeak === null) return m;
      if (!m.available || m.truePeak === null) return x;
      return x.truePeak > m.truePeak ? x : m;
    });
  }
  return merged ?? [];
}

export interface CodecProof {
  buffer: AudioBuffer;
  /** level taken off the master (dB, >= 0) */
  trimDb: number;
  passes: number;
  /** every codec that could be run is at or under the ceiling */
  verified: boolean;
  ceilingDb: number;
  /** what each codec measured on the final master (null = not available in this browser) */
  codecs: Array<{ id: string; label: string; truePeakDb: number | null }>;
  /** the codec with the highest decoded true peak, null when none could run */
  worst: { id: string; label: string; truePeakDb: number } | null;
}

export async function codecProofMaster(
  master: AudioBuffer,
  ceilingDb: number,
  {
    measure = measureCodecsOnLoudest,
    scale = applyGain,
    marginDb = 0.1,
    maxPasses = 3,
    onProgress,
  }: {
    measure?: (b: AudioBuffer, onProgress?: (label: string) => void) => Promise<CodecResult[]>;
    scale?: (b: AudioBuffer, gain: number) => AudioBuffer;
    marginDb?: number;
    maxPasses?: number;
    onProgress?: (label: string) => void;
  } = {},
): Promise<CodecProof> {
  let buf = master;
  let trimDb = 0;
  for (let pass = 1; ; pass++) {
    const codecs = await measure(buf, onProgress);
    const ran = codecs.filter((c) => c.available && c.truePeak !== null && Number.isFinite(c.truePeak));
    const summary = codecs.map((c) => ({ id: c.id, label: c.label, truePeakDb: c.available ? c.truePeak : null }));
    if (ran.length === 0) return { buffer: master, trimDb: 0, passes: pass, verified: false, ceilingDb, codecs: summary, worst: null };
    const worstC = ran.reduce((a, c) => ((c.truePeak as number) > (a.truePeak as number) ? c : a));
    const worst = { id: worstC.id, label: worstC.label, truePeakDb: worstC.truePeak as number };
    const fits = worst.truePeakDb <= ceilingDb;
    if (fits || pass >= maxPasses) return { buffer: buf, trimDb, passes: pass, verified: fits, ceilingDb, codecs: summary, worst };
    const cut = worst.truePeakDb - ceilingDb + marginDb;
    trimDb += cut;
    buf = scale(buf, Math.pow(10, -cut / 20));
  }
}
