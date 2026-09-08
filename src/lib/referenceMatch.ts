import { analyzeSpectrum } from '@/lib/spectrum';
import { measureIntegratedLoudness } from '@/lib/loudness';
import type { EQBandParams } from '@/contexts/AudioContext';

export interface ReferenceMatchResult {
  eqBands: EQBandParams[];
  lufsDelta: number;      // reference − current, integrated LUFS
  tiltDelta: number;      // dB/oct the reference is brighter (+) / darker (−)
  moves: string[];        // human-readable summary of the EQ moves
}

const BAND_RANGES: [number, number][] = [
  [20, 120],     // low shelf @ 80
  [120, 500],    // peak @ 250
  [500, 2000],   // peak @ 1k
  [2000, 7000],  // peak @ 4k
  [7000, 20000], // high shelf @ 12k
];

/**
 * Derive an EQ correction curve that moves `current` toward `reference` in the
 * frequency domain (1/3-octave), plus the integrated-loudness gap. Broadband
 * level offset is removed first so it doesn't leak into the EQ.
 */
export function matchToReference(
  current: AudioBuffer,
  reference: AudioBuffer,
  currentBands: EQBandParams[],
  maxMoveDb = 5,
): ReferenceMatchResult {
  const cur = analyzeSpectrum(current);
  const ref = analyzeSpectrum(reference);

  // align by center frequency
  const diffs: { f: number; d: number }[] = [];
  cur.thirdOctaveCenters.forEach((f, i) => {
    const j = ref.thirdOctaveCenters.indexOf(f);
    if (j >= 0 && f >= 30 && f <= 16000) {
      diffs.push({ f, d: ref.thirdOctaveDb[j] - cur.thirdOctaveDb[i] });
    }
  });

  // broadband offset = mean over 100 Hz … 8 kHz (the "loudness" part, not tone)
  const core = diffs.filter((x) => x.f >= 100 && x.f <= 8000);
  const meanDiff = core.reduce((s, x) => s + x.d, 0) / Math.max(1, core.length);

  const bandGain = (lo: number, hi: number) => {
    const inBand = diffs.filter((x) => x.f >= lo && x.f < hi);
    if (!inBand.length) return 0;
    const avg = inBand.reduce((s, x) => s + (x.d - meanDiff), 0) / inBand.length;
    return Math.max(-maxMoveDb, Math.min(maxMoveDb, Math.round(avg * 2) / 2));
  };

  const moves: string[] = [];
  const eqBands = currentBands.map((band, i) => {
    const g = bandGain(BAND_RANGES[i][0], BAND_RANGES[i][1]);
    if (Math.abs(g) >= 0.5) {
      moves.push(`${band.freq >= 1000 ? band.freq / 1000 + 'k' : band.freq} Hz ${g > 0 ? '+' : ''}${g} dB`);
    }
    return { ...band, gain: g };
  });

  const lufsDelta =
    measureIntegratedLoudness(reference) - measureIntegratedLoudness(current);

  // spectral tilt gap (bright vs dark)
  const tiltAt = (s: typeof cur) => {
    const lo = s.thirdOctaveDb[s.thirdOctaveCenters.indexOf(200)] ?? 0;
    const hi = s.thirdOctaveDb[s.thirdOctaveCenters.indexOf(6300)] ?? 0;
    return (hi - lo) / Math.log2(6300 / 200);
  };
  const tiltDelta = Math.round((tiltAt(ref) - tiltAt(cur)) * 10) / 10;

  return { eqBands, lufsDelta: Math.round(lufsDelta * 10) / 10, tiltDelta, moves };
}
