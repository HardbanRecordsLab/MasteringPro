/**
 * Mastering Compressor — AudioWorklet Processor
 *
 * Deterministic feed-forward compressor — identical result in every browser and
 * in the offline render (unlike the native DynamicsCompressor).
 *
 * - Peak or RMS detection (5 ms window), log-domain gain computer, soft knee
 * - Attack / release ballistics; optional program-dependent (auto) release
 * - Stereo modes: linked · mid/side · dual-mono (L/R independent)
 * - Parallel mix (0–100 %), manual or auto makeup
 * - Posts { gr } (dB, max reduction in the block) ~30 Hz
 *
 * Config via processorOptions + port messages:
 *   { threshold, ratio, attack, release, knee, makeup, mix,
 *     detect:'peak'|'rms', mode:'stereo'|'ms'|'dual', autoRelease, autoMakeup }
 */

class Channel {
  constructor() { this.env = 0; this.sq = 0; this.g = 1; }

  /** returns smoothed linear gain for one sample */
  run(x, cfg) {
    // ---- detector ----
    let level;
    if (cfg.rms) {
      this.sq = cfg.rmsC * this.sq + (1 - cfg.rmsC) * x * x;
      level = Math.sqrt(this.sq);
    } else {
      level = Math.abs(x);
    }
    const dC = level > this.env ? cfg.atkC : cfg.relC;
    this.env = dC * (this.env - level) + level;

    // ---- gain computer (dB, soft knee) ----
    const lvlDb = 20 * Math.log10(this.env + 1e-9);
    const over = lvlDb - cfg.threshold;
    let grDb;
    if (cfg.knee > 0 && over > -cfg.knee / 2 && over < cfg.knee / 2) {
      const t = over + cfg.knee / 2;
      grDb = -(1 - 1 / cfg.ratio) * (t * t) / (2 * cfg.knee);
    } else {
      grDb = over > 0 ? -over * (1 - 1 / cfg.ratio) : 0;
    }
    const target = Math.pow(10, grDb / 20);

    // ---- gain smoothing ----
    // program-dependent release: recover faster after brief peaks
    const rel = cfg.autoRelease && this.g < 0.85 ? cfg.relFastC : cfg.relC;
    const sC = target < this.g ? cfg.atkC : rel;
    this.g = sC * (this.g - target) + target;
    return this.g;
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
      atkC: Math.exp(-1 / (sr * Math.max(0.05, p.attack) * 0.001)),
      relC: Math.exp(-1 / (sr * relMs * 0.001)),
      relFastC: Math.exp(-1 / (sr * relMs * 0.35 * 0.001)),
      rmsC: Math.exp(-1 / (sr * 0.005)),
      rms: p.detect === 'rms',
      threshold: p.threshold,
      ratio: Math.max(1, p.ratio),
      knee: Math.max(0, p.knee),
      autoRelease: p.autoRelease,
    };

    const mixWet = Math.min(1, Math.max(0, p.mix / 100));
    const mixDry = 1 - mixWet;
    // auto makeup ≈ half the static reduction at 0 dBFS input
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

      outL[i] = (wl * mixWet + l * mixDry) * g;
      if (output[1]) outR[i] = (wr * mixWet + r * mixDry) * g;
    }

    this._gr = 20 * Math.log10(Math.max(minGain, 1e-6));
    this._acc += N;
    if (this._acc >= this._every) { this._acc = 0; this.port.postMessage({ gr: this._gr }); }
    return true;
  }
}

registerProcessor('compressor-processor', CompressorProcessor);
