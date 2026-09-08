/**
 * ITU-R BS.1770-4 compliant loudness measurement + true peak (4x oversampling).
 *
 * - K-weighting (stage 1 high shelf + stage 2 RLB high-pass), sample-rate aware
 * - Gated integrated loudness (400 ms blocks, 75% overlap, -70 LUFS absolute gate,
 *   -10 LU relative gate)
 * - Short-term (3 s) / momentary (400 ms) loudness series
 * - EBU R128 Loudness Range (LRA): 3 s blocks / 1 s hop, -20 LU relative gate,
 *   10th..95th percentile
 * - True peak via 4x zero-stuffed polyphase windowed-sinc interpolation (dBTP)
 */

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** Stage 1 of K-weighting: high shelf, f0 = 1681.97 Hz, G = +3.999 dB, Q = 0.7071 */
function kHighShelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;

  const K = Math.tan(Math.PI * f0 / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;

  return {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

/** Stage 2 of K-weighting: RLB high-pass, f0 = 38.13 Hz, Q = 0.5003 */
function kHighPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;

  const K = Math.tan(Math.PI * f0 / sampleRate);
  const a0 = 1 + K / Q + K * K;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

function applyBiquad(input: Float32Array, f: Biquad, out: Float32Array): Float32Array {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

/** ITU-R BS.1770 channel weights: L, R = 1.0; C = 1.0; Ls, Rs = 1.41 */
function channelWeight(index: number, channels: number): number {
  if (channels <= 2) return 1.0;
  if (channels >= 5 && (index === 3 || index === 4)) return 1.41;
  return 1.0;
}

function kWeightChannels(buffer: AudioBuffer): Float32Array[] {
  const sr = buffer.sampleRate;
  const shelf = kHighShelf(sr);
  const hp = kHighPass(sr);
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const tmp = new Float32Array(src.length);
    applyBiquad(src, shelf, tmp);
    const res = new Float32Array(src.length);
    applyBiquad(tmp, hp, res);
    out.push(res);
  }
  return out;
}

/**
 * Mean square per block for the weighted sum of channels.
 * Returns array of block mean-square values (already channel-weighted & summed).
 */
function blockMeanSquares(
  weighted: Float32Array[],
  channels: number,
  blockSamples: number,
  hopSamples: number,
): number[] {
  const length = weighted[0]?.length ?? 0;
  const result: number[] = [];
  if (length < blockSamples) return result;

  // Prefix sums of squares per channel for O(1) block energy.
  const prefixes: Float64Array[] = weighted.map((data) => {
    const p = new Float64Array(data.length + 1);
    for (let i = 0; i < data.length; i++) p[i + 1] = p[i] + data[i] * data[i];
    return p;
  });

  for (let start = 0; start + blockSamples <= length; start += hopSamples) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const energy = prefixes[c][start + blockSamples] - prefixes[c][start];
      sum += channelWeight(c, channels) * (energy / blockSamples);
    }
    result.push(sum);
  }
  return result;
}

const loudnessFromMs = (ms: number) => -0.691 + 10 * Math.log10(ms || 1e-12);

export interface LoudnessResult {
  integrated: number;      // LUFS (gated, BS.1770-4)
  lra: number;             // LU (EBU R128)
  shortTermMax: number;    // LUFS (3 s)
  momentaryMax: number;    // LUFS (400 ms)
  truePeak: number;        // dBTP (4x oversampled)
  samplePeak: number;      // dBFS
}

/** Gated integrated loudness per BS.1770-4. */
export function measureIntegratedLoudness(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate;
  const weighted = kWeightChannels(buffer);
  const channels = buffer.numberOfChannels;
  const block = Math.round(sr * 0.4);
  const hop = Math.round(sr * 0.1); // 75% overlap
  const ms = blockMeanSquares(weighted, channels, block, hop);
  return gatedLoudness(ms);
}

function gatedLoudness(blockMs: number[]): number {
  if (blockMs.length === 0) return -70;

  // Absolute gate at -70 LUFS
  const absolute = blockMs.filter((m) => loudnessFromMs(m) > -70);
  if (absolute.length === 0) return -70;

  const meanAbs = absolute.reduce((s, v) => s + v, 0) / absolute.length;
  const relativeThreshold = loudnessFromMs(meanAbs) - 10;

  const gated = absolute.filter((m) => loudnessFromMs(m) > relativeThreshold);
  if (gated.length === 0) return -70;

  const meanGated = gated.reduce((s, v) => s + v, 0) / gated.length;
  return loudnessFromMs(meanGated);
}

