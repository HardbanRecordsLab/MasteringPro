/**
 * Album planning: everything that decides HOW the tracks are mastered together, as pure functions.
 *
 *  - Tonal anchor: the album's median spectrum (or one chosen track). Each track gets a gentle correction toward it,
 *    limited in size, so the record sounds like one record without flattening each song's character.
 *  - Loudness: every track lands on the album target; `loudnessBalance` lets some of the original differences survive
 *    (a ballad may stay a little quieter than the single).
 *  - Sequence: transition cost from loudness, brightness, tempo and key (Camelot wheel) and three ordering strategies.
 *  - Gaps: expressed as CUE-sheet pregaps, the standard way to describe the silence between tracks of a CD master.
 */
import type { MatchCurve } from '@/lib/dsp/matchEq';
import { computeMatch } from '@/lib/dsp/match';
import type { TrackProfile } from '@/lib/dsp/profile';

export interface AlbumTrack {
  id: string;
  name: string;
  durationSec: number;
  lufs: number;
  lra: number;
  truePeakDb: number;
  profile: TrackProfile;
  key?: string;
  bpm?: number;
}

export interface AlbumSettings {
  /** album loudness, LUFS-I */
  targetLufs: number;
  /** 0 = every track exactly on target · 1 = the original loudness differences are kept */
  loudnessBalance: number;
  /** 0 … 1 strength of the tonal correction toward the anchor */
  toneStrength: number;
  /** largest boost / cut the tonal correction may apply, dB */
  maxToneDb: number;
  /** tonal anchor: a track id, or null/undefined for the album median */
  anchorId?: string | null;
}

export const DEFAULT_ALBUM_SETTINGS: AlbumSettings = {
  targetLufs: -14, loudnessBalance: 0.15, toneStrength: 0.5, maxToneDb: 3, anchorId: null,
};

