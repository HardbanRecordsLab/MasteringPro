/**
 * Adaptive Resonance Suppressor — AudioWorklet Processor
 *
 * A Soothe / Gullfoss-class dynamic spectral processor. For every short-time
 * spectrum it estimates a smooth reference envelope (a 1/3-octave running mean
 * in the log-magnitude domain), finds the bins that stick out above that
 * envelope by more than `threshold` dB, and pulls just those bins down —
 * dynamically, per frame, with attack / release ballistics. Broadband tone is
 * left alone; ringing resonances, harsh peaks and sibilance are tamed.
 *
 *   input → STFT (2048 / 512, Hann·Hann WOLA) → per-bin dynamic gain → ISTFT → output
 *
 * Latency = one analysis window (2048 samples). Reported via a { type:'latency' }
 * port message, same contract as the lookahead limiter.
 *
 * Config (processorOptions + port messages):
 *   { enabled, amount (0..100), strength (0..1), depth (dB, max cut),
 *     threshold (dB above the envelope before it acts),
 *     attack (ms), release (ms), lowHz, highHz }
 *
 * Posts { grDb } — the deepest cut in the last frame — ~30 Hz for metering.
 */

const WIN = 2048;
const HOP = 512;
const HALF = WIN / 2;

// --- Hann analysis/synthesis window + WOLA normalisation ---
const WINDOW = new Float32Array(WIN);
for (let n = 0; n < WIN; n++) WINDOW[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WIN);
// Σ w[n-mH]^2 for Hann at 75 % overlap = 1.5 (constant) → analysis·synthesis scale
const WOLA = 1.5;

// --- radix-2 iterative FFT (in-place, separate real/imag) ---
const BITREV = new Uint16Array(WIN);
for (let i = 0; i < WIN; i++) {
  let x = i, r = 0;
  for (let b = 0; b < Math.log2(WIN); b++) { r = (r << 1) | (x & 1); x >>= 1; }
  BITREV[i] = r;
}
const COST = new Float32Array(HALF);
const SINT = new Float32Array(HALF);
for (let i = 0; i < HALF; i++) { COST[i] = Math.cos((-2 * Math.PI * i) / WIN); SINT[i] = Math.sin((-2 * Math.PI * i) / WIN); }

