/**
 * Multiband Compressor 2.0 — AudioWorklet Processor (3 … 6 bands)
 *
 * Signal path
 *   input → Linkwitz-Riley 4th-order crossover tree → N bands → per-band compressor → sum
 *
 *   The tree is sequential: band k = LP_k( HP_{k-1}( … HP_0(x) ) ). Each band below the top is then passed through
 *   a 2nd-order allpass for every crossover ABOVE it (Q = 1/√2). An LR4 low+high pair sums to exactly that allpass, so the
 *   bands recombine with perfectly flat magnitude and no phase cancellation at any crossover.
 *
 * Per band
 *   - detector: RMS / peak blend (`detect` 0…1), RMS scaled so a sine reads the same in both modes
 *   - stereo link (`link` 0…1): 1 = one gain for both channels (stable image), 0 = independent channels
 *   - soft-knee downward curve (threshold, ratio, knee) and an optional gentle upward lift (`upward`)
 *   - gain smoothing in the dB domain with attack / release; `autoRelease` lengthens the release when the band has been
 *     working hard for a while and shortens it for brief peaks (program-dependent)
 *   - makeup gain, a per-band maximum reduction (`range`), per-band enable
 *
 * Global: `mix` (parallel compression), `lookahead` (ms, audio is delayed so the gain is already down when a peak
 * arrives — the dry path is delayed identically), `monitor` (-1 off, -2 delta = what the compressor removed, ≥ 0 solo band).
 *
 * Config (processorOptions and port message):
 *   { xovers: [f1 … f(N-1)]            // legacy: xover1, xover2 with 3 bands
 *     bands:  [ { threshold, ratio, attack, release, knee, makeup, upward?, link?, detect?, autoRelease?, range?, enabled? } … ],
 *     mix?, lookahead?, monitor? }
 * Posts { gr: [dB per band], lvl: [dB per band] } about 30 times a second.
 */

const SQRT2 = Math.SQRT2;
const MAX_BANDS = 6;
const MAX_LOOKAHEAD_MS = 5;

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.t0 = 1; this.t1 = 0; this.t2 = 0; this.ta1 = 0; this.ta2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  /** set TARGET coefficients (the live ones glide toward them once per block) */
  target(b0, b1, b2, a1, a2, snap) {
    this.t0 = b0; this.t1 = b1; this.t2 = b2; this.ta1 = a1; this.ta2 = a2;
    if (snap) { this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; }
  }
  glide(k) {
    this.b0 += (this.t0 - this.b0) * k; this.b1 += (this.t1 - this.b1) * k; this.b2 += (this.t2 - this.b2) * k;
    this.a1 += (this.ta1 - this.a1) * k; this.a2 += (this.ta2 - this.a2) * k;
  }
  /** transposed direct form II */
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  flush() {
    if (Math.abs(this.z1) < 1e-20) this.z1 = 0;
    if (Math.abs(this.z2) < 1e-20) this.z2 = 0;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}

function butterworth(type, sr, f, biquad, snap) {
  const w0 = (2 * Math.PI * f) / sr;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2; }
  else { b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2; }
  biquad.target(b0 / a0, b1 / a0, b2 / a0, (-2 * cosw) / a0, (1 - alpha) / a0, snap);
}

