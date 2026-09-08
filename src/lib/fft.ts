/**
 * Iterative radix-2 Cooley–Tukey FFT (in-place, complex).
 * Sizes must be powers of two. No dependencies.
 */

export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  /** In-place FFT of interleaved-free real/imag arrays (length `size`). */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let half = 1; half < n; half <<= 1) {
      const step = half << 1;
      const tblStep = n / step;
      for (let i = 0; i < n; i += step) {
        for (let k = 0, t = 0; k < half; k++, t += tblStep) {
          const c = this.cos[t];
          const s = this.sin[t];
          const a = i + k;
          const b = a + half;
          const tre = c * re[b] - s * im[b];
          const tim = c * im[b] + s * re[b];
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  }

  /**
   * Magnitude spectrum of a real signal frame (length `size`).
   * Returns `size/2 + 1` bins. Caller applies any window beforehand.
   */
  magnitude(frame: Float64Array | Float32Array, out?: Float64Array): Float64Array {
    const n = this.size;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = frame[i];
    this.transform(re, im);
    const bins = n / 2 + 1;
    const mag = out ?? new Float64Array(bins);
    for (let i = 0; i < bins; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }
}

/** Periodic Hann window of length `n` (coherent gain 0.5). */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}
