/**
 * Mastering Compressor — AudioWorklet Processor
 *
 * Deterministic feed-forward compressor — identical result in every browser and in the offline render (unlike the native
 * DynamicsCompressor).
 *
 * - Detector: peak (instant attack, short fall-back) or RMS (5 ms mean-square window). It carries NO attack/release of its own.
 * - Gain computer: soft-knee static curve, in dB.
 * - Ballistics: the gain reduction is smoothed ONCE, in the dB domain, with one-pole attack / release. So the attack knob
 *   is the real time (to 63 %) the gain takes to follow, and the release knob the real recovery time. (An earlier version
 *   smoothed the detector AND the gain, which made the effective attack ≈ 3× the setting.)
 * - Auto release: the release lengthens when the compressor has been working hard for a while and shortens for brief peaks
 *   (driven by the long-term average of what the curve demands, not by the already-smoothed gain).
 * - Stereo modes: linked · mid/side · dual-mono (L/R independent). Parallel mix (0–100 %), manual or auto makeup.
 * - Posts { gr } (dB, max reduction in the block) ~30 Hz.
 *
 * Config via processorOptions + port messages:
 *   { threshold, ratio, attack, release, knee, makeup, mix,
 *     detect:'peak'|'rms', mode:'stereo'|'ms'|'dual', autoRelease, autoMakeup }
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Channel {
  constructor() { this.sq = 0; this.pk = 0; this.gr = 0; this.slow = 0; }

  /** returns the linear gain (≤ 1) for one sample */
  run(x, cfg) {
    // ---- detector ----
    let level;
    if (cfg.rms) {
      this.sq += (x * x - this.sq) * cfg.rmsK;
      level = Math.sqrt(this.sq);
    } else {
      const a = x < 0 ? -x : x;
      this.pk = a > this.pk ? a : this.pk * cfg.pkFall;
      level = this.pk;
    }

    // ---- gain computer (dB, soft knee) ----
    const lvlDb = 20 * Math.log10(level + 1e-9);
    const over = lvlDb - cfg.threshold;
    let target;
    if (cfg.knee > 0 && over > -cfg.knee / 2 && over < cfg.knee / 2) {
      const t = over + cfg.knee / 2;
      target = -(1 - 1 / cfg.ratio) * (t * t) / (2 * cfg.knee);
    } else {
      target = over > 0 ? -over * (1 - 1 / cfg.ratio) : 0;
    }

    // ---- ballistics in the dB domain ----
    let relC = cfg.relC;
    if (cfg.autoRelease) {
      this.slow += (-target - this.slow) * cfg.slowK;               // long-term average of what the curve demands
      const depth = clamp(this.slow / 8, 0, 1);
      relC = Math.exp(-1 / (cfg.sr * Math.max(1, cfg.relMs * (0.35 + 0.65 * depth)) * 0.001));
    }
    this.gr = target < this.gr ? cfg.atkC * (this.gr - target) + target : relC * (this.gr - target) + target;
    return Math.pow(10, this.gr / 20);
  }
}

class CompressorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.p = {
      threshold: -18, ratio: 2, attack: 20, release: 150, knee: 6,
      makeup: 0, mix: 100, detect: 'peak', mode: 'stereo',
      autoRelease: false, autoMakeup: false,
    };
    Object.assign(this.p, (options && options.processorOptions) || {});
    this.a = new Channel();
    this.b = new Channel();
    this._gr = 0;
    this._acc = 0;
    this._every = Math.floor(sampleRate / 30);
    this.port.onmessage = (e) => { if (e.data) Object.assign(this.p, e.data); };
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
    const p = this.p;

    const relMs = Math.max(1, p.release);
    const cfg = {
      sr,
      relMs,
      atkC: Math.exp(-1 / (sr * Math.max(0.05, p.attack) * 0.001)),
      relC: Math.exp(-1 / (sr * relMs * 0.001)),
      rmsK: 1 - Math.exp(-1 / (sr * 0.005)),
      // the peak detector may never fall slower than the release it feeds, nor faster than 30 ms (ripple on low tones)
      pkFall: Math.exp(-1 / (sr * Math.min(0.030, relMs * 0.0005) * 1)),
      slowK: 1 - Math.exp(-1 / (sr * 0.25)),
      rms: p.detect === 'rms',
      threshold: p.threshold,
      ratio: Math.max(1, p.ratio),
      knee: Math.max(0, p.knee),
      autoRelease: p.autoRelease,
    };

    const mixWet = Math.min(1, Math.max(0, p.mix / 100));
    const mixDry = 1 - mixWet;
    // auto makeup ≈ 60 % of the static reduction at 0 dBFS input
    let autoMk = 1;
    if (p.autoMakeup) {
      const overAt0 = 0 - p.threshold;
      const staticGr = overAt0 > 0 ? overAt0 * (1 - 1 / Math.max(1, p.ratio)) : 0;
      autoMk = Math.pow(10, (staticGr * 0.6) / 20);
    }
    const g = Math.pow(10, p.makeup / 20) * autoMk;

    let minGain = 1;

    for (let i = 0; i < N; i++) {
      const l = inL[i];
      const r = inR[i];
      let wl, wr;

      if (p.mode === 'ms') {
        const m = (l + r) * 0.5;
        const s = (l - r) * 0.5;
        const gm = this.a.run(m, cfg);
        const gs = this.b.run(s, cfg);
        if (gm < minGain) minGain = gm;
        if (gs < minGain) minGain = gs;
        const cm = m * gm;
        const cs = s * gs;
        wl = cm + cs;
        wr = cm - cs;
      } else if (p.mode === 'dual') {
        const gl = this.a.run(l, cfg);
        const gr = this.b.run(r, cfg);
        if (gl < minGain) minGain = gl;
        if (gr < minGain) minGain = gr;
        wl = l * gl;
        wr = r * gr;
      } else {
        // linked: detect on the louder channel, one gain for both
        const key = Math.abs(l) > Math.abs(r) ? l : r;
        const gg = this.a.run(key, cfg);
        if (gg < minGain) minGain = gg;
        wl = l * gg;
        wr = r * gg;
      }

      let oL = (wl * mixWet + l * mixDry) * g;
      let oR = (wr * mixWet + r * mixDry) * g;
      if (oL !== oL || oR !== oR || oL === Infinity || oL === -Infinity || oR === Infinity || oR === -Infinity) {
        // a NaN / Infinity in the input must not poison the state: pass the dry signal and start clean
        oL = l; oR = r;
        this.a = new Channel();
        this.b = new Channel();
      }
      outL[i] = oL;
      if (output[1]) outR[i] = oR;
    }

    this._gr = 20 * Math.log10(Math.max(minGain, 1e-6));
    this._acc += N;
    if (this._acc >= this._every) { this._acc = 0; this.port.postMessage({ gr: this._gr }); }
    return true;
  }
}

registerProcessor('compressor-processor', CompressorProcessor);
