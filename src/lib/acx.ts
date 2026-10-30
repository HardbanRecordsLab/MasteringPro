/**
 * Audiobook (ACX) compliance: measure a narration file against the rules ACX / Audible apply to submissions, and repair it.
 *
 * The limits below are ACX's published audio requirements as we know them (check them against acx.com/help before relying on them for
 * a submission, ACX can change them):
 *   - overall RMS level between -23 dB and -18 dB (whole file, silence included, the way ACX's own checker measures it)
 *   - sample peak no higher than -3 dB
 *   - noise floor (the quietest passage) no higher than -60 dB RMS
 *   - room tone: 0.5 to 1 s of silence at the start, 1 to 5 s at the end
 *   - delivered as 192 kbps (or higher) constant-bit-rate MP3 at 44.1 kHz
 * Everything works on plain channel arrays so it can be tested on the real code, with no browser.
 */
import { restoreChannels } from '@/lib/dsp/restore';
import { measureIntegratedLoudness } from '@/lib/loudness';

export const ACX = {
  rmsMinDb: -23, rmsMaxDb: -18, rmsTargetDb: -20.5,
  peakMaxDb: -3, peakTargetDb: -3.4,
  noiseFloorMaxDb: -60,
  headMinS: 0.5, headMaxS: 1.0, headTargetS: 0.75,
  tailMinS: 1.0, tailMaxS: 5.0, tailTargetS: 2.0,
  sampleRate: 44100, mp3Kbps: 192,
} as const;

const toDb = (x: number) => 20 * Math.log10(x + 1e-12);

export interface AcxMeasure {
  /** overall RMS of the whole file in dBFS (power averaged over all channels) */
  rmsDb: number;
  /** highest absolute sample, dBFS */
  peakDb: number;
  /** RMS of the quietest 500 ms, dBFS (null for files shorter than that) */
  noiseFloorDb: number | null;
  /** silence before the first sound / after the last sound, seconds */
  headS: number;
  tailS: number;
  durationS: number;
  /** where the quietest 500 ms starts (sample index), the source of room tone */
  quietStart: number;
}

const FRAME_S = 0.05;

function frameRms(channels: Float32Array[], sr: number): Float64Array {
  const n = channels[0].length;
  const hop = Math.max(1, Math.round(FRAME_S * sr));
  const frames = Math.max(1, Math.floor(n / hop));
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (const ch of channels) for (let i = f * hop, e = Math.min(n, i + hop); i < e; i++) s += ch[i] * ch[i];
    out[f] = Math.sqrt(s / (hop * channels.length));
  }
  return out;
}

