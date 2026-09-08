/**
 * Noise Gate preset persistence (localStorage).
 * Stores threshold/range/attack/hold/release plus auto-threshold settings.
 */

export interface NoiseGatePreset {
  id: string;
  name: string;
  timestamp: number;
  threshold: number;
  range: number;
  attack: number;
  hold: number;
  release: number;
  // Auto-threshold preferences
  autoMode: 'mono' | 'lr' | 'midside';
  autoWindowMs: number;
  autoPercentile: number; // 0..1 (e.g. 0.1 = 10%)
  autoMarginDb: number;
}

const STORAGE_KEY = 'masterpro-noise-gate-presets';

export function loadGatePresets(): NoiseGatePreset[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveGatePresets(presets: NoiseGatePreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}
