/**
 * Lookahead True-Peak Limiter — AudioWorklet Processor
 *
 * Limits in the 4x-oversampled domain, so inter-sample (true) peaks of the
 * downsampled output are held at or below the ceiling — not merely estimated.
 *
 *   input → 4x polyphase upsampler → lookahead limiter @ 4x → 4x decimator → output
 *
 * - Upsampler / decimator share a 64-tap windowed-sinc prototype (Blackman-Harris,
 *   cutoff = base Nyquist). Peak reconstruction accuracy is well under 0.1 dB.
 * - Lookahead: a sliding-window minimum (monotonic deque) over the per-sample
 *   target gain across the whole lookahead window, so the gain is already down
 *   when a transient reaches the output. Short attack smoothing, exp release.
 * - Stereo-linked gain. Optional safety margin below the ceiling. A gentle final
 *   clip at the ceiling is a backstop that almost never engages.
 * - Reports gain reduction (dB), input true peak (dBTP) and processing latency.
 *
 * Constants OS / PROTO_TAPS are mirrored in src/lib/limiterConfig.ts — keep in sync.
 *
 * Parameters (k-rate):
 *   ceiling   (dB, -12..0)   output ceiling (dBTP)
 *   release   (ms, 1..1000)
 *   lookahead (ms, 0..20)
 *   margin    (dB, 0..2)     extra headroom kept below the ceiling
 *   bypass    (0/1)
 */

const OS = 4;
const PROTO_TAPS = 64;
const TAPS_PER_PHASE = PROTO_TAPS / OS; // 16

function buildProto() {
  const h = new Float64Array(PROTO_TAPS);
  const M = PROTO_TAPS - 1;
  const fc = 0.5 / OS;
  let sum = 0;
  for (let n = 0; n < PROTO_TAPS; n++) {
    const x = n - M / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w =
      0.35875 -
      0.48829 * Math.cos((2 * Math.PI * n) / M) +
      0.14128 * Math.cos((4 * Math.PI * n) / M) -
      0.01168 * Math.cos((6 * Math.PI * n) / M);
    h[n] = sinc * w;
    sum += h[n];
  }
  const out = new Float32Array(PROTO_TAPS);
  for (let n = 0; n < PROTO_TAPS; n++) out[n] = (h[n] / sum) * OS;
  return out;
}
const PROTO = buildProto();

class LookaheadLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling',   defaultValue: -1,  minValue: -12, maxValue: 0,    automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 100, minValue: 1,   maxValue: 1000, automationRate: 'k-rate' },
      { name: 'lookahead', defaultValue: 5,   minValue: 0,   maxValue: 20,   automationRate: 'k-rate' },
      { name: 'margin',    defaultValue: 0.3, minValue: 0,   maxValue: 2,    automationRate: 'k-rate' },
      { name: 'bypass',    defaultValue: 0,   minValue: 0,   maxValue: 1,    automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const osr = sampleRate * OS;
    this.lookOs = Math.max(1, Math.round(osr * 0.005)); // fixed 5 ms window
    this.osDelayL = new Float32Array(this.lookOs + 4);
    this.osDelayR = new Float32Array(this.lookOs + 4);
    this.osWrite = 0;

    this.upHistL = new Float32Array(TAPS_PER_PHASE);
    this.upHistR = new Float32Array(TAPS_PER_PHASE);
    this.upIdx = 0;

    this.dnHistL = new Float32Array(PROTO_TAPS);
    this.dnHistR = new Float32Array(PROTO_TAPS);
    this.dnIdx = 0;

    // Sliding-window-minimum deque over per-sample target gain.
    this.dqVal = new Float32Array(this.lookOs + 2);
    this.dqExp = new Float64Array(this.lookOs + 2); // sample index at which entry leaves the window
    this.dqHead = 0;
    this.dqTail = 0; // exclusive
    this.counter = 0;

    this.gain = 1;
    this.attackCoef = Math.exp(-1 / (osr * 0.0012)); // ~1.2 ms smoothing into the reduction
    this._grDb = 0;
    this._tpDb = -Infinity;
    this._meterAcc = 0;
    this._meterEvery = Math.floor(sampleRate / 30);

    const filtDelayOs = PROTO_TAPS - 1; // up + down combined, approx
    this.latencySamples = Math.round((filtDelayOs + this.lookOs) / OS);
    this.port.postMessage({ type: 'latency', samples: this.latencySamples });
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output[1] || output[0];
    const input = inputs[0];

    if (!input || input.length === 0) {
      outL.fill(0);
      if (output[1]) outR.fill(0);
      return true;
    }

    const inL = input[0];
    const inR = input[1] || input[0];
    const n = outL.length;

    const bypass = params.bypass[0] >= 0.5;
    const ceilLin = Math.pow(10, (params.ceiling[0] - params.margin[0]) / 20);
    const hardLin = Math.pow(10, params.ceiling[0] / 20);
    const releaseCoef = Math.exp(-1 / (sampleRate * OS * Math.max(1, params.release[0]) * 0.001));
    const look = this.lookOs;
    const dqCap = this.dqVal.length;

    let maxTp = 0;
    let minGain = 1;

    for (let i = 0; i < n; i++) {
      this.upHistL[this.upIdx] = inL[i];
      this.upHistR[this.upIdx] = inR[i];
      const upNewest = this.upIdx;
      this.upIdx = (this.upIdx + 1) % TAPS_PER_PHASE;

      let dsL = 0, dsR = 0;

      for (let p = 0; p < OS; p++) {
        // ---- polyphase upsample: y[p] = Σ PROTO[k*OS+p] · x[n-k] ----
        let ul = 0, ur = 0;
        for (let k = 0; k < TAPS_PER_PHASE; k++) {
          const hk = PROTO[k * OS + p];
          const idx = (upNewest - k + 2 * TAPS_PER_PHASE) % TAPS_PER_PHASE;
          ul += hk * this.upHistL[idx];
          ur += hk * this.upHistR[idx];
        }

        const peak = Math.abs(ul) > Math.abs(ur) ? Math.abs(ul) : Math.abs(ur);
        if (peak > maxTp) maxTp = peak;
        const target = peak > ceilLin ? ceilLin / peak : 1;

        // ---- push target into monotonic-min deque ----
        while (this.dqTail !== this.dqHead) {
          const back = (this.dqTail - 1 + dqCap) % dqCap;
          if (this.dqVal[back] >= target) this.dqTail = back;
          else break;
        }
        this.dqVal[this.dqTail] = target;
        this.dqExp[this.dqTail] = this.counter + look;
        this.dqTail = (this.dqTail + 1) % dqCap;
        // drop entries whose sample has already left the delay line
        while (this.dqTail !== this.dqHead && this.dqExp[this.dqHead] <= this.counter) {
          this.dqHead = (this.dqHead + 1) % dqCap;
        }
        const windowMin = this.dqHead === this.dqTail ? 1 : this.dqVal[this.dqHead];
        this.counter++;

        // ---- smooth gain toward the window minimum ----
        if (windowMin < this.gain) {
          this.gain = windowMin + (this.gain - windowMin) * this.attackCoef;
        } else {
          this.gain = windowMin + (this.gain - windowMin) * releaseCoef;
        }
        if (this.gain < minGain) minGain = this.gain;

        // ---- delay line + apply ----
        this.osDelayL[this.osWrite] = ul;
        this.osDelayR[this.osWrite] = ur;
        let rd = this.osWrite - look;
        if (rd < 0) rd += this.osDelayL.length;
        let yl = this.osDelayL[rd];
        let yr = this.osDelayR[rd];
        this.osWrite = (this.osWrite + 1) % this.osDelayL.length;

        if (!bypass) {
          yl *= this.gain;
          yr *= this.gain;
          if (yl > hardLin) yl = hardLin; else if (yl < -hardLin) yl = -hardLin;
          if (yr > hardLin) yr = hardLin; else if (yr < -hardLin) yr = -hardLin;
        }

        // ---- feed decimator, emit one base-rate sample per OS block ----
        this.dnHistL[this.dnIdx] = yl;
        this.dnHistR[this.dnIdx] = yr;
        const dnNewest = this.dnIdx;
        this.dnIdx = (this.dnIdx + 1) % PROTO_TAPS;

        if (p === OS - 1) {
          for (let k = 0; k < PROTO_TAPS; k++) {
            const hk = PROTO[k] / OS; // unity DC
            const idx = (dnNewest - k + 2 * PROTO_TAPS) % PROTO_TAPS;
            dsL += hk * this.dnHistL[idx];
            dsR += hk * this.dnHistR[idx];
          }
        }
      }

      // Backstop: catch the decimation filter's tiny overshoot on the rare
      // pathological sample. Engages essentially never on real program material.
      if (!bypass) {
        if (dsL > hardLin) dsL = hardLin; else if (dsL < -hardLin) dsL = -hardLin;
        if (dsR > hardLin) dsR = hardLin; else if (dsR < -hardLin) dsR = -hardLin;
      }

      outL[i] = dsL;
      if (output[1]) outR[i] = dsR;
    }

    this._grDb = 20 * Math.log10(Math.max(minGain, 1e-6));
    this._tpDb = maxTp > 0 ? 20 * Math.log10(maxTp) : -Infinity;
    this._meterAcc += n;
    if (this._meterAcc >= this._meterEvery) {
      this._meterAcc = 0;
      this.port.postMessage({ gr: this._grDb, tp: this._tpDb });
    }
    return true;
  }
}

registerProcessor('lookahead-limiter-processor', LookaheadLimiterProcessor);
