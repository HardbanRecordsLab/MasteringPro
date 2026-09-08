import type { ProcessingParams } from '@/contexts/AudioContext';

export interface FactoryPreset {
  id: string;
  name: string;
  genre: string;
  blurb: string;
  chain: Partial<ProcessingParams>;
}

const eq = (l: number, lm: number, m: number, hm: number, h: number): ProcessingParams['eqBands'] => [
  { freq: 80, gain: l, q: 0.7, type: 'lowshelf' },
  { freq: 250, gain: lm, q: 1.0, type: 'peaking' },
  { freq: 1000, gain: m, q: 1.0, type: 'peaking' },
  { freq: 4000, gain: hm, q: 1.0, type: 'peaking' },
  { freq: 12000, gain: h, q: 0.7, type: 'highshelf' },
];

/** Starting points, not finished masters — the AI / your ears take it from here. */
export const FACTORY_PRESETS: FactoryPreset[] = [
  {
    id: 'transparent',
    name: 'Transparent',
    genre: 'Any',
    blurb: 'Gentle glue, no colour. Preserves dynamics.',
    chain: {
      eqEnabled: true, eqBands: eq(0, -0.5, 0, 0.5, 0.5),
      compEnabled: true, compThreshold: -18, compRatio: 1.5, compAttack: 30, compRelease: 200, compKnee: 8, compMakeup: 0,
      saturationEnabled: false, widthEnabled: false, stereoWidth: 100,
      limiterEnabled: true, limiterCeiling: -1, limiterRelease: 120,
    },
  },
  {
    id: 'pop',
    name: 'Modern Pop',
    genre: 'Pop',
    blurb: 'Bright, forward vocal, controlled low end.',
    chain: {
      eqEnabled: true, eqBands: eq(1, -1.5, 0.5, 1.5, 2),
      deEssEnabled: true, deEssFreq: 6800, deEssThreshold: -26, deEssRange: 5,
      compEnabled: true, compThreshold: -16, compRatio: 2.5, compAttack: 12, compRelease: 140, compKnee: 6, compMakeup: 1,
      mbEnabled: true, mbXover1: 120, mbXover2: 3000,
      mbBands: [
        { threshold: -22, ratio: 2.5, attack: 25, release: 220, knee: 6, makeup: 0.5 },
        { threshold: -20, ratio: 2, attack: 12, release: 140, knee: 6, makeup: 0 },
        { threshold: -24, ratio: 2, attack: 6, release: 90, knee: 6, makeup: 0.5 },
      ],
      saturationEnabled: true, saturation: 10,
      widthEnabled: true, stereoWidth: 108,
      limiterEnabled: true, limiterCeiling: -1, limiterRelease: 90,
    },
  },
  {
    id: 'edm',
    name: 'EDM / Club',
    genre: 'Electronic',
    blurb: 'Loud, solid sub, tight transients.',
    chain: {
      eqEnabled: true, eqBands: eq(1.5, -1, -0.5, 1, 1.5),
      compEnabled: true, compThreshold: -14, compRatio: 3, compAttack: 8, compRelease: 100, compKnee: 4, compMakeup: 1.5,
      mbEnabled: true, mbXover1: 100, mbXover2: 2500,
      mbBands: [
        { threshold: -18, ratio: 3, attack: 15, release: 160, knee: 4, makeup: 1 },
        { threshold: -20, ratio: 2.5, attack: 10, release: 120, knee: 4, makeup: 0 },
        { threshold: -22, ratio: 2.5, attack: 4, release: 80, knee: 4, makeup: 0.5 },
      ],
      saturationEnabled: true, saturation: 14,
      widthEnabled: true, stereoWidth: 110,
      limiterEnabled: true, limiterCeiling: -0.8, limiterRelease: 60,
    },
  },
  {
    id: 'hiphop',
    name: 'Hip-Hop / Trap',
    genre: 'Hip-Hop',
    blurb: 'Weighty low end, present vocal, punchy.',
    chain: {
      eqEnabled: true, eqBands: eq(2, -1, 0, 0.5, 1),
      deEssEnabled: true, deEssFreq: 6500, deEssThreshold: -25, deEssRange: 5,
      compEnabled: true, compThreshold: -15, compRatio: 2, compAttack: 20, compRelease: 150, compKnee: 6, compMakeup: 1,
      saturationEnabled: true, saturation: 12,
      widthEnabled: true, stereoWidth: 104,
      limiterEnabled: true, limiterCeiling: -1, limiterRelease: 80,
    },
  },
  {
    id: 'rock',
    name: 'Rock / Band',
    genre: 'Rock',
    blurb: 'Mid-forward, energetic, glued.',
    chain: {
      eqEnabled: true, eqBands: eq(0.5, -1, 1, 1, 1),
      compEnabled: true, compThreshold: -16, compRatio: 2.5, compAttack: 20, compRelease: 180, compKnee: 6, compMakeup: 1,
      mbEnabled: true, mbXover1: 140, mbXover2: 2800,
      mbBands: [
        { threshold: -20, ratio: 2, attack: 30, release: 240, knee: 8, makeup: 0 },
        { threshold: -18, ratio: 2, attack: 15, release: 160, knee: 8, makeup: 0.5 },
        { threshold: -22, ratio: 1.8, attack: 8, release: 110, knee: 8, makeup: 0 },
      ],
      saturationEnabled: true, saturation: 16,
      widthEnabled: false, stereoWidth: 100,
      limiterEnabled: true, limiterCeiling: -1, limiterRelease: 110,
    },
  },
  {
    id: 'acoustic',
    name: 'Acoustic / Folk',
    genre: 'Acoustic',
    blurb: 'Natural, open top, minimal limiting.',
    chain: {
      eqEnabled: true, eqBands: eq(-0.5, -1, 0, 0.5, 1),
      compEnabled: true, compThreshold: -20, compRatio: 1.5, compAttack: 35, compRelease: 250, compKnee: 10, compMakeup: 0,
      saturationEnabled: false,
      widthEnabled: true, stereoWidth: 102,
      limiterEnabled: true, limiterCeiling: -1, limiterRelease: 150,
    },
  },
  {
    id: 'podcast',
    name: 'Podcast / Voice',
    genre: 'Spoken',
    blurb: 'Even level, de-essed, −16 LUFS target.',
    chain: {
      eqEnabled: true, eqBands: eq(-2, -2, 1.5, 1, 0.5),
      deEssEnabled: true, deEssFreq: 6000, deEssThreshold: -24, deEssRange: 7,
      compEnabled: true, compThreshold: -22, compRatio: 3, compAttack: 10, compRelease: 120, compKnee: 6, compMakeup: 3,
      saturationEnabled: false, widthEnabled: false, stereoWidth: 100,
      limiterEnabled: true, limiterCeiling: -1.5, limiterRelease: 100,
    },
  },
  {
    id: 'mastered-for-itunes',
    name: 'Streaming Safe',
    genre: 'Any',
    blurb: 'Conservative ceiling, −14 LUFS, no penalty.',
    chain: {
      eqEnabled: true, eqBands: eq(0, -0.5, 0, 0.5, 0.5),
      compEnabled: true, compThreshold: -18, compRatio: 1.8, compAttack: 25, compRelease: 200, compKnee: 8, compMakeup: 0,
      saturationEnabled: false, widthEnabled: false, stereoWidth: 100,
      limiterEnabled: true, limiterCeiling: -1.2, limiterRelease: 130,
    },
  },
];
