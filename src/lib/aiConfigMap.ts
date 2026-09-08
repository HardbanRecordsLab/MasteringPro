import type { ProcessingParams } from '@/contexts/AudioContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Map an AI-mastering `config` payload onto a ProcessingParams patch.
 * Unknown / missing fields are left untouched (caller spreads over `prev`).
 */
export function aiConfigToParams(config: any, prev: ProcessingParams): Partial<ProcessingParams> {
  if (!config) return {};
  const p: Partial<ProcessingParams> = {};

  if (typeof config.inputGain === 'number') p.inputGain = config.inputGain;

  if (Array.isArray(config.parametricEQ)) {
    p.eqEnabled = true;
    p.eqBands = config.parametricEQ.slice(0, 5).map((eq: any, i: number) => ({
      freq: eq.freq ?? prev.eqBands[i]?.freq ?? 1000,
      gain: Math.max(-12, Math.min(6, eq.gain ?? 0)),
      q: eq.q ?? prev.eqBands[i]?.q ?? 1,
      type: (eq.type === 'lowShelf' ? 'lowshelf' : eq.type === 'highShelf' ? 'highshelf' : 'peaking') as BiquadFilterType,
    }));
    // pad to 5 bands
    while (p.eqBands.length < 5) {
      const i = p.eqBands.length;
      p.eqBands.push(prev.eqBands[i] ?? { freq: 1000, gain: 0, q: 1, type: 'peaking' });
    }
  }

  if (config.compressor) {
    const c = config.compressor;
    p.compEnabled = true;
    if (c.threshold != null) p.compThreshold = c.threshold;
    if (c.ratio != null) p.compRatio = c.ratio;
    if (c.attack != null) p.compAttack = c.attack;
    if (c.release != null) p.compRelease = c.release;
    if (c.knee != null) p.compKnee = c.knee;
    if (c.makeupGain != null) p.compMakeup = c.makeupGain;
  }

  if (typeof config.stereoWidth === 'number') {
    p.stereoWidth = config.stereoWidth;
    p.widthEnabled = config.stereoWidth !== 100;
  }

  if (config.limiter) {
    p.limiterEnabled = true;
    if (config.limiter.ceiling != null) p.limiterCeiling = config.limiter.ceiling;
    if (config.limiter.release != null) p.limiterRelease = config.limiter.release;
  }

  if (typeof config.saturation === 'number') {
    p.saturation = config.saturation;
    p.saturationEnabled = config.saturation > 0;
  }

  if (config.lowCut && typeof config.lowCut.freq === 'number') {
    p.lowCutEnabled = true;
    p.lowCutFreq = config.lowCut.freq;
  }
  if (typeof config.tilt === 'number' && config.tilt !== 0) {
    p.tiltEnabled = true;
    p.tiltAmount = config.tilt;
  }
  if (config.bassMono && typeof config.bassMono.freq === 'number') {
    p.bassMonoEnabled = true;
    p.bassMonoFreq = config.bassMono.freq;
  }
  if (config.deEsserHint && typeof config.deEsserHint.freq === 'number') {
    p.deEssEnabled = true;
    p.deEssFreq = config.deEsserHint.freq;
    if (typeof config.deEsserHint.amount === 'number') {
      p.deEssRange = Math.max(1, Math.min(15, config.deEsserHint.amount));
    }
  }

  return p;
}
