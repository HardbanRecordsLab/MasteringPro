/**
 * AI Auto-Mastering preset persistence (localStorage).
 * Stores platform/style/intensity, the AI config snapshot, validation report
 * and a snapshot of ProcessingParams so a preset can be fully restored.
 */
import type { ProcessingParams } from '@/contexts/AudioContext';

export interface AIMasteringPreset {
  id: string;
  name: string;
  timestamp: number;
  platform: string;
  style: string;
  intensity: string;
  aiConfig: any | null;
  validation: any | null;
  processing: ProcessingParams;
}

const STORAGE_KEY = 'masterpro-ai-mastering-presets';

export function loadAIPresets(): AIMasteringPreset[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveAIPresets(presets: AIMasteringPreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

const LAST_KEY = 'masterpro-ai-last';

export interface LastAISettings {
  platform: string;
  style: string;
  intensity: string;
  aiConfig: any | null;
  validation: any | null;
  processing: ProcessingParams | null;
}

export function loadLastAISettings(): LastAISettings | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLastAISettings(s: LastAISettings): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(s));
  } catch {}
}