export function measureAcx(channels: Float32Array[], sr: number): AcxMeasure {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return { rmsDb: -120, peakDb: -120, noiseFloorDb: null, headS: 0, tailS: 0, durationS: 0, quietStart: 0 };
  let sum = 0, peak = 0;
  for (const ch of channels) for (let i = 0; i < n; i++) { const v = ch[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / (n * channels.length));

  const fr = frameRms(channels, sr);
  const win = Math.round(0.5 / FRAME_S);                         // 10 frames = 500 ms
  let noiseFloorDb: number | null = null, quietStart = 0;
  if (fr.length >= win) {
    let best = Infinity, bestAt = 0, acc = 0;
    for (let f = 0; f < fr.length; f++) {
      acc += fr[f] * fr[f];
      if (f >= win) acc -= fr[f - win] * fr[f - win];
      if (f >= win - 1) { const m = acc / win; if (m < best) { best = m; bestAt = f - win + 1; } }
    }
    noiseFloorDb = toDb(Math.sqrt(best));
    quietStart = Math.round(bestAt * FRAME_S * sr);
  }
  // "sound" = a frame 10 dB above the noise floor (and not below -55 dBFS): robust to a noisy room, and to a silent one
  const gate = Math.max(noiseFloorDb !== null ? Math.pow(10, (noiseFloorDb + 10) / 20) : 0, Math.pow(10, -55 / 20));
  let first = fr.findIndex((v) => v > gate);
  let last = -1;
  for (let f = fr.length - 1; f >= 0; f--) if (fr[f] > gate) { last = f; break; }
  if (first < 0) { first = fr.length; last = fr.length - 1; }
  return {
    rmsDb: toDb(rms), peakDb: toDb(peak), noiseFloorDb, durationS: n / sr, quietStart,
    headS: first * FRAME_S, tailS: (fr.length - 1 - last) * FRAME_S + (n - fr.length * Math.round(FRAME_S * sr)) / sr,
  };
}

export type Level = 'pass' | 'fail' | 'warn';
export interface AcxCheck { id: string; label: string; level: Level; value: string; requirement: string; fix?: string }

const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

export function acxChecks(m: AcxMeasure, file?: { sampleRate: number; channels: number }): AcxCheck[] {
  const out: AcxCheck[] = [];
  const rmsOk = m.rmsDb >= ACX.rmsMinDb && m.rmsDb <= ACX.rmsMaxDb;
  out.push({ id: 'rms', label: 'Overall level (RMS)', level: rmsOk ? 'pass' : 'fail', value: `${f1(m.rmsDb)} dB`, requirement: `${ACX.rmsMinDb} to ${ACX.rmsMaxDb} dB`,
    fix: rmsOk ? undefined : m.rmsDb < ACX.rmsMinDb ? 'Raise the level; peaks are limited so they stay under -3 dB.' : 'Lower the level.' });
  const peakOk = m.peakDb <= ACX.peakMaxDb;
  out.push({ id: 'peak', label: 'Peak', level: peakOk ? 'pass' : 'fail', value: `${f1(m.peakDb)} dB`, requirement: `at most ${ACX.peakMaxDb} dB`,
    fix: peakOk ? undefined : 'Limit the peaks below -3 dB.' });
  if (m.noiseFloorDb === null) {
    out.push({ id: 'noise', label: 'Noise floor', level: 'warn', value: 'n/a', requirement: `at most ${ACX.noiseFloorMaxDb} dB RMS`, fix: 'The file is shorter than 0.5 s.' });
  } else {
    const ok = m.noiseFloorDb <= ACX.noiseFloorMaxDb;
    out.push({ id: 'noise', label: 'Noise floor', level: ok ? 'pass' : 'fail', value: `${f1(m.noiseFloorDb)} dB`, requirement: `at most ${ACX.noiseFloorMaxDb} dB RMS`,
      fix: ok ? undefined : 'Reduce the noise (noise reduction), or record in a quieter room.' });
  }
  const headOk = m.headS >= ACX.headMinS && m.headS <= ACX.headMaxS;
  out.push({ id: 'head', label: 'Room tone at the start', level: headOk ? 'pass' : 'fail', value: `${m.headS.toFixed(2)} s`, requirement: `${ACX.headMinS} to ${ACX.headMaxS} s`,
    fix: headOk ? undefined : m.headS < ACX.headMinS ? 'Add room tone before the first word.' : 'Trim the silence at the start.' });
  const tailOk = m.tailS >= ACX.tailMinS && m.tailS <= ACX.tailMaxS;
  out.push({ id: 'tail', label: 'Room tone at the end', level: tailOk ? 'pass' : 'fail', value: `${m.tailS.toFixed(2)} s`, requirement: `${ACX.tailMinS} to ${ACX.tailMaxS} s`,
    fix: tailOk ? undefined : m.tailS < ACX.tailMinS ? 'Add room tone after the last word.' : 'Trim the silence at the end.' });
  if (file) {
    out.push({ id: 'format', label: 'Delivery format', level: file.sampleRate === ACX.sampleRate ? 'pass' : 'warn', value: `${file.sampleRate} Hz, ${file.channels === 1 ? 'mono' : 'stereo'}`,
      requirement: `${ACX.mp3Kbps} kbps CBR MP3 at ${ACX.sampleRate} Hz`, fix: file.sampleRate === ACX.sampleRate ? undefined : 'The export converts to 44.1 kHz and encodes the MP3.' });
  }
  return out;
}

// ───────────────────────────── repair ─────────────────────────────
/** Look-ahead peak limiter: never lets a sample exceed `ceiling` (linear); gain recovers smoothly after a peak. */
export function limitPeaks(channels: Float32Array[], sr: number, ceiling: number, lookaheadMs = 5, releaseMs = 60): Float32Array[] {
  const n = channels[0].length;
  const la = Math.max(1, Math.round((lookaheadMs / 1000) * sr));
  const need = new Float32Array(n);                                   // gain each sample needs on its own
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > p) p = a; }
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // gain must already be low `la` samples BEFORE a peak: running minimum over the next la samples (van Herk, O(n))
  const mins = new Float32Array(n);
  const q: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (q.length && need[q[q.length - 1]] >= need[i]) q.pop();
    q.push(i);
    while (q[0] > i + la) q.shift();
    mins[i] = need[q[0]];
  }
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
  const out = channels.map(() => new Float32Array(n));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const target = mins[i];
    g = target < g ? target : target + (g - target) * rel;           // jump down at once (we are early), come back up slowly
    for (let c = 0; c < channels.length; c++) {
      const v = channels[c][i] * g;
      out[c][i] = v > ceiling ? ceiling : v < -ceiling ? -ceiling : v;   // the smoothing makes this a no-op; it is the guarantee
    }
  }
  return out;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);

