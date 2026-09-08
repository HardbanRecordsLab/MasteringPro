/**
 * Saturation transfer curves for the mastering WaveShaper.
 *
 * The nonlinearity is memoryless, so a static lookup curve is an exact model —
 * aliasing is handled by running the WaveShaperNode at 4x oversampling. Each
 * mode has its own harmonic signature:
 *
 *  - tape        odd harmonics, gentle tanh compression, symmetric
 *  - tube        asymmetric → strong 2nd harmonic, musical "warmth"
 *  - transformer soft cubic knee, rounder top, a little 2nd harmonic
 *  - clip        aggressive arctan limiting character
 *
 * Every curve has unity slope at the origin, so quiet passages pass through
 * untouched and only louder peaks are progressively rounded off (the small
 * level loss at the rails is picked up by makeup / the limiter downstream).
 */
export type SaturationMode = 'tape' | 'tube' | 'transformer' | 'clip';

const SAMPLES = 8192;

export function makeSaturationCurve(amount: number, mode: SaturationMode = 'tape'): Float32Array {
  const curve = new Float32Array(SAMPLES);
  const k = Math.max(0, Math.min(100, amount)) / 100;

  const shape = (x: number): number => {
    if (k <= 0) return x;
    switch (mode) {
      case 'tube': {
        const d = 1 + 4 * k;
        const b = 0.18 * k; // DC bias → asymmetry → 2nd harmonic
        return (Math.tanh(d * (x + b)) - Math.tanh(d * b)) / d;
      }
      case 'transformer': {
        const a = 0.33 * k;
        const xl = 1 / Math.sqrt(3 * a);        // past here the cubic folds back
        const peak = xl - a * xl * xl * xl;
        const ax = Math.abs(x);
        if (ax >= xl) return Math.sign(x) * peak;
        return x - a * x * x * x;
      }
      case 'clip': {
        const d = 1 + 8 * k;
        return Math.atan(d * x) / d;
      }
      case 'tape':
      default: {
        const d = 1 + 4 * k;
        return Math.tanh(d * x) / d;
      }
    }
  };

  for (let i = 0; i < SAMPLES; i++) {
    curve[i] = shape((i * 2) / SAMPLES - 1);
  }
  return curve;
}
