/**
 * Musical-content analysis: key (Krumhansl-Schmuckler on a chromagram) and
 * tempo (web-audio-beat-detector). Both run off the whole file.
 */
import { FFT, hann } from '@/lib/fft';
import { guess } from 'web-audio-beat-detector';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface MusicalContent {
  key: string;          // e.g. "A minor" or "—"
  keyConfidence: number; // 0..1
  bpm: number;          // 0 when undetectable
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** 12-bin chroma vector, magnitude-weighted, over the whole file. */
function chromagram(buffer: AudioBuffer, fftSize = 8192, maxFrames = 400): number[] {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const fft = new FFT(fftSize);
  const win = hann(fftSize);
  const frame = new Float64Array(fftSize);
  const chroma = new Array(12).fill(0);

  const usable = Math.max(0, n - fftSize);
  const frames = Math.min(maxFrames, Math.max(1, Math.floor(usable / (fftSize / 2)) + 1));
  const hop = frames > 1 ? Math.floor(usable / (frames - 1)) : fftSize;
  const bins = fftSize / 2;

  let done = 0;
  for (let start = 0; start + fftSize <= n; start += hop) {
    for (let i = 0; i < fftSize; i++) {
      const s = ch1 ? (ch0[start + i] + ch1[start + i]) * 0.5 : ch0[start + i];
      frame[i] = s * win[i];
    }
    const mag = fft.magnitude(frame);
    for (let k = 2; k < bins; k++) {
      const f = (k * sr) / fftSize;
      if (f < 55 || f > 5000) continue; // A1 … ~D8: the musically useful band
      // semitones from A440, shifted so pitch class 0 = C
      const pc = ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12;
      // weight lower octaves more — the bass carries the harmony
      chroma[pc] += mag[k] * (200 / (f + 200));
    }
    if (++done >= frames) break;
  }
  const total = chroma.reduce((s, v) => s + v, 0) || 1;
  return chroma.map((v) => v / total);
}

export function detectKey(buffer: AudioBuffer): { key: string; confidence: number } {
  const chroma = chromagram(buffer);
  let best = { score: -2, name: '—' };
  let second = -2;
  for (let tonic = 0; tonic < 12; tonic++) {
    // rotate the profile so its tonic weight lands on chroma[tonic]
    const rot = (p: number[]) => p.map((_, i) => p[(i - tonic + 12) % 12]);
    for (const [profile, label] of [[MAJOR, 'major'], [MINOR, 'minor']] as const) {
      const score = pearson(chroma, rot(profile));
      if (score > best.score) {
        second = best.score;
        best = { score, name: `${PITCH_NAMES[tonic]} ${label}` };
      } else if (score > second) {
        second = score;
      }
    }
  }
  // confidence: how clearly the winner beats the runner-up, mapped to 0..1
  const confidence = Math.max(0, Math.min(1, (best.score - second) * 3 + best.score * 0.3));
  return { key: best.score > 0.3 ? best.name : '—', confidence: Math.round(confidence * 100) / 100 };
}

export async function analyzeMusicalContent(buffer: AudioBuffer): Promise<MusicalContent> {
  const { key, confidence } = detectKey(buffer);
  let bpm = 0;
  try {
    const g = await guess(buffer);
    bpm = Math.round(g.bpm);
  } catch {
    bpm = 0;
  }
  return { key, keyConfidence: confidence, bpm };
}