/** `len` samples of room tone taken from the quietest passage, repeated with short crossfades so there is no click at the joins. */
function roomTone(channels: Float32Array[], sr: number, quietStart: number, len: number): Float32Array[] {
  const seg = Math.min(Math.round(0.4 * sr), channels[0].length - quietStart);
  const fade = Math.max(1, Math.round(0.02 * sr));
  return channels.map((ch) => {
    const out = new Float32Array(len);
    const src = ch.subarray(quietStart, quietStart + seg);
    if (src.length < 2) return out;
    const step = Math.max(1, src.length - fade);
    for (let pos = 0; pos < len; pos += step) {
      for (let i = 0; i < src.length && pos + i < len; i++) {
        const w = i < fade && pos > 0 ? i / fade : 1;
        out[pos + i] = out[pos + i] * (1 - w) + src[i] * w;
      }
    }
    return out;
  });
}

export interface AcxFixReport {
  before: AcxMeasure;
  after: AcxMeasure;
  steps: string[];
  denoiseDb: number;
  gainDb: number;
}

export interface AcxFixOptions { mono?: boolean }

export function fixForAcx(input: Float32Array[], sr: number, opts: AcxFixOptions = {}): { channels: Float32Array[]; report: AcxFixReport } {
  const before = measureAcx(input, sr);
  const steps: string[] = [];
  let chans = input.map((c) => Float32Array.from(c));
  if (opts.mono && chans.length > 1) {
    const m = new Float32Array(chans[0].length);
    for (const c of chans) for (let i = 0; i < m.length; i++) m[i] += c[i] / chans.length;
    chans = [m];
    steps.push('Mixed down to mono.');
  }

  // 1) noise: the limit is on the FINISHED file, and the level step below raises the noise with everything else, so the noise floor is
  //    judged after the gain it will get. Only when it would still be above the limit (with margin: the denoiser never lands exactly).
  let denoiseDb = 0;
  const m0 = measureAcx(chans, sr);
  if (m0.noiseFloorDb !== null) {
    const floorAfterGain = m0.noiseFloorDb + (ACX.rmsTargetDb - m0.rmsDb);
    if (floorAfterGain > ACX.noiseFloorMaxDb - 2) {
      denoiseDb = Math.min(30, Math.max(6, Math.ceil(floorAfterGain - (ACX.noiseFloorMaxDb - 4))));
      chans = restoreChannels(chans, sr, { denoise: { enabled: true, reductionDb: denoiseDb, sensitivity: 0.5, smoothing: 0.5 }, peakTargetDb: -1 }).channels;
      steps.push(`Noise reduction ${denoiseDb} dB.`);
    }
  }

  // 2) level: bring the RMS to the middle of the window, limit the peaks under -3 dB, and re-aim because the limiter takes level away
  let gainDb = 0;
  const ceiling = dbToLin(ACX.peakTargetDb);
  for (let pass = 0; pass < 4; pass++) {
    const cur = measureAcx(chans, sr);
    const delta = ACX.rmsTargetDb - cur.rmsDb;
    if (pass > 0 && Math.abs(delta) < 0.25 && cur.peakDb <= ACX.peakMaxDb) break;
    const g = dbToLin(delta);
    gainDb += delta;
    chans = limitPeaks(chans.map((c) => c.map((v) => v * g)), sr, ceiling);
  }
  steps.push(`Level set to ${ACX.rmsTargetDb} dB RMS (${gainDb >= 0 ? '+' : ''}${(Math.round(gainDb * 10) / 10).toFixed(1)} dB), peaks limited under ${ACX.peakMaxDb} dB.`);

  // 3) room tone at both ends (taken from the quietest passage of the repaired file)
  const now = measureAcx(chans, sr);
  const head = Math.round((now.headS >= ACX.headMinS && now.headS <= ACX.headMaxS ? now.headS : ACX.headTargetS) * sr);
  const tail = Math.round((now.tailS >= ACX.tailMinS && now.tailS <= ACX.tailMaxS ? now.tailS : ACX.tailTargetS) * sr);
  const curHead = Math.round(now.headS * sr), curTail = Math.round(now.tailS * sr);
  if (head !== curHead || tail !== curTail) {
    const n = chans[0].length;
    const startCut = Math.max(0, curHead - head);                    // silence to remove (when there is too much)
    const endCut = Math.max(0, curTail - tail);
    const padHead = Math.max(0, head - curHead), padTail = Math.max(0, tail - curTail);
    const tone = roomTone(chans, sr, now.quietStart, padHead + padTail + 1);
    chans = chans.map((c, k) => {
      const body = c.subarray(startCut, n - endCut);
      const out = new Float32Array(padHead + body.length + padTail);
      out.set(tone[k].subarray(0, padHead), 0);
      out.set(body, padHead);
      out.set(tone[k].subarray(padHead, padHead + padTail), padHead + body.length);
      return out;
    });
    steps.push(`Room tone: ${(head / sr).toFixed(2)} s at the start, ${(tail / sr).toFixed(2)} s at the end.`);
  }
  return { channels: chans, report: { before, after: measureAcx(chans, sr), steps, denoiseDb, gainDb } };
}

