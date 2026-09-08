/**
 * De-esser + Dynamic EQ band — AudioWorklet Processor
 *
 * Two independent processors in one node:
 *  1. De-esser — a band around `deEssFreq` (default 6.5 kHz) is level-detected and
 *     turned down only when it exceeds threshold (split-band, so the rest of the
 *     signal is untouched).
 *  2. Dynamic EQ band — one peaking band whose gain is driven by the level in
 *     that band: cut when loud (tame resonances) or boost when quiet.
 *
 * Config via processorOptions and port messages:
 *   { deEss:{ enabled, freq, threshold(dB), range(dB), attack(ms), release(ms) },
 *     dyn:  { enabled, freq, q, threshold(dB), range(dB), attack(ms), release(ms), mode:'cut'|'boost' } }
 *
 * Posts { deEssGR, dynGR } (dB) ~30 Hz.
 */

class BP {
  // simple state-variable bandpass, used for detection / de-ess split
  constructor() { this.lp = 0; this.bp = 0; this.f = 0; this.q = 1; }
  set(sr, freq, q) {
    this.f = 2 * Math.sin((Math.PI * Math.min(freq, sr * 0.45)) / sr);
    this.q = 1 / Math.max(0.5, q);
  }
  process(x) {
    this.lp += this.f * this.bp;
    const hp = x - this.lp - this.q * this.bp;
    this.bp += this.f * hp;
    return this.bp;
  }
}

class Peak {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(sr, freq, q, dbGain) {
    const A = Math.pow(10, dbGain / 40);
    const w0 = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
    const c = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * c) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const env = (cur, x, atk, rel) => (x > cur ? atk * (cur - x) + x : rel * (cur - x) + x);

class DynamicsEqProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.deEss = { enabled: false, freq: 6500, threshold: -28, range: 8, attack: 1, release: 60 };
    this.dyn = { enabled: false, freq: 300, q: 2, threshold: -24, range: 6, attack: 10, release: 120, mode: 'cut' };
    Object.assign(this.deEss, o.deEss || {});
    Object.assign(this.dyn, o.dyn || {});

    this.sibL = new BP(); this.sibR = new BP();
    this.detL = new BP(); this.detR = new BP();
    this.dynPeakL = new Peak(); this.dynPeakR = new Peak();
    this.eDeL = 0; this.eDeR = 0; this.eDyL = 0; this.eDyR = 0;
    this.deGain = 1; this.dynDb = 0;
    this._acc = 0; this._every = Math.floor(sampleRate / 30);
    this._grDe = 0;
    this._updateFilters();

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.deEss) Object.assign(this.deEss, d.deEss);
      if (d.dyn) Object.assign(this.dyn, d.dyn);
      this._updateFilters();
    };
  }

  _updateFilters() {
    const sr = sampleRate;
    for (const b of [this.sibL, this.sibR]) b.set(sr, this.deEss.freq, 1.4);
    for (const b of [this.detL, this.detR]) b.set(sr, this.dyn.freq, this.dyn.q);
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

    const deAtk = Math.exp(-1 / (sr * Math.max(0.1, this.deEss.attack) * 0.001));
    const deRel = Math.exp(-1 / (sr * Math.max(1, this.deEss.release) * 0.001));
    const dynAtk = Math.exp(-1 / (sr * Math.max(0.1, this.dyn.attack) * 0.001));
    const dynRel = Math.exp(-1 / (sr * Math.max(1, this.dyn.release) * 0.001));
    const deThr = Math.pow(10, this.deEss.threshold / 20);
    const dynThrDb = this.dyn.threshold;

    let minDeGain = 1;
    let maxDynDb = 0;

    for (let i = 0; i < N; i++) {
      let l = inL[i];
      let r = inR[i];

      // ---- de-esser (split band) ----
      if (this.deEss.enabled) {
        const sl = this.sibL.process(l);
        const sr2 = this.sibR.process(r);
        const d = Math.max(Math.abs(sl), Math.abs(sr2));
        this.eDeL = env(this.eDeL, d, deAtk, deRel);
        let g = 1;
        if (this.eDeL > deThr) {
          const overDb = 20 * Math.log10(this.eDeL / deThr);
          const redDb = Math.min(this.deEss.range, overDb);
          g = Math.pow(10, -redDb / 20);
        }
        this.deGain = g < this.deGain ? deAtk * (this.deGain - g) + g : deRel * (this.deGain - g) + g;
        if (this.deGain < minDeGain) minDeGain = this.deGain;
        // subtract the sib band and add it back attenuated
        l = l - sl + sl * this.deGain;
        r = r - sr2 + sr2 * this.deGain;
      }

      // ---- dynamic EQ band ----
      if (this.dyn.enabled) {
        const dl = this.detL.process(l);
        const dr = this.detR.process(r);
        const d = Math.max(Math.abs(dl), Math.abs(dr));
        this.eDyL = env(this.eDyL, d, dynAtk, dynRel);
        const lvlDb = 20 * Math.log10(this.eDyL + 1e-9);
        let moveDb = 0;
        if (this.dyn.mode === 'cut') {
          if (lvlDb > dynThrDb) moveDb = -Math.min(this.dyn.range, lvlDb - dynThrDb);
        } else {
          if (lvlDb < dynThrDb) moveDb = Math.min(this.dyn.range, dynThrDb - lvlDb);
        }
        this.dynDb = dynAtk * (this.dynDb - moveDb) + moveDb;
        if (Math.abs(this.dynDb) > Math.abs(maxDynDb)) maxDynDb = this.dynDb;
        this.dynPeakL.set(sr, this.dyn.freq, this.dyn.q, this.dynDb);
        this.dynPeakR.set(sr, this.dyn.freq, this.dyn.q, this.dynDb);
        l = this.dynPeakL.process(l);
        r = this.dynPeakR.process(r);
      }

      outL[i] = l;
      if (output[1]) outR[i] = r;
    }

    this._grDe = 20 * Math.log10(Math.max(minDeGain, 1e-6));
    this._acc += N;
    if (this._acc >= this._every) {
      this._acc = 0;
      this.port.postMessage({ deEssGR: this._grDe, dynGR: maxDynDb });
    }
    return true;
  }
}

registerProcessor('dynamics-eq-processor', DynamicsEqProcessor);
