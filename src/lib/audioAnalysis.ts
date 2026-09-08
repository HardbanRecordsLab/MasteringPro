/**
 * Audio analysis utilities for extracting metrics from an AudioBuffer
 */

import { measureLoudness } from './loudness';
import { analyzeSpectrum, bandDb, spectralCentroid as specCentroid, spectralTilt as specTilt } from './spectrum';

export interface AudioMetrics {
  lufs: number;

  truePeak: number;
  dynamicRange: number;
  lra: number;
  crestFactor: number;
  noiseFloor: number;
  transientDensity: number;
  frequencyBalance: {
    sub: number;
    bass: number;
    mid: number;
    highMid: number;
    air: number;
  };
  stereoCorrelation: number;
  stereoWidth: number;
  isMono: boolean;
  issues: string[];
  estimatedGenre: string;
  // Extended pro metrics
  spectralCentroid: number;       // Hz — perceived brightness
  spectralTilt: number;            // dB/oct (negative = dark, positive = bright)
  sibilanceLevel: number;          // dBFS energy in 5-9 kHz
  lowEndMonoCompat: number;        // 0..1 correlation below 120 Hz
  dcOffset: number;                // -1..1
  tonalBalanceScore: number;       // 0..100 vs ideal pop/rock curve
  punchScore: number;              // 0..100 transient strength
  mudIndex: number;                // 0..100 200-500 Hz buildup
  harshnessIndex: number;          // 0..100 2-5 kHz buildup
  // BS.1770-4 / EBU R128
  samplePeak: number;              // dBFS
  shortTermMax: number;            // LUFS-S max (3 s)
  momentaryMax: number;            // LUFS-M max (400 ms)
}