const median = (a: number[]) => {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function sampleSeries(freqs: number[], vals: number[], hz: number): number {
  if (hz <= freqs[0]) return vals[0];
  const last = freqs.length - 1;
  if (hz >= freqs[last]) return vals[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (freqs[m] <= hz) lo = m; else hi = m; }
  const t = Math.log(hz / freqs[lo]) / Math.log(freqs[hi] / freqs[lo]);
  return vals[lo] + (vals[hi] - vals[lo]) * t;
}

/** The "typical" spectrum and width of the album: per-frequency median of the tracks. */
export function medianProfile(tracks: AlbumTrack[]): TrackProfile {
  const base = tracks[0].profile;
  const freqs = base.freqs;
  const midDb = freqs.map((hz, i) =>
    median(tracks.map((t) => (t.profile.freqs === freqs ? t.profile.midDb[i] : sampleSeries(t.profile.freqs, t.profile.midDb, hz)))));
  const sideDb = freqs.map((hz, i) =>
    median(tracks.map((t) => (t.profile.freqs === freqs ? t.profile.sideDb[i] : sampleSeries(t.profile.freqs, t.profile.sideDb, hz)))));
  return {
    ...base,
    midDb,
    sideDb,
    level: base.level.map((_, b) => ({
      p10: median(tracks.map((t) => t.profile.level[b].p10)),
      p50: median(tracks.map((t) => t.profile.level[b].p50)),
      p95: median(tracks.map((t) => t.profile.level[b].p95)),
    })),
    dynRange: base.dynRange.map((_, b) => median(tracks.map((t) => t.profile.dynRange[b]))),
    sideToMid: base.sideToMid.map((_, b) => median(tracks.map((t) => t.profile.sideToMid[b]))),
    lufs: median(tracks.map((t) => t.lufs)),
    lra: median(tracks.map((t) => t.lra)),
  };
}

export interface TrackPlan {
  id: string;
  /** loudness this track must land on, LUFS-I */
  targetLufs: number;
  /** tonal correction as a curve at full scale (apply with amount = toneStrength) */
  curve: MatchCurve | null;
  /** distance from the tonal anchor (dB rms, 40 Hz – 16 kHz) before and after the correction at the chosen strength */
  toneBeforeDb: number;
  toneAfterDb: number;
}

export function planTrack(track: AlbumTrack, all: AlbumTrack[], settings: AlbumSettings): TrackPlan {
  const medLufs = median(all.map((t) => t.lufs));
  const target = settings.targetLufs + Math.max(-6, Math.min(6, settings.loudnessBalance * (track.lufs - medLufs)));

  const anchor = settings.anchorId ? all.find((t) => t.id === settings.anchorId)?.profile : undefined;
  const reference = anchor ?? medianProfile(all);
  const isAnchor = settings.anchorId === track.id;
  if (isAnchor || all.length < 2 || settings.toneStrength <= 0) {
    return { id: track.id, targetLufs: target, curve: null, toneBeforeDb: 0, toneAfterDb: 0 };
  }
  const m = computeMatch(track.profile, reference, { maxBoostDb: settings.maxToneDb, maxCutDb: settings.maxToneDb, smoothOct: 0.5 });
  const f = m.curve.f;
  const idx = f.map((_, i) => i).filter((i) => f[i] >= 40 && f[i] <= 16000);
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
  const s = settings.toneStrength;
  return {
    id: track.id,
    targetLufs: target,
    curve: m.curve,
    toneBeforeDb: Math.round(rms(idx.map((i) => m.diff[i])) * 10) / 10,
    toneAfterDb: Math.round(rms(idx.map((i) => m.diff[i] - s * m.curve.g[i])) * 10) / 10,
  };
}

// ───────────────────────── sequencing ─────────────────────────

/** spectral centroid of the mid spectrum, in octaves relative to 1 kHz */
export function brightnessOct(profile: TrackProfile): number {
  let num = 0, den = 0;
  profile.freqs.forEach((hz, i) => {
    const p = Math.pow(10, profile.midDb[i] / 10) * hz; // × hz: grid is log-spaced, so this weights per octave
    num += p * Math.log2(hz / 1000);
    den += p;
  });
  return den ? num / den : 0;
}

const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

/** Camelot wheel position, e.g. "A minor" → { n: 8, minor: true }; null when the key is unknown */
export function camelot(key?: string): { n: number; minor: boolean } | null {
  if (!key || key === '—') return null;
  const [note, mode] = key.split(' ');
  const i = PITCH.indexOf(note);
  if (i < 0) return null;
  return mode === 'minor' ? { n: CAMELOT_MINOR[i], minor: true } : { n: CAMELOT_MAJOR[i], minor: false };
}

/** steps on the Camelot wheel (0 = same key, 1 = neighbour or relative major/minor … up to 7) */
export function keyDistance(a?: string, b?: string): number | null {
  const ca = camelot(a), cb = camelot(b);
  if (!ca || !cb) return null;
  const d = Math.abs(ca.n - cb.n);
  const wheel = Math.min(d, 12 - d);
  return wheel + (ca.minor !== cb.minor ? 1 : 0);
}

/** How jarring it is to play `b` right after `a`. 0 = seamless. Missing features simply do not count. */
export function transitionCost(a: AlbumTrack, b: AlbumTrack): number {
  let cost = Math.abs(a.lufs - b.lufs) / 6;
  cost += Math.abs(brightnessOct(a.profile) - brightnessOct(b.profile)) / 1.0;
  if (a.bpm && b.bpm) {
    // tempo: halves and doubles count as related
    const r = a.bpm > b.bpm ? a.bpm / b.bpm : b.bpm / a.bpm;
    const rel = Math.min(Math.abs(r - 1), Math.abs(r - 2), Math.abs(r - 1.5) * 1.5);
    cost += rel / 0.15;
  }
  const kd = keyDistance(a.key, b.key);
  if (kd !== null) cost += kd / 3;
  return cost;
}

export function sequenceCost(order: AlbumTrack[]): number {
  let c = 0;
  for (let i = 1; i < order.length; i++) c += transitionCost(order[i - 1], order[i]);
  return c;
}

export type OrderMode = 'flow' | 'rising' | 'arc';

/** energy proxy: louder and brighter = higher */
const energy = (t: AlbumTrack) => t.lufs + 3 * brightnessOct(t.profile);

export function suggestOrder(tracks: AlbumTrack[], mode: OrderMode): AlbumTrack[] {
  if (tracks.length < 3) return tracks.slice();
  if (mode === 'rising') return tracks.slice().sort((a, b) => energy(a) - energy(b));
  if (mode === 'arc') {
    const sorted = tracks.slice().sort((a, b) => energy(a) - energy(b));
    const peak = sorted.pop()!;
    const upCount = Math.max(1, Math.ceil(tracks.length * 0.66) - 1);
    const left: AlbumTrack[] = [], right: AlbumTrack[] = [];
    sorted.forEach((t, i) => { if (i % 2 === 0 && left.length < upCount) left.push(t); else right.push(t); });
    return [...left, peak, ...right.reverse()];
  }
  // flow: start from the most "typical" track, greedy nearest neighbour, then 2-opt to remove the worst detours
  const med = medianProfile(tracks);
  let startIdx = 0, best = Infinity;
  tracks.forEach((t, i) => {
    const d = Math.abs(t.lufs - med.lufs) / 6 + Math.abs(brightnessOct(t.profile) - brightnessOct(med)) / 1.0;
    if (d < best) { best = d; startIdx = i; }
  });
  const rest = tracks.filter((_, i) => i !== startIdx);
  const order = [tracks[startIdx]];
  while (rest.length) {
    const last = order[order.length - 1];
    let bi = 0, bc = Infinity;
    rest.forEach((t, i) => { const c = transitionCost(last, t); if (c < bc) { bc = c; bi = i; } });
    order.push(rest.splice(bi, 1)[0]);
  }
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (sequenceCost(cand) + 1e-9 < sequenceCost(order)) { order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  return order;
}

// ───────────────────────── CUE sheet ─────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** mm:ss:ff at 75 frames per second (CD frames) */
export function cueTime(seconds: number): string {
  const frames = Math.round(seconds * 75);
  const mm = Math.floor(frames / (75 * 60));
  const ss = Math.floor((frames % (75 * 60)) / 75);
  const ff = frames % 75;
  return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export interface CueEntry {
  title: string;
  file: string;
  /** silence BEFORE this track, seconds (becomes a PREGAP) */
  gapBeforeSec: number;
}

export function buildCue(album: { title: string; performer: string }, entries: CueEntry[]): string {
  const esc = (s: string) => s.replace(/"/g, "'");
  const lines = [`PERFORMER "${esc(album.performer)}"`, `TITLE "${esc(album.title)}"`];
  entries.forEach((e, i) => {
    lines.push(`FILE "${esc(e.file)}" WAVE`);
    lines.push(`  TRACK ${pad(i + 1)} AUDIO`);
    lines.push(`    TITLE "${esc(e.title)}"`);
    lines.push(`    PERFORMER "${esc(album.performer)}"`);
    if (i > 0 && e.gapBeforeSec > 0) lines.push(`    PREGAP ${cueTime(e.gapBeforeSec)}`);
    lines.push('    INDEX 01 00:00:00');
  });
  return lines.join('\r\n') + '\r\n';
}

// ───────────────────────── fades ─────────────────────────

/** raised-cosine fade in / out on one channel, in place */
export function applyFadesToChannel(x: Float32Array, sampleRate: number, fadeInMs: number, fadeOutMs: number): void {
  const nIn = Math.min(x.length, Math.round((fadeInMs / 1000) * sampleRate));
  for (let i = 0; i < nIn; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nIn);
  const nOut = Math.min(x.length, Math.round((fadeOutMs / 1000) * sampleRate));
  for (let i = 0; i < nOut; i++) x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nOut);
}

export function sanitizeFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';
}
