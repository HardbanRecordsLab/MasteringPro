/**
 * AI-mastering config → ProcessingParams mapping.
 *
 * The AI route returns a loose JSON `config`; aiConfigToParams turns it into a
 * ProcessingParams patch. This locks down the field names and clamps so a
 * server-side rename can't silently stop a tool from being applied.
 */
import { describe, it, expect } from 'vitest';
import { aiConfigToParams } from '@/lib/aiConfigMap';
import { DEFAULT_PROCESSING, type ProcessingParams } from '@/contexts/AudioContext';

const prev: ProcessingParams = DEFAULT_PROCESSING;

describe('aiConfigToParams', () => {
  it('returns an empty patch for a null / empty config', () => {
    expect(aiConfigToParams(null, prev)).toEqual({});
    expect(aiConfigToParams({}, prev)).toEqual({});
  });

  it('maps the parametric EQ and pads to 5 bands', () => {
    const p = aiConfigToParams({ parametricEQ: [{ freq: 200, gain: -3, q: 1, type: 'bell' }] }, prev);
    expect(p.eqEnabled).toBe(true);
    expect(p.eqBands).toHaveLength(5);
    expect(p.eqBands![0]).toMatchObject({ freq: 200, gain: -3, type: 'peaking' });
  });

  it('clamps EQ gain to ±(−12..+6) dB', () => {
    const p = aiConfigToParams({ parametricEQ: [{ freq: 1000, gain: 99, q: 1 }, { freq: 2000, gain: -99, q: 1 }] }, prev);
    expect(p.eqBands![0].gain).toBe(6);
    expect(p.eqBands![1].gain).toBe(-12);
  });

  it('maps the resonance suppressor and its clamps', () => {
    const p = aiConfigToParams({ resonanceSuppressor: { amount: 70, depth: 40, threshold: 0.2 } }, prev);
    expect(p.resoEnabled).toBe(true);
    expect(p.resoAmount).toBe(70);
    expect(p.resoDepth).toBe(24); // clamped 3..24
    expect(p.resoThreshold).toBe(1); // clamped 1..18
  });

  it('ignores a zero-amount resonance suppressor', () => {
    const p = aiConfigToParams({ resonanceSuppressor: { amount: 0 } }, prev);
    expect(p.resoEnabled).toBeUndefined();
  });

  it('maps a valid saturation mode and rejects a bogus one', () => {
    expect(aiConfigToParams({ saturationMode: 'tube' }, prev).satMode).toBe('tube');
    expect(aiConfigToParams({ saturationMode: 'plasma' }, prev).satMode).toBeUndefined();
  });

  it('only enables stereo width when it is off-neutral', () => {
    expect(aiConfigToParams({ stereoWidth: 100 }, prev).widthEnabled).toBe(false);
    expect(aiConfigToParams({ stereoWidth: 130 }, prev).widthEnabled).toBe(true);
  });
});