export function analyzeAudio(buffer: AudioBuffer): AudioMetrics {
  const sampleRate = buffer.sampleRate;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const isMono = buffer.numberOfChannels === 1;
  const length = left.length;

  // ===== BS.1770-4 loudness + 4x oversampled true peak =====
  const loud = measureLoudness(buffer);
  const truePeakDb = loud.truePeak;
  const lufs = loud.integrated;
  const lra = loud.lra;

  // RMS (for crest factor)
  let sumSquares = 0;
  for (let i = 0; i < length; i++) {
    const mid = (left[i] + right[i]) / 2;
    sumSquares += mid * mid;
  }
  const rms = Math.sqrt(sumSquares / length);
  const rmsDb = 20 * Math.log10(rms || 0.0001);

  // Dynamic Range
  const windowSize = Math.floor(sampleRate * 0.4); // 400ms windows
  const windowRms: number[] = [];
  for (let i = 0; i < length - windowSize; i += windowSize) {
    let wSum = 0;
    for (let j = 0; j < windowSize; j++) {
      const mid = (left[i + j] + right[i + j]) / 2;
      wSum += mid * mid;
    }
    windowRms.push(Math.sqrt(wSum / windowSize));
  }
  windowRms.sort((a, b) => a - b);
  const dr10 = windowRms[Math.floor(windowRms.length * 0.1)] || 0.0001;
  const dr95 = windowRms[Math.floor(windowRms.length * 0.95)] || 0.0001;
  const dynamicRange = 20 * Math.log10(dr95 / dr10);

  // Crest Factor (sample peak vs RMS)
  const crestFactor = loud.samplePeak - rmsDb;

  // Noise Floor (quietest 5%)
  const noiseIdx = Math.floor(windowRms.length * 0.05);
  const noiseFloor = 20 * Math.log10(windowRms[noiseIdx] || 0.0001);



  // Transient density
  const shortWindow = Math.floor(sampleRate * 0.01); // 10ms
  let transients = 0;
  let prevRms = 0;
  for (let i = 0; i < length - shortWindow; i += shortWindow) {
    let wSum = 0;
    for (let j = 0; j < shortWindow; j++) {
      wSum += left[i + j] * left[i + j];
    }
    const wRms = 20 * Math.log10(Math.sqrt(wSum / shortWindow) || 0.0001);
    if (wRms - prevRms > 6) transients++;
    prevRms = wRms;
  }
  const transientDensity = transients / buffer.duration;

  // ===== Whole-file spectrum (Welch-averaged real FFT, calibrated dBFS) =====
  const spec = analyzeSpectrum(buffer);
  const pow = (lo: number, hi: number) => Math.pow(10, bandDb(spec, lo, hi) / 10);

  const subE = pow(20, 60);
  const bassE = pow(60, 250);
  const midE = pow(250, 2000);
  const hiMidE = pow(2000, 6000);
  const airE = pow(6000, 20000);
  const totalE = subE + bassE + midE + hiMidE + airE || 1;

  const bands = {
    sub: Math.round((subE / totalE) * 100),
    bass: Math.round((bassE / totalE) * 100),
    mid: Math.round((midE / totalE) * 100),
    highMid: Math.round((hiMidE / totalE) * 100),
    air: Math.round((airE / totalE) * 100),
  };

  // Stereo correlation
  let sumLR = 0, sumL2 = 0, sumR2 = 0;
  for (let i = 0; i < length; i++) {
    sumLR += left[i] * right[i];
    sumL2 += left[i] * left[i];
    sumR2 += right[i] * right[i];
  }
  const stereoCorrelation = isMono ? 1.0 : sumLR / Math.sqrt(sumL2 * sumR2 || 1);

  // Stereo width
  let sumDiff2 = 0, sumSum2 = 0;
  for (let i = 0; i < length; i++) {
    const diff = left[i] - right[i];
    const sum = left[i] + right[i];
    sumDiff2 += diff * diff;
    sumSum2 += sum * sum;
  }
  const stereoWidth = isMono ? 0 : Math.round((Math.sqrt(sumDiff2) / Math.sqrt(sumSum2 || 1)) * 100);

  // Issues detection
  const issues: string[] = [];
  if (truePeakDb > 0) issues.push('clipping detected');
  if (stereoCorrelation < 0) issues.push('phase issues');
  if (bands.bass > 35 && bands.mid > 30) issues.push('muddy low-mids');
  if (bands.highMid > 40) issues.push('harsh high-mids');
  if (bands.sub + bands.bass < 15) issues.push('weak bass');
  if (issues.length === 0) issues.push('none');

  // Genre heuristics
  const genreScores: Record<string, number> = {
    'EDM/Electronic': (bands.sub > 25 && transientDensity > 4 ? 40 : 0),
    'Hip-Hop/Trap': (bands.sub > 20 && bands.mid < 40 ? 35 : 0),
    'Rock/Metal': (bands.mid > 45 && crestFactor < 12 ? 35 : 0),
    'Jazz/Acoustic': (dynamicRange > 14 && bands.air > 15 ? 40 : 0),
    'Classical': (dynamicRange > 18 && stereoCorrelation > 0.8 ? 50 : 0),
    'Ambient': (transientDensity < 1 && lra > 12 ? 45 : 0),
    'Pop': (lufs > -14 && lufs < -9 && bands.mid > 30 && bands.mid < 50 ? 30 : 0),
  };

  let maxGenre = 'Mixed/Unknown';
  let maxScore = 0;
  for (const [genre, score] of Object.entries(genreScores)) {
    if (score > maxScore) {
      maxScore = score;
      maxGenre = genre;
    }
  }

  // ===== Extended pro metrics (from the whole-file spectrum) =====
  const spectralCentroid = Math.round(specCentroid(spec));
  const spectralTilt = Math.round(specTilt(spec) * 10) / 10;
  const sibilanceLevel = Math.round(bandDb(spec, 5000, 9000) * 10) / 10;

  // Low-end mono compatibility (correlation of low-passed L vs R, simple lossy)
  let lpL = 0, lpR = 0, lpSumLR = 0, lpSumL2 = 0, lpSumR2 = 0;
  const lpAlpha = 0.02; // ~120 Hz at 48k
  for (let i = 0; i < length; i++) {
    lpL = lpL + lpAlpha * (left[i] - lpL);
    lpR = lpR + lpAlpha * (right[i] - lpR);
    lpSumLR += lpL * lpR;
    lpSumL2 += lpL * lpL;
    lpSumR2 += lpR * lpR;
  }
  const lowEndMonoCompat = isMono ? 1 : Math.max(-1, Math.min(1, lpSumLR / Math.sqrt(lpSumL2 * lpSumR2 || 1)));

  // DC offset
  let dcSum = 0;
  for (let i = 0; i < length; i++) dcSum += (left[i] + right[i]) * 0.5;
  const dcOffset = dcSum / length;

  // Mud / Harshness indices — band power as a share of the whole spectrum
  const mudE = pow(180, 500);
  const harshE = pow(2000, 5000);
  const mudIndex = Math.round((mudE / totalE) * 100);
  const harshnessIndex = Math.round((harshE / totalE) * 100);

  // Punch score: transient density × crest factor → normalized
  const punchScore = Math.max(0, Math.min(100, Math.round(transientDensity * 8 + crestFactor * 3)));

  // Tonal balance: closeness to "ideal" pop curve (sub 10, bass 25, mid 30, hiMid 20, air 15)
  const ideal = { sub: 10, bass: 25, mid: 30, highMid: 20, air: 15 };
  const diff = Math.abs(bands.sub - ideal.sub) + Math.abs(bands.bass - ideal.bass) +
               Math.abs(bands.mid - ideal.mid) + Math.abs(bands.highMid - ideal.highMid) +
               Math.abs(bands.air - ideal.air);
  const tonalBalanceScore = Math.max(0, Math.min(100, Math.round(100 - diff * 1.2)));

  // Add new issues
  if (Math.abs(dcOffset) > 0.005) issues.push('DC offset present');
  if (lowEndMonoCompat < 0.5 && !isMono) issues.push('poor mono bass compatibility');
  if (harshnessIndex > 30) issues.push('harshness 2-5kHz');
  if (mudIndex > 35) issues.push('mud 200-500Hz');
  if (issues.length > 1 && issues[0] === 'none') issues.shift();

  return {
    lufs: Math.round(lufs * 10) / 10,
    truePeak: Math.round(truePeakDb * 10) / 10,
    dynamicRange: Math.round(dynamicRange * 10) / 10,
    lra: Math.round(lra * 10) / 10,
    crestFactor: Math.round(crestFactor * 10) / 10,
    noiseFloor: Math.round(noiseFloor * 10) / 10,
    transientDensity: Math.round(transientDensity * 10) / 10,
    frequencyBalance: bands,
    stereoCorrelation: Math.round(stereoCorrelation * 100) / 100,
    stereoWidth,
    isMono,
    issues,
    estimatedGenre: maxGenre,
    spectralCentroid,
    spectralTilt,
    sibilanceLevel,
    lowEndMonoCompat: Math.round(lowEndMonoCompat * 100) / 100,
    dcOffset: Math.round(dcOffset * 10000) / 10000,
    tonalBalanceScore,
    punchScore,
    samplePeak: loud.samplePeak,
    shortTermMax: loud.shortTermMax,
    momentaryMax: loud.momentaryMax,

    mudIndex,
    harshnessIndex,
  };
}
