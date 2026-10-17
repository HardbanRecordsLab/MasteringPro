/**
 * Bass Mono-Maker — AudioWorklet Processor
 *
 * Everything below `freq` is summed to mono (both channels get (L+R)/2);
 * everything above stays stereo. Linkwitz-Riley 4th-order crossover (two cascaded
 * Butterworth biquads per side): LP + HP sums to a flat-magnitude all-pass, so
 * centred material passes without a notch at the crossover (a single 2nd-order
 * Butterworth pair would cancel completely at `freq`). Essential for vinyl and club systems.
 *
 * Config: processorOptions / port message { freq }  (default 120 Hz)
 */

class LR2 {
  constructor(type) {
    this.type = type;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.tb0 = 1; this.tb1 = 0; this.tb2 = 0; this.ta1 = 0; this.ta2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.first = true;
    this.k = 1 - Math.exp(-1 / (sampleRate * 0.005)); // ~5 ms slew
  }
  reset() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(sr, f) {
    const w0 = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const c = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    if (this.type === 'lp') { this.tb0 = (1 - c) / 2 / a0; this.tb1 = (1 - c) / a0; this.tb2 = this.tb0; }
    else { this.tb0 = (1 + c) / 2 / a0; this.tb1 = -(1 + c) / a0; this.tb2 = this.tb0; }
    this.ta1 = (-2 * c) / a0;
    this.ta2 = (1 - alpha) / a0;
    if (this.first) {
      this.b0 = this.tb0; this.b1 = this.tb1; this.b2 = this.tb2; this.a1 = this.ta1; this.a2 = this.ta2;
      this.first = false;
    }
  }
  process(x) {
    const k = this.k;
    this.b0 += (this.tb0 - this.b0) * k; this.b1 += (this.tb1 - this.b1) * k; this.b2 += (this.tb2 - this.b2) * k;
    this.a1 += (this.ta1 - this.a1) * k; this.a2 += (this.ta2 - this.a2) * k;
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** 4th-order Linkwitz-Riley = two identical Butterworth biquads in series */
class LR4 {
  constructor(type) { this.a = new LR2(type); this.b = new LR2(type); }
  set(sr, f) { this.a.set(sr, f); this.b.set(sr, f); }
  reset() { this.a.reset(); this.b.reset(); }
  process(x) { return this.b.process(this.a.process(x)); }
}

class BassMonoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.freq = ((options && options.processorOptions) || {}).freq || 120;
    this.lpL = new LR4('lp'); this.lpR = new LR4('lp');
    this.hpL = new LR4('hp'); this.hpR = new LR4('hp');
    this._update();
    this.port.onmessage = (e) => { if (e.data && typeof e.data.freq === 'number') { this.freq = e.data.freq; this._update(); } };
  }
  _update() {
    for (const f of [this.lpL, this.lpR, this.hpL, this.hpR]) f.set(sampleRate, this.freq);
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const inL = input[0];
    const inR = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    for (let i = 0; i < inL.length; i++) {
      let l = inL[i], r = inR[i];
      // NaN / Infinity would live on in the crossover state forever: treat it as silence and start clean
      if (!(l - l === 0) || !(r - r === 0)) {
        l = 0; r = 0;
        this.lpL.reset(); this.lpR.reset(); this.hpL.reset(); this.hpR.reset();
      }
      const lowMono = (this.lpL.process(l) + this.lpR.process(r)) * 0.5;
      outL[i] = lowMono + this.hpL.process(l);
      if (output[1]) outR[i] = lowMono + this.hpR.process(r);
    }
    return true;
  }
}

registerProcessor('bass-mono-processor', BassMonoProcessor);
