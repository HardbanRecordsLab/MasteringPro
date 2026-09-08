/**
 * Real-time loudness meter — AudioWorklet Processor (BS.1770-4 / EBU R128)
 *
 * Dead-end tap on the post-chain bus. Applies K-weighting, then:
 *   - Momentary  (400 ms window)
 *   - Short-term (3 s window)
 *   - Integrated (gated: -70 LUFS absolute + -10 LU relative, since last reset)
 *   - LRA        (10th..95th percentile of gated 3 s blocks)
 * Posts { m, s, i, lra, maxM, maxS } every ~100 ms. Reset via port { reset:true }.
 *
 * K-weighting coefficients match src/lib/loudness.ts (sample-rate aware).
 */

function kHighShelf(sr) {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}
function kHighPass(sr) {
  const f0 = 38.13547087602444, Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sr);
  const a0 = 1 + K / Q + K * K;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  process(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const lufs = (ms) => -0.691 + 10 * Math.log10(ms > 0 ? ms : 1e-12);

class LoudnessMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.shL = new Biquad(kHighShelf(sr)); this.hpL = new Biquad(kHighPass(sr));
    this.shR = new Biquad(kHighShelf(sr)); this.hpR = new Biquad(kHighPass(sr));

    this.blockLen = Math.round(sr * 0.4);   // 400 ms
    this.hopLen = Math.round(sr * 0.1);     // 100 ms
    this.ringSq = new Float64Array(this.blockLen); // squared K-weighted L²+R², circular
    this.ringIdx = 0;
    this.sinceHop = 0;
    this.filled = 0;

    this.stBlocks = [];   // last 30 momentary blocks (→ 3 s short-term)
    this.gated = [];      // all momentary blocks since reset (mean square), for integrated
    this.stGated = [];    // short-term blocks for LRA
    this.maxM = -Infinity;
    this.maxS = -Infinity;
    this._post = 0;

    this.port.onmessage = (e) => { if (e.data && e.data.reset) this._reset(); };
  }

  _reset() {
    this.ringSq.fill(0);
    this.ringIdx = 0; this.sinceHop = 0; this.filled = 0;
    this.stBlocks = []; this.gated = []; this.stGated = [];
    this.maxM = -Infinity; this.maxS = -Infinity;
  }

  _integrated() {
    if (this.gated.length === 0) return -Infinity;
    const abs = this.gated.filter((m) => lufs(m) > -70);
    if (!abs.length) return -Infinity;
    const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
    const rel = lufs(mean) - 10;
    const g = abs.filter((m) => lufs(m) > rel);
    if (!g.length) return -Infinity;
    return lufs(g.reduce((s, v) => s + v, 0) / g.length);
  }

  _lra() {
    const above = this.stGated.filter((l) => l > -70);
    if (above.length < 2) return 0;
    const meanMs = above.reduce((s, l) => s + Math.pow(10, (l + 0.691) / 10), 0) / above.length;
    const thr = lufs(meanMs) - 20;
    const g = above.filter((l) => l > thr).sort((a, b) => a - b);
    if (g.length < 2) return 0;
    const pick = (p) => g[Math.min(g.length - 1, Math.max(0, Math.round(p * (g.length - 1))))];
    return Math.max(0, pick(0.95) - pick(0.1));
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] || input[0];
    const n = l.length;

    for (let i = 0; i < n; i++) {
      const wl = this.hpL.process(this.shL.process(l[i]));
      const wr = this.hpR.process(this.shR.process(r[i]));
      const sq = wl * wl + wr * wr; // channel-summed (L,R weight 1.0)

      // circular buffer of squared weighted samples
      this.ringSq[this.ringIdx] = sq;
      this.ringIdx = (this.ringIdx + 1) % this.blockLen;
      if (this.filled < this.blockLen) this.filled++;
      this.sinceHop++;

      if (this.sinceHop >= this.hopLen && this.filled >= this.blockLen) {
        this.sinceHop = 0;
        // mean square over the whole 400 ms ring
        let acc = 0;
        for (let k = 0; k < this.blockLen; k++) acc += this.ringSq[k];
        const ms = acc / this.blockLen;

        this.gated.push(ms);
        if (this.gated.length > 36000) this.gated.shift(); // ~1 h cap

        const mLufs = lufs(ms);
        if (mLufs > this.maxM) this.maxM = mLufs;

        this.stBlocks.push(ms);
        if (this.stBlocks.length > 30) this.stBlocks.shift(); // 3 s / 100 ms
        const sMs = this.stBlocks.reduce((s, v) => s + v, 0) / this.stBlocks.length;
        const sLufs = lufs(sMs);
        if (this.stBlocks.length === 30) {
          if (sLufs > this.maxS) this.maxS = sLufs;
          this.stGated.push(sLufs);
          if (this.stGated.length > 18000) this.stGated.shift();
        }

        this._post++;
        this.port.postMessage({
          m: mLufs,
          s: this.stBlocks.length >= 5 ? sLufs : -Infinity,
          i: this._integrated(),
          lra: this._lra(),
          maxM: this.maxM,
          maxS: this.maxS,
        });
      }
    }
    return true;
  }
}

registerProcessor('loudness-meter-processor', LoudnessMeterProcessor);
