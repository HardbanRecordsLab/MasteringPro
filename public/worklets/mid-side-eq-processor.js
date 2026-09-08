/**
 * Mid/Side EQ AudioWorklet Processor
 *
 * Decodes stereo into Mid = (L+R)/2 and Side = (L-R)/2, applies an independent
 * 3-band peaking EQ to each, re-encodes L = M + S, R = M - S.
 *
 * Coefficients are slewed toward their targets (~5 ms) so parameter moves don't
 * click. RBJ peaking biquads.
 *
 * Parameters (k-rate):
 *   midLowGain, midMidGain, midHighGain    (dB, -12..+12)
 *   sideLowGain, sideMidGain, sideHighGain (dB, -12..+12)
 *   midLowFreq=120, midMidFreq=1000, midHighFreq=8000  (Hz)
 *   sideLowFreq / sideMidFreq / sideHighFreq
 *   q = 0.7
 */

const SLEW = 1 - Math.exp(-1 / (sampleRate * 0.005)); // ~5 ms coefficient glide

class Biquad {
  constructor() {
    // current + target coefficients (start as pass-through)
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.tb0 = 1; this.tb1 = 0; this.tb2 = 0; this.ta1 = 0; this.ta2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  setPeaking(sr, freq, q, dbGain) {
    const A = Math.pow(10, dbGain / 40);
    const w0 = (2 * Math.PI * freq) / sr;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha / A;
    this.tb0 = (1 + alpha * A) / a0;
    this.tb1 = (-2 * cosw) / a0;
    this.tb2 = (1 - alpha * A) / a0;
    this.ta1 = (-2 * cosw) / a0;
    this.ta2 = (1 - alpha / A) / a0;
  }
  process(x) {
    this.b0 += (this.tb0 - this.b0) * SLEW;
    this.b1 += (this.tb1 - this.b1) * SLEW;
    this.b2 += (this.tb2 - this.b2) * SLEW;
    this.a1 += (this.ta1 - this.a1) * SLEW;
    this.a2 += (this.ta2 - this.a2) * SLEW;
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class MidSideEQProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const def = (name, val, min = -12, max = 12) => ({
      name, defaultValue: val, minValue: min, maxValue: max, automationRate: 'k-rate',
    });
    return [
      def('midLowGain', 0), def('midMidGain', 0), def('midHighGain', 0),
      def('sideLowGain', 0), def('sideMidGain', 0), def('sideHighGain', 0),
      def('midLowFreq', 120, 20, 20000), def('midMidFreq', 1000, 20, 20000), def('midHighFreq', 8000, 20, 20000),
      def('sideLowFreq', 120, 20, 20000), def('sideMidFreq', 1000, 20, 20000), def('sideHighFreq', 8000, 20, 20000),
      def('q', 0.7, 0.1, 10),
    ];
  }

  constructor() {
    super();
    this.midL = new Biquad(); this.midM = new Biquad(); this.midH = new Biquad();
    this.sideL = new Biquad(); this.sideM = new Biquad(); this.sideH = new Biquad();
    this.first = true;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const sr = sampleRate;
    const q = params.q[0];
    const all = [this.midL, this.midM, this.midH, this.sideL, this.sideM, this.sideH];
    // Refresh targets every block (cheap; the biquads slew toward them).
    this.midL.setPeaking(sr, params.midLowFreq[0], q, params.midLowGain[0]);
    this.midM.setPeaking(sr, params.midMidFreq[0], q, params.midMidGain[0]);
    this.midH.setPeaking(sr, params.midHighFreq[0], q, params.midHighGain[0]);
    this.sideL.setPeaking(sr, params.sideLowFreq[0], q, params.sideLowGain[0]);
    this.sideM.setPeaking(sr, params.sideMidFreq[0], q, params.sideMidGain[0]);
    this.sideH.setPeaking(sr, params.sideHighFreq[0], q, params.sideHighGain[0]);
    if (this.first) {
      for (const bq of all) {
        bq.b0 = bq.tb0; bq.b1 = bq.tb1; bq.b2 = bq.tb2; bq.a1 = bq.ta1; bq.a2 = bq.ta2;
      }
      this.first = false;
    }

    const inL = input[0];
    const inR = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const N = inL.length;

    for (let i = 0; i < N; i++) {
      const l = inL[i];
      const r = inR[i];
      let m = (l + r) * 0.5;
      let s = (l - r) * 0.5;
      m = this.midH.process(this.midM.process(this.midL.process(m)));
      s = this.sideH.process(this.sideM.process(this.sideL.process(s)));
      outL[i] = m + s;
      outR[i] = m - s;
    }
    return true;
  }
}

registerProcessor('mid-side-eq-processor', MidSideEQProcessor);