function allpass(sr, f, biquad, snap) {
  const w0 = (2 * Math.PI * f) / sr;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  biquad.target((1 - alpha) / a0, (-2 * cosw) / a0, (1 + alpha) / a0, (-2 * cosw) / a0, (1 - alpha) / a0, snap);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const toDb = (v) => 20 * Math.log10(v + 1e-12);

const DEFAULT_BAND = {
  threshold: -18, ratio: 2, attack: 15, release: 150, knee: 6, makeup: 0,
  upward: 0, link: 1, detect: 0.3, autoRelease: true, range: 24, enabled: true,
};

class BandComp {
  constructor() {
    this.cfg = Object.assign({}, DEFAULT_BAND);
    // detector state, per channel
    this.rmsL = 0; this.rmsR = 0;       // mean-square envelopes
    this.pkL = 0; this.pkR = 0;         // peak envelopes
    this.grL = 0; this.grR = 0;         // smoothed gain (dB, ≤ 0 downward)
    this.slowGr = 0;                    // long-term average depth of reduction (dB), drives auto-release
    this.lvlDb = -120;
    this.gainL = 1; this.gainR = 1;
    this._derive();
  }
  set(c) { Object.assign(this.cfg, c || {}); this._derive(); }
  _derive() {
    const c = this.cfg;
    const sr = sampleRate;
    this.atk = Math.exp(-1 / (sr * Math.max(0.05, c.attack) * 0.001));
    this.relBase = Math.max(1, c.release);
    this.rel = Math.exp(-1 / (sr * this.relBase * 0.001));
    this.rmsCoef = 1 - Math.exp(-1 / (sr * 0.010));     // 10 ms mean-square window
    this.pkRel = Math.exp(-1 / (sr * 0.020));           // 20 ms peak fall-back
    this.slowCoef = 1 - Math.exp(-1 / (sr * 0.250));
    this.makeupLin = Math.pow(10, c.makeup / 20);
  }
  /** called every few samples: auto-release depends on how deep the band has been working */
  retime() {
    const c = this.cfg;
    if (!c.autoRelease) return;
    const depth = clamp(this.slowGr / 8, 0, 1);   // slowGr is the (positive) average depth of reduction in dB
    const eff = this.relBase * (0.35 + 0.65 * depth);
    this.rel = Math.exp(-1 / (sampleRate * Math.max(1, eff) * 0.001));
  }
  /** static curve: level (dB) → gain change (dB) */
  curve(levelDb) {
    const c = this.cfg;
    const over = levelDb - c.threshold;
    let g = 0;
    if (c.ratio > 1) {
      const k = c.knee;
      if (k > 0 && over > -k / 2 && over < k / 2) {
        const x = over + k / 2;
        g = -(1 - 1 / c.ratio) * (x * x) / (2 * k);
      } else if (over >= k / 2) {
        g = -over * (1 - 1 / c.ratio);
      }
    }
    if (c.upward > 0 && levelDb > -60) {
      const below = (c.threshold - 15) - levelDb;          // only well under the threshold, never into the noise floor
      if (below > 0) g += Math.min(6, below * 0.5 * c.upward);
    }
    return Math.max(g, -c.range);
  }
  /** updates this.gainL / this.gainR (linear, makeup included) from the detector input (l, r); no allocation */
  gains(l, r) {
    const c = this.cfg;
    const al = Math.abs(l), ar = Math.abs(r);
    this.rmsL += (l * l - this.rmsL) * this.rmsCoef;
    this.rmsR += (r * r - this.rmsR) * this.rmsCoef;
    this.pkL = al > this.pkL ? al : this.pkL * this.pkRel + al * (1 - this.pkRel);
    this.pkR = ar > this.pkR ? ar : this.pkR * this.pkRel + ar * (1 - this.pkRel);
    const d = c.detect;
    const levL = (1 - d) * Math.sqrt(this.rmsL) * SQRT2 + d * this.pkL;
    const levR = (1 - d) * Math.sqrt(this.rmsR) * SQRT2 + d * this.pkR;
    const dbL = toDb(levL), dbR = toDb(levR);
    const mx = dbL > dbR ? dbL : dbR;
    const link = c.link;
    const cL = this.curve(link * mx + (1 - link) * dbL);
    const cR = link >= 1 ? cL : this.curve(link * mx + (1 - link) * dbR);
    this.lvlDb = mx;
    // attack / release in the dB domain
    this.grL = cL < this.grL ? this.atk * (this.grL - cL) + cL : this.rel * (this.grL - cL) + cL;
    this.grR = link >= 1 ? this.grL : (cR < this.grR ? this.atk * (this.grR - cR) + cR : this.rel * (this.grR - cR) + cR);
    // long-term average of what the curve DEMANDS (not of the smoothed gain, which would feed on its own slow release)
    const demand = -(cL < cR ? cL : cR);
    this.slowGr += ((demand > 0 ? demand : 0) - this.slowGr) * this.slowCoef;
    if (!c.enabled) { this.gainL = 1; this.gainR = 1; return; }
    this.gainL = Math.pow(10, this.grL / 20) * this.makeupLin;
    this.gainR = link >= 1 ? this.gainL : Math.pow(10, this.grR / 20) * this.makeupLin;
  }
  reset() { this.rmsL = this.rmsR = this.pkL = this.pkR = this.grL = this.grR = this.slowGr = 0; }
}

class DelayLine {
  constructor(max) { this.buf = new Float32Array(max + 1); this.w = 0; this.len = max + 1; }
  /** push x, read the sample `d` samples ago */
  process(x, d) {
    this.buf[this.w] = x;
    let r = this.w - d;
    if (r < 0) r += this.len;
    this.w = this.w + 1 === this.len ? 0 : this.w + 1;
    return this.buf[r];
  }
  reset() { this.buf.fill(0); this.w = 0; }
}

class MultibandCompProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.n = 0;
    this.xovers = [];
    this.mix = 1;
    this.lookahead = 0;
    this.monitor = -1;
    this.bands = [];
    this._maxDelay = Math.ceil((sampleRate * MAX_LOOKAHEAD_MS) / 1000) + 2;
    this._meterAcc = 0;
    this._meterEvery = Math.floor(sampleRate / 30);
    this._glide = 1 - Math.exp(-128 / (sampleRate * 0.005));  // ≈ 5 ms to reach a moved crossover
    this._configure((options && options.processorOptions) || {}, true);
    this.port.onmessage = (e) => this._configure(e.data || {}, false);
  }

  _configure(d, first) {
    // legacy 3-band message: xover1 / xover2
    let xovers = d.xovers;
    if (!Array.isArray(xovers) && typeof d.xover1 === 'number' && typeof d.xover2 === 'number') xovers = [d.xover1, d.xover2];
    let bandCfg = Array.isArray(d.bands) ? d.bands : null;

    const wantN = bandCfg ? clamp(bandCfg.length, 2, MAX_BANDS) : (this.n || 3);
    if (wantN !== this.n) this._build(wantN);
    if (Array.isArray(xovers)) this.xovers = xovers.slice(0, this.n - 1).map(Number);
    if (this.xovers.length < this.n - 1) {
      // sensible defaults, log-spaced between 100 Hz and 8 kHz
      const out = [];
      for (let i = 0; i < this.n - 1; i++) out.push(100 * Math.pow(80, i / Math.max(1, this.n - 2)));
      this.xovers = this.xovers.concat(out.slice(this.xovers.length));
    }
    if (bandCfg) for (let i = 0; i < this.n; i++) this.bands[i].set(bandCfg[i] || {});
    if (typeof d.mix === 'number') this.mix = clamp(d.mix, 0, 1);
    if (typeof d.lookahead === 'number') this.lookahead = Math.round((clamp(d.lookahead, 0, MAX_LOOKAHEAD_MS) * sampleRate) / 1000);
    if (typeof d.monitor === 'number') this.monitor = d.monitor;
    this._updateFilters(first);
  }

  _build(n) {
    this.n = n;
    const k = n - 1;
    this.lp = []; this.hp = []; this.ap = [];
    for (let c = 0; c < 2; c++) {
      // per channel: for each crossover two LP and two HP biquads (LR4)
      this.lp.push(Array.from({ length: k }, () => [new Biquad(), new Biquad()]));
      this.hp.push(Array.from({ length: k }, () => [new Biquad(), new Biquad()]));
      // band b needs allpasses for crossovers b+1 … k-1
      this.ap.push(Array.from({ length: n }, (_, b) => Array.from({ length: Math.max(0, k - 1 - b) }, () => new Biquad())));
    }
    this.bands = Array.from({ length: n }, () => new BandComp());
    this.delays = Array.from({ length: n }, () => [new DelayLine(this._maxDelay), new DelayLine(this._maxDelay)]);
    this.dryDelay = [new DelayLine(this._maxDelay), new DelayLine(this._maxDelay)];
    // the dry path goes through the SAME allpass chain the bands collectively get (one per crossover), so parallel mixing
    // and the delta monitor never see a phase mismatch at the crossover frequencies
    this.dryAp = [Array.from({ length: k }, () => new Biquad()), Array.from({ length: k }, () => new Biquad())];
    this._bandL = new Float64Array(n);
    this._bandR = new Float64Array(n);
  }

  _updateFilters(snap) {
    const sr = sampleRate;
    const k = this.n - 1;
    // keep crossovers ordered and apart
    const f = this.xovers.slice();
    for (let i = 0; i < k; i++) {
      const lo = i === 0 ? 20 : f[i - 1] * 1.05;
      f[i] = clamp(f[i], lo, Math.min(sr * 0.45, 20000));
    }
    this.xovers = f;
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < k; i++) {
        for (const bq of this.lp[c][i]) butterworth('lp', sr, f[i], bq, snap);
        for (const bq of this.hp[c][i]) butterworth('hp', sr, f[i], bq, snap);
      }
      for (let b = 0; b < this.n; b++) this.ap[c][b].forEach((bq, j) => allpass(sr, f[b + 1 + j], bq, snap));
      this.dryAp[c].forEach((bq, i) => allpass(sr, f[i], bq, snap));
    }
  }

  _glideAll() {
    const g = this._glide;
    for (let c = 0; c < 2; c++) {
      for (const pair of this.lp[c]) for (const bq of pair) bq.glide(g);
      for (const pair of this.hp[c]) for (const bq of pair) bq.glide(g);
      for (const chain of this.ap[c]) for (const bq of chain) bq.glide(g);
      for (const bq of this.dryAp[c]) bq.glide(g);
    }
  }

  _flushAll() {
    for (let c = 0; c < 2; c++) {
      for (const pair of this.lp[c]) for (const bq of pair) bq.flush();
      for (const pair of this.hp[c]) for (const bq of pair) bq.flush();
      for (const chain of this.ap[c]) for (const bq of chain) bq.flush();
      for (const bq of this.dryAp[c]) bq.flush();
    }
  }

  _resetAll() {
    for (let c = 0; c < 2; c++) {
      for (const pair of this.lp[c]) for (const bq of pair) bq.reset();
      for (const pair of this.hp[c]) for (const bq of pair) bq.reset();
      for (const chain of this.ap[c]) for (const bq of chain) bq.reset();
      for (const bq of this.dryAp[c]) bq.reset();
    }
    for (const b of this.bands) b.reset();
    for (const dl of this.delays) { dl[0].reset(); dl[1].reset(); }
    this.dryDelay[0].reset(); this.dryDelay[1].reset();
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
    const n = this.n;
    const k = n - 1;
    const la = this.lookahead;
    const mix = this.mix;
    const mon = this.monitor;
    const bl = this._bandL, br = this._bandR;

    this._glideAll();

    let bad = false;
    for (let i = 0; i < N; i++) {
      const l = inL[i], r = inR[i];

      // ── split ──
      let restL = l, restR = r;
      for (let b = 0; b < k; b++) {
        const lpL = this.lp[0][b], lpR = this.lp[1][b], hpL = this.hp[0][b], hpR = this.hp[1][b];
        let lowL = lpL[1].process(lpL[0].process(restL));
        let lowR = lpR[1].process(lpR[0].process(restR));
        restL = hpL[1].process(hpL[0].process(restL));
        restR = hpR[1].process(hpR[0].process(restR));
        // align this band with every crossover above it
        const chL = this.ap[0][b], chR = this.ap[1][b];
        for (let j = 0; j < chL.length; j++) { lowL = chL[j].process(lowL); lowR = chR[j].process(lowR); }
        bl[b] = lowL; br[b] = lowR;
      }
      bl[k] = restL; br[k] = restR;

      // ── compress each band: detector sees the live signal, the gain rides on the (delayed) signal ──
      let sumL = 0, sumR = 0, soloL = 0, soloR = 0;
      for (let b = 0; b < n; b++) {
        const band = this.bands[b];
        band.gains(bl[b], br[b]);
        const gL = band.gainL, gR = band.gainR;
        const dL = la > 0 ? this.delays[b][0].process(bl[b], la) : bl[b];
        const dR = la > 0 ? this.delays[b][1].process(br[b], la) : br[b];
        const cL = dL * gL, cR = dR * gR;
        sumL += cL; sumR += cR;
        if (b === mon) { soloL = cL; soloR = cR; }
      }
      let aL = l, aR = r;
      for (let j = 0; j < k; j++) { aL = this.dryAp[0][j].process(aL); aR = this.dryAp[1][j].process(aR); }
      const dryL = la > 0 ? this.dryDelay[0].process(aL, la) : aL;
      const dryR = la > 0 ? this.dryDelay[1].process(aR, la) : aR;
      let oL = dryL * (1 - mix) + sumL * mix;
      let oR = dryR * (1 - mix) + sumR * mix;
      if (mon === -2) { oL = dryL - sumL; oR = dryR - sumR; }
      else if (mon >= 0 && mon < n) { oL = soloL; oR = soloR; }

      if (oL !== oL || oR !== oR || oL === Infinity || oL === -Infinity || oR === Infinity || oR === -Infinity) { bad = true; oL = dryL; oR = dryR; }
      outL[i] = oL;
      if (output[1]) outR[i] = oR;
    }

    if (bad) this._resetAll();
    this._flushAll();
    for (const band of this.bands) band.retime();

    this._meterAcc += N;
    if (this._meterAcc >= this._meterEvery) {
      this._meterAcc = 0;
      this.port.postMessage({
        gr: this.bands.map((b) => Math.min(b.grL, b.grR)),
        lvl: this.bands.map((b) => b.lvlDb),
      });
    }
    return true;
  }
}

registerProcessor('multiband-comp-processor', MultibandCompProcessor);