// ───────────────────────────── podcast ─────────────────────────────

/** Just enough of an AudioBuffer for the loudness meter, so plain channel arrays can be measured (and tested) without a browser. */
const asBuffer = (channels: Float32Array[], sr: number) =>
  ({ sampleRate: sr, length: channels[0].length, numberOfChannels: channels.length, duration: channels[0].length / sr, getChannelData: (c: number) => channels[c] }) as unknown as AudioBuffer;

export const PODCAST = { lufs: -16, ceilingDb: -1.5 } as const;

export interface PodcastReport { beforeLufs: number; afterLufs: number; gainDb: number; peakDb: number; steps: string[]; reached: boolean }

/**
 * Podcast loudness: bring the episode to the target integrated loudness (BS.1770-4) with the peaks held under `ceilingDb` by a look-ahead
 * limiter. Speech has a high crest factor, so a plain gain would push the plosives over the ceiling; the loop re-aims after the limiter
 * has taken level away, and says so when the material cannot reach the target without destroying it.
 */
export function fixForPodcast(input: Float32Array[], sr: number, opts: { mono?: boolean; targetLufs?: number; ceilingDb?: number } = {}): { channels: Float32Array[]; report: PodcastReport } {
  // the limiter works half a dB below the ceiling the delivered MP3 must keep: encoding adds a little peak, and trimming it afterwards would cost loudness
  const target = opts.targetLufs ?? PODCAST.lufs, ceilingDb = opts.ceilingDb ?? PODCAST.ceilingDb - 0.5;
  const steps: string[] = [];
  let chans = input.map((c) => Float32Array.from(c));
  if (opts.mono && chans.length > 1) {
    const m = new Float32Array(chans[0].length);
    for (const c of chans) for (let i = 0; i < m.length; i++) m[i] += c[i] / chans.length;
    chans = [m];
    steps.push('Mixed down to mono.');
  }
  const beforeLufs = measureIntegratedLoudness(asBuffer(chans, sr));
  const ceiling = dbToLin(ceilingDb);
  let gainDb = 0;
  const silent = !Number.isFinite(beforeLufs) || beforeLufs <= -69.5;          // the meter floors silence at -70 LUFS
  if (!silent) {
    for (let pass = 0; pass < 5; pass++) {
      const cur = measureIntegratedLoudness(asBuffer(chans, sr));
      const delta = target - cur;
      if (Math.abs(delta) < 0.15) break;
      gainDb += delta;
      const g = dbToLin(delta);
      chans = limitPeaks(chans.map((c) => c.map((v) => v * g)), sr, ceiling);
    }
  }
  const afterLufs = measureIntegratedLoudness(asBuffer(chans, sr));
  let pk = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > pk) pk = a; }
  const reached = !silent && Number.isFinite(afterLufs) && Math.abs(afterLufs - target) <= 0.5;
  steps.push(!silent
    ? `Loudness ${beforeLufs.toFixed(1)} → ${afterLufs.toFixed(1)} LUFS (target ${target}), peaks under ${ceilingDb} dB.`
    : 'The file is silent; nothing to level.');
  if (!silent && !reached) steps.push('The material could not reach the target without heavy limiting; this is as loud as it gets cleanly.');
  return { channels: chans, report: { beforeLufs, afterLufs, gainDb, peakDb: toDb(pk), steps, reached } };
}
