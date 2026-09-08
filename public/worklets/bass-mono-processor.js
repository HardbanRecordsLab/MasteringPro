/**
 * Bass Mono-Maker — AudioWorklet Processor
 *
 * Everything below `freq` is summed to mono (both channels get (L+R)/2);
 * everything above stays stereo. Linkwitz-Riley 2nd-order crossover so the
 * split sums flat. Essential for vinyl and club systems.
 *
 * Config: processorOptions / port message { freq }  (default 120 Hz)
 */

class LR2 {
  constructor(type) {
    this.type = type;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  set(sr, f) {
    const w0 = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const c = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    if (this.type === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class BassMonoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.freq = ((options && options.processorOptions) || {}).freq || 120;
    this.lpL = new LR2('lp'); this.lpR = new LR2('lp');
    this.hpL = new LR2('hp'); this.hpR = new LR2('hp');
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
      const l = inL[i], r = inR[i];
      const lowMono = (this.lpL.process(l) + this.lpR.process(r)) * 0.5;
      outL[i] = lowMono + this.hpL.process(l);
      if (output[1]) outR[i] = lowMono + this.hpR.process(r);
    }
    return true;
  }
}

registerProcessor('bass-mono-processor', BassMonoProcessor);