/** EBU R128 Loudness Range from 3 s / 1 s short-term blocks. */
function computeLRA(shortTerm: number[]): number {
  const above = shortTerm.filter((l) => l > -70);
  if (above.length < 2) return 0;

  const meanMs = above.reduce((s, l) => s + Math.pow(10, (l + 0.691) / 10), 0) / above.length;
  const threshold = loudnessFromMs(meanMs) - 20;

  const gated = above.filter((l) => l > threshold).sort((a, b) => a - b);
  if (gated.length < 2) return 0;

  const pick = (p: number) => gated[Math.min(gated.length - 1, Math.max(0, Math.round(p * (gated.length - 1))))];
  return Math.max(0, pick(0.95) - pick(0.10));
}

/** 4x oversampling FIR (windowed sinc, 4 phases x 16 taps). */
const TP_TAPS_PER_PHASE = 16;
const TP_PHASES = 4;

function buildPolyphase(): Float32Array[] {
  const total = TP_TAPS_PER_PHASE * TP_PHASES;
  const coeffs = new Float64Array(total);
  const center = (total - 1) / 2;
  const cutoff = 0.5 / TP_PHASES; // normalized to oversampled rate
  for (let n = 0; n < total; n++) {
    const t = n - center;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    // Blackman window
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (total - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (total - 1));
    coeffs[n] = sinc * w;
  }
  // Normalize each phase to unity DC gain across the interpolation
  const phases: Float32Array[] = [];
  for (let p = 0; p < TP_PHASES; p++) {
    const ph = new Float32Array(TP_TAPS_PER_PHASE);
    let sum = 0;
    for (let k = 0; k < TP_TAPS_PER_PHASE; k++) {
      ph[k] = coeffs[k * TP_PHASES + p] * TP_PHASES;
      sum += ph[k];
    }
    if (sum !== 0) for (let k = 0; k < TP_TAPS_PER_PHASE; k++) ph[k] /= sum;
    phases.push(ph);
  }
  return phases;
}

const POLYPHASE = buildPolyphase();

/** True peak in dBTP using 4x oversampling; also returns sample peak in dBFS. */
export function measureTruePeak(buffer: AudioBuffer): { truePeak: number; samplePeak: number } {
  let samplePeak = 0;
  let truePeak = 0;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const n = data.length;
    const hist = new Float32Array(TP_TAPS_PER_PHASE);
    let hi = 0;

    for (let i = 0; i < n; i++) {
      const x = data[i];
      const ax = Math.abs(x);
      if (ax > samplePeak) samplePeak = ax;

      hist[hi] = x;
      hi = (hi + 1) % TP_TAPS_PER_PHASE;

      for (let p = 0; p < TP_PHASES; p++) {
        const ph = POLYPHASE[p];
        let acc = 0;
        for (let k = 0; k < TP_TAPS_PER_PHASE; k++) {
          // hist[hi] is the oldest sample
          acc += ph[TP_TAPS_PER_PHASE - 1 - k] * hist[(hi + k) % TP_TAPS_PER_PHASE];
        }
        const a = Math.abs(acc);
        if (a > truePeak) truePeak = a;
      }
    }
  }

  return {
    truePeak: 20 * Math.log10(Math.max(truePeak, samplePeak) || 1e-9),
    samplePeak: 20 * Math.log10(samplePeak || 1e-9),
  };
}

/** Full BS.1770-4 / EBU R128 measurement set. */
export function measureLoudness(buffer: AudioBuffer): LoudnessResult {
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const weighted = kWeightChannels(buffer);

  // Momentary (400 ms, 100 ms hop) → integrated + momentary max
  const momentaryMs = blockMeanSquares(weighted, channels, Math.round(sr * 0.4), Math.round(sr * 0.1));
  const integrated = gatedLoudness(momentaryMs);
  const momentary = momentaryMs.map(loudnessFromMs);

  // Short-term (3 s, 1 s hop) → LRA + short-term max
  const shortMs = blockMeanSquares(weighted, channels, Math.round(sr * 3), Math.round(sr * 1));
  const shortTerm = shortMs.map(loudnessFromMs);

  const { truePeak, samplePeak } = measureTruePeak(buffer);

  return {
    integrated: Math.round(integrated * 10) / 10,
    lra: Math.round(computeLRA(shortTerm.length ? shortTerm : momentary) * 10) / 10,
    shortTermMax: shortTerm.length ? Math.round(Math.max(...shortTerm) * 10) / 10 : Math.round(integrated * 10) / 10,
    momentaryMax: momentary.length ? Math.round(Math.max(...momentary) * 10) / 10 : Math.round(integrated * 10) / 10,
    truePeak: Math.round(truePeak * 10) / 10,
    samplePeak: Math.round(samplePeak * 10) / 10,
  };
}
