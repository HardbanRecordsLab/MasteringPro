/**
 * 3-band Multiband Compressor — AudioWorklet Processor
 *
 * Linkwitz-Riley 4th-order crossovers (cascaded Butterworth biquads) split the
 * stereo signal into low / mid / high. Each band gets an independent feed-forward
 * compressor (peak detector, soft knee, attack/release ballistics, makeup). Bands
 * are phase-aligned (the low band passes an allpass matching crossover 2) so they
 * sum back flat.
 *
 * Config arrives by port message:
 *   { xover1, xover2, bands: [lo, mid, hi] }
 *   band = { threshold(dB), ratio, attack(ms), release(ms), knee(dB), makeup(dB) }
 *
 * Posts per-band gain reduction (dB) ~30 Hz for metering.
 */

class LR4 {
  // Two cascaded 2nd-order Butterworth sections = 24 dB/oct Linkwitz-Riley.
  constructor(type) {
    this.type = type; // 'lp' | 'hp'
    this.s = [
      { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 },
      { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 },
    ];
    // target coefficients (slewed toward, ~5 ms) so crossover moves don't click
    this.t = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    this.first = true;
    this.slew = 1 - Math.exp(-1 / (sampleRate * 0.005));
  }
  setFreq(sr, f) {
    const w0 = (2 * Math.PI * f) / sr;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 0.7071 (Butterworth)
    const a0 = 1 + alpha;
    let b0, b1, b2;
    if (this.type === 'lp') {
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
    } else {
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
    }
    this.t.b0 = b0 / a0; this.t.b1 = b1 / a0; this.t.b2 = b2 / a0;
    this.t.a1 = (-2 * cosw) / a0; this.t.a2 = (1 - alpha) / a0;
    if (this.first) {
      for (const s of this.s) Object.assign(s, this.t);
      this.first = false;
    }
  }
  process(x) {
    const t = this.t;
    const k = this.slew;
    for (const s of this.s) {
      s.b0 += (t.b0 - s.b0) * k; s.b1 += (t.b1 - s.b1) * k; s.b2 += (t.b2 - s.b2) * k;
      s.a1 += (t.a1 - s.a1) * k; s.a2 += (t.a2 - s.a2) * k;
      const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
      s.x2 = s.x1; s.x1 = x;
      s.y2 = s.y1; s.y1 = y;
      x = y;
    }
    return x;
  }
}

class BandComp {
  constructor() {
    this.envL = 0; this.envR = 0;
    this.gain = 1;
    this.cfg = { threshold: -18, ratio: 2, attack: 15, release: 150, knee: 6, makeup: 0 };
    this.grDb = 0;
  }
  set(cfg) { Object.assign(this.cfg, cfg); }
  process(l, r, sr) {
    const { threshold, ratio, attack, release, knee } = this.cfg;
    const atkC = Math.exp(-1 / (sr * Math.max(0.1, attack) * 0.001));
    const relC = Math.exp(-1 / (sr * Math.max(1, release) * 0.001));
    const al = Math.abs(l), ar = Math.abs(r);
    this.envL = al > this.envL ? atkC * (this.envL - al) + al : relC * (this.envL - al) + al;
    this.envR = ar > this.envR ? atkC * (this.envR - ar) + ar : relC * (this.envR - ar) + ar;
    const env = Math.max(this.envL, this.envR);
    const levelDb = 20 * Math.log10(env + 1e-9);

    // soft-knee static curve → target gain reduction
    let grDb = 0;
    const over = levelDb - threshold;
    if (knee > 0 && over > -knee / 2 && over < knee / 2) {
      const x = over + knee / 2;
      grDb = (1 - 1 / ratio) * (x * x) / (2 * knee);
    } else if (over >= knee / 2) {
      grDb = over * (1 - 1 / ratio);
    }
    const targetGain = Math.pow(10, -grDb / 20);
    // gain smoothing shares the band ballistics
    this.gain = targetGain < this.gain
      ? atkC * (this.gain - targetGain) + targetGain
      : relC * (this.gain - targetGain) + targetGain;
    this.grDb = 20 * Math.log10(Math.max(this.gain, 1e-6));

    const m = Math.pow(10, this.cfg.makeup / 20) * this.gain;
    return [l * m, r * m];
  }
}

class MultibandCompProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const init = (options && options.processorOptions) || {};
    this.xover1 = typeof init.xover1 === 'number' ? init.xover1 : 120;
    this.xover2 = typeof init.xover2 === 'number' ? init.xover2 : 2500;
    this.lp1L = new LR4('lp'); this.hp1L = new LR4('hp');
    this.lp2L = new LR4('lp'); this.hp2L = new LR4('hp');
    this.lp1R = new LR4('lp'); this.hp1R = new LR4('hp');
    this.lp2R = new LR4('lp'); this.hp2R = new LR4('hp');
    // allpass on the low band = LP2 + HP2 of the low signal, matching crossover 2
    this.apLoL_lp = new LR4('lp'); this.apLoL_hp = new LR4('hp');
    this.apLoR_lp = new LR4('lp'); this.apLoR_hp = new LR4('hp');
    this.low = new BandComp(); this.mid = new BandComp(); this.high = new BandComp();
    if (Array.isArray(init.bands)) {
      this.low.set(init.bands[0] || {});
      this.mid.set(init.bands[1] || {});
      this.high.set(init.bands[2] || {});
    }
    this._updateFilters();
    this._meterAcc = 0;
    this._meterEvery = Math.floor(sampleRate / 30);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.xover1 === 'number') this.xover1 = d.xover1;
      if (typeof d.xover2 === 'number') this.xover2 = d.xover2;
      if (Array.isArray(d.bands)) {
        this.low.set(d.bands[0] || {});
        this.mid.set(d.bands[1] || {});
        this.high.set(d.bands[2] || {});
      }
      this._updateFilters();
    };
  }

  _updateFilters() {
    const sr = sampleRate;
    const f1 = Math.min(this.xover1, this.xover2 - 20);
    const f2 = Math.max(this.xover2, f1 + 20);
    for (const b of [this.lp1L, this.hp1L, this.lp1R, this.hp1R]) b.setFreq(sr, f1);
    for (const b of [this.lp2L, this.hp2L, this.lp2R, this.hp2R]) b.setFreq(sr, f2);
    for (const b of [this.apLoL_lp, this.apLoL_hp, this.apLoR_lp, this.apLoR_hp]) b.setFreq(sr, f2);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const inL = input[0];
    const inR = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const N = inL.length;
    const sr = sampleRate;

    for (let i = 0; i < N; i++) {
      const l = inL[i];
      const r = inR[i];

      // split
      let lowL = this.lp1L.process(l);
      let lowR = this.lp1R.process(r);
      const rest1L = this.hp1L.process(l);
      const rest1R = this.hp1R.process(r);
      const midL = this.lp2L.process(rest1L);
      const midR = this.lp2R.process(rest1R);
      const highL = this.hp2L.process(rest1L);
      const highR = this.hp2R.process(rest1R);
      // phase-align the low band with the 2nd crossover
      lowL = this.apLoL_lp.process(lowL) + this.apLoL_hp.process(lowL);
      lowR = this.apLoR_lp.process(lowR) + this.apLoR_hp.process(lowR);

      // compress per band
      const [cl0, cr0] = this.low.process(lowL, lowR, sr);
      const [cl1, cr1] = this.mid.process(midL, midR, sr);
      const [cl2, cr2] = this.high.process(highL, highR, sr);

      outL[i] = cl0 + cl1 + cl2;
      if (output[1]) outR[i] = cr0 + cr1 + cr2;
    }

    this._meterAcc += N;
    if (this._meterAcc >= this._meterEvery) {
      this._meterAcc = 0;
      this.port.postMessage({ gr: [this.low.grDb, this.mid.grDb, this.high.grDb] });
    }
    return true;
  }
}

registerProcessor('multiband-comp-processor', MultibandCompProcessor);
