/**
 * Shared constants for the lookahead true-peak limiter.
 * These MUST match public/worklets/lookahead-limiter-processor.js.
 */
export const LIMITER_OS = 4;
export const LIMITER_PROTO_TAPS = 64;
/** Fixed lookahead window baked into the worklet's delay line, in seconds. */
export const LIMITER_LOOKAHEAD_S = 0.005;

/**
 * Processing latency the limiter worklet introduces, in samples at `sampleRate`.
 * = (upsample+decimate filter delay + lookahead) / oversampling factor.
 */
export function limiterLatencySamples(sampleRate: number): number {
  const lookOs = Math.max(1, Math.round(sampleRate * LIMITER_OS * LIMITER_LOOKAHEAD_S));
  return Math.round((LIMITER_PROTO_TAPS - 1 + lookOs) / LIMITER_OS);
}

/**
 * Approximate latency of the native Web Audio DynamicsCompressor (no API exposes
 * it; Chrome uses a ~6 ms internal lookahead). Replaced by a zero-latency worklet
 * compressor in a later phase.
 */
export function compressorLatencySamples(sampleRate: number): number {
  return Math.round(sampleRate * 0.006);
}
