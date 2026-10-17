/**
 * Streaming weighted-overlap-add STFT.
 *
 * Square-root-Hann analysis AND synthesis windows (product = Hann) at 75 % overlap reconstruct the input exactly when
 * the callback leaves the spectrum untouched, and keep modified spectra free of frame-edge discontinuities.
 * The signal is processed frame by frame, so memory stays flat on long files.
 */
import { FFT } from '@/lib/fft';

export interface StftOptions {
  /** power of two */
  size: number;
  /** hop in samples; size/4 gives 75 % overlap (default) */
  hop?: number;
}

/**
 * Run `fn(re, im, frameIndex)` on the half-spectrum (bins 0 … size/2, windowed frame) of every frame and overlap-add the
 * result. `fn` may modify `re` / `im` in place; the mirrored negative-frequency half is rebuilt automatically.
 */
export function stftProcess(
  x: Float32Array,
  opts: StftOptions,
  fn: (re: Float64Array, im: Float64Array, frame: number) => void,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const N = opts.size;
  const hop = opts.hop ?? N / 4;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sin((Math.PI * i) / N); // sqrt of the periodic Hann window
  // steady-state sum of win² over the overlapping frames
  let wsum = 0;
  for (let m = 0; m * hop < N; m++) wsum += win[m * hop] * win[m * hop];
  const norm = 1 / wsum;

  const n = x.length;
  const padded = new Float32Array(n + 2 * N);
  padded.set(x, N);
  const out = new Float32Array(n + 2 * N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const half = N / 2;
  const frames = Math.floor((padded.length - N) / hop) + 1;

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = padded[start + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    fn(re, im, f);
    // rebuild conjugate-symmetric upper half
    for (let k = 1; k < half; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    im[0] = 0;
    im[half] = 0;
    // inverse via conjugate trick: ifft(X) = conj(fft(conj(X))) / N
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fft.transform(re, im);
    const scale = norm / N;
    for (let i = 0; i < N; i++) out[start + i] += re[i] * scale * win[i];
    if (onProgress && (f & 255) === 0) onProgress(f / frames);
  }
  onProgress?.(1);
  return out.slice(N, N + n);
}