function fft(re, im, inverse) {
  for (let i = 0; i < WIN; i++) {
    const j = BITREV[i];
    if (j > i) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let size = 2; size <= WIN; size <<= 1) {
    const half = size >> 1;
    const step = WIN / size;
    for (let i = 0; i < WIN; i += size) {
      for (let k = 0; k < half; k++) {
        const ti = k * step;
        const c = COST[ti];
        const s = inverse ? -SINT[ti] : SINT[ti];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * c - im[b] * s;
        const xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < WIN; i++) { re[i] /= WIN; im[i] /= WIN; }
}

class SpectralChannel {
  constructor() {
    this.inBuf = new Float32Array(WIN);
    this.inFill = 0;
    this.outRing = new Float32Array(WIN); // overlap-add accumulator (ring)
    this.outRead = 0;
    this.primed = false;
    this.re = new Float32Array(WIN);
    this.im = new Float32Array(WIN);
    this.binGainDb = new Float32Array(HALF + 1); // per-bin smoothed reduction (<=0)
    this.magDb = new Float32Array(HALF + 1);     // scratch, reused every frame
    this.pre = new Float64Array(HALF + 2);       // scratch prefix sum
    this.tgt = new Float32Array(HALF + 1);       // scratch per-bin target cut (dB)
    this.deepestDb = 0;
  }

  /** push one input sample, return one output sample (delayed by ~WIN) */
  tick(x, p, sr) {
    this.inBuf[this.inFill++] = x;

    if (this.inFill === WIN) {
      this._frame(p, sr);
      this.inBuf.copyWithin(0, HOP); // slide input by HOP
      this.inFill = WIN - HOP;
      this.primed = true;
    }

    const y = this.primed ? this.outRing[this.outRead] : 0;
    this.outRing[this.outRead] = 0;
    this.outRead = (this.outRead + 1) % WIN;
    return y;
  }

  _frame(p, sr) {
    const re = this.re, im = this.im;
    for (let n = 0; n < WIN; n++) { re[n] = this.inBuf[n] * WINDOW[n]; im[n] = 0; }
    fft(re, im, false);

    // magnitude (dB) for the lower half
    const magDb = this.magDb;
    for (let k = 0; k <= HALF; k++) {
      const m = Math.hypot(re[k], im[k]) + 1e-12;
      magDb[k] = 20 * Math.log10(m);
    }

    // 1/3-octave running mean of magDb via a prefix sum → reference envelope
    const pre = this.pre;
    pre[0] = 0;
    for (let k = 0; k <= HALF; k++) pre[k + 1] = pre[k] + magDb[k];
    const binHz = sr / WIN;
    const RATIO = Math.pow(2, 1 / 6); // half of a 1/3-octave, each side

    const loBin = Math.max(1, Math.floor(p.lowHz / binHz));
    const hiBin = Math.min(HALF, Math.ceil(p.highHz / binHz));

    const amt = Math.min(1, Math.max(0, p.amount / 100));
    const strength = Math.min(1, Math.max(0, p.strength)) * (0.4 + 0.6 * amt);
    const maxCut = -Math.abs(p.depth) * (0.3 + 0.7 * amt);
    const thr = p.threshold;

    const atk = Math.exp(-HOP / (sr * Math.max(0.001, p.attack * 0.001)));
    const rel = Math.exp(-HOP / (sr * Math.max(0.001, p.release * 0.001)));

    // pass 1 — raw per-bin target cut (dB) from the envelope excess
    const tgt = this.tgt;
    tgt[0] = 0;
    for (let k = 1; k <= HALF; k++) {
      let t = 0;
      if (p.enabled && k >= loBin && k <= hiBin) {
        const a = Math.max(0, Math.floor(k / RATIO));
        const b = Math.min(HALF, Math.ceil(k * RATIO));
        const refDb = (pre[b + 1] - pre[a]) / (b - a + 1);
        const excess = magDb[k] - refDb - thr;
        if (excess > 0) t = Math.max(maxCut, -excess * strength);
      }
      tgt[k] = t;
    }

    // pass 2 — smooth the target across frequency (5-tap triangular) so a
    // single bin never gets a hole punched next to an untouched neighbour
    // (that mismatch is what makes STFT suppressors "chirp"). In place is fine
    // reading forward because the kernel only looks back 2 bins via magDb-free
    // temporaries.
    let m2 = tgt[1], m1 = tgt[1];
    let deepest = 0;
    for (let k = 1; k <= HALF; k++) {
      const cur = tgt[k];
      const nx1 = k + 1 <= HALF ? tgt[k + 1] : cur;
      const nx2 = k + 2 <= HALF ? tgt[k + 2] : nx1;
      const smoothed = (m2 + 2 * m1 + 3 * cur + 2 * nx1 + nx2) / 9;
      m2 = m1; m1 = cur;

      // ballistics: fast toward a deeper cut, slow to recover
      const prev = this.binGainDb[k];
      const coef = smoothed < prev ? atk : rel;
      const g = smoothed + (prev - smoothed) * coef;
      this.binGainDb[k] = g;
      if (g < deepest) deepest = g;

      const lin = Math.pow(10, g / 20);
      re[k] *= lin; im[k] *= lin;
      if (k > 0 && k < HALF) { re[WIN - k] *= lin; im[WIN - k] *= lin; }
    }
    this.deepestDb = deepest;

    fft(re, im, true);
    // synthesis window + overlap-add into the output ring, starting at outRead
    const scale = 1 / WOLA;
    for (let n = 0; n < WIN; n++) {
      this.outRing[(this.outRead + n) % WIN] += re[n] * WINDOW[n] * scale;
    }
  }
}

class ResonanceSuppressorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.p = {
      enabled: false, amount: 50, strength: 0.7, depth: 12, threshold: 6,
      attack: 12, release: 120, lowHz: 100, highHz: 18000,
    };
    Object.assign(this.p, (options && options.processorOptions) || {});
    this.L = new SpectralChannel();
    this.R = new SpectralChannel();
    this._acc = 0;
    this._every = Math.floor(sampleRate / 30);
    this._gr = 0;
    this.port.onmessage = (e) => { if (e.data) Object.assign(this.p, e.data); };
    this.port.postMessage({ type: 'latency', samples: WIN });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output[1] || output[0];
    const n = outL.length;

    if (!input || input.length === 0) { outL.fill(0); if (output[1]) outR.fill(0); return true; }
    const inL = input[0];
    const inR = input[1] || input[0];
    const sr = sampleRate;
    const p = this.p;

    if (!p.enabled) {
      // still run the delay lines so latency compensation stays valid
      for (let i = 0; i < n; i++) {
        const yl = this.L.tick(inL[i], p, sr);
        const yr = this.R.tick(inR[i], p, sr);
        outL[i] = this.L.primed ? yl : 0;
        if (output[1]) outR[i] = this.R.primed ? yr : 0;
      }
      // when disabled, bypass cleanly once primed (targets already relax to 0)
      return true;
    }

    let deepest = 0;
    for (let i = 0; i < n; i++) {
      outL[i] = this.L.tick(inL[i], p, sr);
      if (output[1]) outR[i] = this.R.tick(inR[i], p, sr);
      if (this.L.deepestDb < deepest) deepest = this.L.deepestDb;
      if (this.R.deepestDb < deepest) deepest = this.R.deepestDb;
    }

    this._gr = deepest;
    this._acc += n;
    if (this._acc >= this._every) { this._acc = 0; this.port.postMessage({ grDb: this._gr }); }
    return true;
  }
}

registerProcessor('resonance-suppressor-processor', ResonanceSuppressorProcessor);
