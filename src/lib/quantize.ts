/**
 * Float → fixed-point conversion with dither, shared by every PCM encoder (WAV, AIFF, FLAC).
 *
 * - Scale is 2^(bits-1) (what DAWs and converters use), rounded to nearest and clamped to the integer range — never
 *   truncated, never wrapped.
 * - 'tpdf': triangular dither, ±1 LSB (2 LSB peak-to-peak) → unbiased, signal-independent error, no quantisation distortion.
 * - 'shaped': the same TPDF plus 2nd-order error feedback with NTF = 1 − 1.8 z⁻¹ + 0.9 z⁻² — zeros at ≈ 2.4 kHz (radius 0.95),
 *   so the noise is pushed out of the region where hearing is most sensitive (≈ 1.5–5 kHz) toward the top octave.
 */
export type DitherMode = 'none' | 'tpdf' | 'shaped';

const SHAPE_A = 1.8;
const SHAPE_B = 0.9;
const E_LIMIT = 2;           // |fed-back error| ≤ 2 LSB: a clipped sample must not set the shaper ringing

export function quantizeChannels(
  channels: Float32Array[],
  bits: 16 | 24,
  mode: DitherMode,
  random: () => number = Math.random,
): Int32Array[] {
  const scale = 2 ** (bits - 1);
  const maxV = scale - 1;
  const minV = -scale;
  return channels.map((src) => {
    const out = new Int32Array(src.length);
    let e1 = 0, e2 = 0;
    for (let i = 0; i < src.length; i++) {
      let x = src[i] * scale;                       // in LSB units
      if (!(x - x === 0)) x = 0;                    // NaN / ±Infinity → silence rather than a full-scale click
      let v = x;
      if (mode === 'shaped') v = x - SHAPE_A * e1 + SHAPE_B * e2;
      if (mode !== 'none') v += random() - random();
      let q = Math.round(v);
      if (q > maxV) q = maxV; else if (q < minV) q = minV;
      if (mode === 'shaped') {
        let e = q - (x - SHAPE_A * e1 + SHAPE_B * e2);   // error of this step, excluding the dither (it is part of it)
        e = e > E_LIMIT ? E_LIMIT : e < -E_LIMIT ? -E_LIMIT : e;
        e2 = e1; e1 = e;
      }
      out[i] = q;
    }
    return out;
  });
}
