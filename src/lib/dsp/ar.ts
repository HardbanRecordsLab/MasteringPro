/**
 * Autoregressive (AR) modelling for audio restoration.
 *
 * A short stretch of music is well described by x[n] ≈ Σ a[k]·x[n-1-k] (linear prediction). That makes two
 * restoration jobs principled instead of heuristic:
 *   - detection: a click is a sample the model cannot predict, from either direction in time;
 *   - repair: the missing samples are the least-squares solution that makes the prediction error of the whole
 *     neighbourhood as small as possible (Godsill & Rayner, "Digital Audio Restoration", ch. 5).
 *
 * Everything here is plain TypeScript on Float32/Float64 arrays: it runs in Node (tests) and in a Web Worker.
 */

/** Autocorrelation r[0..order] of x[from, to) after a Hann window (suppresses edge leakage). */
export function autocorrelation(
  x: ArrayLike<number>,
  from: number,
  to: number,
  order: number,
): Float64Array {
  const n = Math.max(0, to - from);
  const r = new Float64Array(order + 1);
  if (n <= order) return r;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  }
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += w[i] * w[i - lag];
    r[lag] = s;
  }
  return r;
}

/**
 * Levinson–Durbin recursion. Returns predictor `a` (length = order) such that x[n] ≈ Σ a[k]·x[n-1-k],
 * and the final prediction-error power. A tiny white-noise correction keeps the recursion stable on
 * (near-)digital silence and on pure tones.
 */
export function levinson(r: Float64Array, order: number): { a: Float64Array; error: number } {
  const a = new Float64Array(order);
  let e = r[0] * (1 + 1e-9) + 1e-30;
  if (!(r[0] > 0)) return { a, error: 0 };
  const tmp = new Float64Array(order);
  for (let i = 0; i < order; i++) {
    let acc = r[i + 1];
    for (let j = 0; j < i; j++) acc -= a[j] * r[i - j];
    const k = acc / e;
    for (let j = 0; j < i; j++) tmp[j] = a[j] - k * a[i - 1 - j];
    for (let j = 0; j < i; j++) a[j] = tmp[j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) break;
  }
  return { a, error: e };
}

/** Estimate an AR model from the clean samples on both sides of [s, e] (inclusive), ignoring the damaged span. */
export function estimateARAround(
  x: ArrayLike<number>,
  s: number,
  e: number,
  order: number,
  halfWindow = 1024,
): Float64Array | null {
  const n = x.length;
  const need = order * 4;
  const leftFrom = Math.max(0, s - halfWindow);
  const rightTo = Math.min(n, e + 1 + halfWindow);
  const leftLen = s - leftFrom;
  const rightLen = rightTo - (e + 1);
  const rl = leftLen > need ? autocorrelation(x, leftFrom, s, order) : null;
  const rr = rightLen > need ? autocorrelation(x, e + 1, rightTo, order) : null;
  if (!rl && !rr) return null;
  const r = new Float64Array(order + 1);
  const wl = rl ? leftLen : 0;
  const wr = rr ? rightLen : 0;
  const tot = wl + wr;
  for (let k = 0; k <= order; k++) {
    // normalise each side by its length so a long clean side does not drown out a short one
    r[k] = ((rl ? rl[k] / leftLen : 0) * wl + (rr ? rr[k] / rightLen : 0) * wr) / tot;
  }
  if (!(r[0] > 1e-18)) return null;
  return levinson(r, order).a;
}

/** In-place Cholesky solve of the symmetric positive-definite system G·x = b. Returns false if G is not SPD. */
function choleskySolve(G: Float64Array, b: Float64Array, m: number): boolean {
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = G[i * m + j];
      for (let k = 0; k < j; k++) sum -= G[i * m + k] * G[j * m + k];
      if (i === j) {
        if (sum <= 0) return false;
        G[i * m + i] = Math.sqrt(sum);
      } else {
        G[i * m + j] = sum / G[j * m + j];
      }
    }
  }
  for (let i = 0; i < m; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= G[i * m + k] * b[k];
    b[i] = sum / G[i * m + i];
  }
  for (let i = m - 1; i >= 0; i--) {
    let sum = b[i];
    for (let k = i + 1; k < m; k++) sum -= G[k * m + i] * b[k];
    b[i] = sum / G[i * m + i];
  }
  return true;
}

/**
 * Replace x[s..e] (inclusive) by the least-squares AR interpolation: the values that minimise the total squared
 * prediction error of every equation that touches the damaged span. Falls back to linear interpolation if the
 * system is degenerate. Returns false when the span was too close to the array edge to model.
 */
export function interpolateAR(x: Float32Array | Float64Array, a: Float64Array, s: number, e: number): boolean {
  const p = a.length;
  const m = e - s + 1;
  const len = x.length;
  if (m <= 0) return true;
  if (s - p < 0 || e + 1 >= len) {
    linearFill(x, s, e);
    return false;
  }
  const c = new Float64Array(p + 1);
  c[0] = 1;
  for (let k = 0; k < p; k++) c[k + 1] = -a[k];

  const G = new Float64Array(m * m);
  const rhs = new Float64Array(m);
  const rowIdx = new Int32Array(p + 1);
  const rowVal = new Float64Array(p + 1);

  const n1 = Math.min(len - 1, e + p);
  for (let n = s; n <= n1; n++) {
    if (n - p < 0) continue;
    let cnt = 0;
    let known = 0;
    for (let i = 0; i <= p; i++) {
      const j = n - i;
      if (j >= s && j <= e) {
        rowIdx[cnt] = j - s;
        rowVal[cnt] = c[i];
        cnt++;
      } else {
        known += c[i] * x[j];
      }
    }
    for (let u = 0; u < cnt; u++) {
      rhs[rowIdx[u]] -= rowVal[u] * known;
      for (let v = 0; v < cnt; v++) G[rowIdx[u] * m + rowIdx[v]] += rowVal[u] * rowVal[v];
    }
  }
  let trace = 0;
  for (let i = 0; i < m; i++) trace += G[i * m + i];
  const ridge = (trace / m) * 1e-9 + 1e-18;
  for (let i = 0; i < m; i++) G[i * m + i] += ridge;

  if (!choleskySolve(G, rhs, m)) {
    linearFill(x, s, e);
    return false;
  }
  for (let i = 0; i < m; i++) {
    const v = rhs[i];
    x[s + i] = Number.isFinite(v) ? v : x[s + i];
  }
  return true;
}

export function linearFill(x: Float32Array | Float64Array, s: number, e: number): void {
  const a = x[Math.max(0, s - 1)];
  const b = x[Math.min(x.length - 1, e + 1)];
  const m = e - s + 2;
  for (let i = s; i <= e; i++) x[i] = a + ((b - a) * (i - s + 1)) / m;
}
