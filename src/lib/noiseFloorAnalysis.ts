/**
 * Noise-floor estimation for Auto Threshold in Noise Gate.
 *
 * Computes RMS over short windows for one or two channels, then takes a
 * configurable low percentile (the quietest portion = noise floor).
 * Threshold = noise floor + margin (dB).
 */

export interface AutoThresholdOptions {
  /** Window size in milliseconds (e.g. 5..100). */
  windowMs: number;
  /** Percentile in 0..1 (e.g. 0.1 = 10%). */
  percentile: number;
  /** dB added on top of noise floor (e.g. 3..12). */
  marginDb: number;
}

export interface ChannelEstimate {
  noiseFloorDb: number;
  thresholdDb: number;
}

export interface AutoThresholdResult {
  /** Per-channel estimates: [L, R] for stereo, [mono] for mono. */
  channels: ChannelEstimate[];
  /** Combined (max of channels) — single threshold suggestion. */
  combined: ChannelEstimate;
  /** Mid/Side estimates (only when channels=2). */
  midSide?: { mid: ChannelEstimate; side: ChannelEstimate };
}

function rmsPercentileDb(samples: Float32Array, winSize: number, percentile: number): number {
  const rmsValues: number[] = [];
  const len = samples.length;
  for (let i = 0; i + winSize <= len; i += winSize) {
    let sum = 0;
    for (let j = 0; j < winSize; j++) {
      const s = samples[i + j];
      sum += s * s;
    }
    rmsValues.push(Math.sqrt(sum / winSize));
  }
  if (rmsValues.length === 0) return -80;
  rmsValues.sort((a, b) => a - b);
  const idx = Math.min(rmsValues.length - 1, Math.max(0, Math.floor(rmsValues.length * percentile)));
  return 20 * Math.log10(Math.max(rmsValues[idx], 1e-7));
}

export function estimateAutoThreshold(
  buffer: AudioBuffer,
  opts: AutoThresholdOptions
): AutoThresholdResult {
  const { windowMs, percentile, marginDb } = opts;
  const sr = buffer.sampleRate;
  const winSize = Math.max(64, Math.floor(sr * (windowMs / 1000)));
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const clampDb = (db: number) => Math.min(0, Math.max(-80, db));

  const lFloor = rmsPercentileDb(ch0, winSize, percentile);
  const lEst: ChannelEstimate = { noiseFloorDb: lFloor, thresholdDb: clampDb(lFloor + marginDb) };

  if (!ch1) {
    return { channels: [lEst], combined: lEst };
  }

  const rFloor = rmsPercentileDb(ch1, winSize, percentile);
  const rEst: ChannelEstimate = { noiseFloorDb: rFloor, thresholdDb: clampDb(rFloor + marginDb) };

  const combinedFloor = Math.max(lFloor, rFloor);
  const combined: ChannelEstimate = {
    noiseFloorDb: combinedFloor,
    thresholdDb: clampDb(combinedFloor + marginDb),
  };

  // Mid/Side decomposition: M = (L+R)/√2 ; S = (L−R)/√2
  const len = ch0.length;
  const mid = new Float32Array(len);
  const side = new Float32Array(len);
  const inv = 1 / Math.SQRT2;
  for (let i = 0; i < len; i++) {
    const l = ch0[i];
    const r = ch1[i];
    mid[i] = (l + r) * inv;
    side[i] = (l - r) * inv;
  }
  const mFloor = rmsPercentileDb(mid, winSize, percentile);
  const sFloor = rmsPercentileDb(side, winSize, percentile);
  const midEst: ChannelEstimate = { noiseFloorDb: mFloor, thresholdDb: clampDb(mFloor + marginDb) };
  const sideEst: ChannelEstimate = { noiseFloorDb: sFloor, thresholdDb: clampDb(sFloor + marginDb) };

  return {
    channels: [lEst, rEst],
    combined,
    midSide: { mid: midEst, side: sideEst },
  };
}
