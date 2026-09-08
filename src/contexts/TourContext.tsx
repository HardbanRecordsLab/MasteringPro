import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useUIMode } from '@/contexts/UIModeContext';
import { STEPS_BY_MODE, type TourStep } from '@/lib/tourSteps';

const AUTOPLAY_KEY = 'masterpro.tour.autoplay';
export const MIN_STEP_MS = 2000;
export const MAX_STEP_MS = 15000;
export const DEFAULT_STEP_MS = 6000;

interface TourCtx {
  active: boolean;
  index: number;
  steps: TourStep[];
  start: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  goTo: (i: number) => void;
  /** Auto-advance enabled (may still be paused). */
  autoPlay: boolean;
  setAutoPlay: (v: boolean) => void;
  /** Paused by the user while autoplay is on. */
  paused: boolean;
  setPaused: (v: boolean) => void;
  /** Milliseconds spent on each step before advancing. */
  stepMs: number;
  setStepMs: (ms: number) => void;
  /** 0..1 progress of the current step's timer (0 when autoplay is off/paused). */
  autoProgress: number;
}

const noop = () => {};

// A safe default keeps the app rendering even if a consumer mounts outside the
// provider (e.g. during hot-module reload), instead of crashing the whole tree.
const DEFAULT_CTX: TourCtx = {
  active: false,
  index: 0,
  steps: [],
  start: noop,
  stop: noop,
  next: noop,
  prev: noop,
  goTo: noop,
  autoPlay: false,
  setAutoPlay: noop,
  paused: false,
  setPaused: noop,
  stepMs: DEFAULT_STEP_MS,
  setStepMs: noop,
  autoProgress: 0,
};

const Ctx = createContext<TourCtx>(DEFAULT_CTX);

function loadAutoplayPrefs(): { autoPlay: boolean; stepMs: number } {
  try {
    const raw = localStorage.getItem(AUTOPLAY_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { autoPlay?: boolean; stepMs?: number };
      return {
        autoPlay: !!p.autoPlay,
        stepMs: Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, p.stepMs ?? DEFAULT_STEP_MS)),
      };
    }
  } catch { /* ignore */ }
  return { autoPlay: false, stepMs: DEFAULT_STEP_MS };
}

export const TourProvider = ({ children }: { children: ReactNode }) => {
  const { mode } = useUIMode();
  const steps = STEPS_BY_MODE[mode];
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);

  const [prefs] = useState(loadAutoplayPrefs);
  const [autoPlay, setAutoPlayState] = useState(prefs.autoPlay);
  const [stepMs, setStepMsState] = useState(prefs.stepMs);
  const [paused, setPaused] = useState(false);
  const [autoProgress, setAutoProgress] = useState(0);

  const persist = useCallback((next: { autoPlay: boolean; stepMs: number }) => {
    try { localStorage.setItem(AUTOPLAY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const setAutoPlay = useCallback((v: boolean) => {
    setAutoPlayState(v);
    setPaused(false);
    persist({ autoPlay: v, stepMs });
  }, [persist, stepMs]);

  const setStepMs = useCallback((ms: number) => {
    const clamped = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, ms));
    setStepMsState(clamped);
    persist({ autoPlay, stepMs: clamped });
  }, [persist, autoPlay]);

  // Reset when switching modes mid-tour.
  useEffect(() => { setIndex(0); }, [mode]);

  const stop = useCallback(() => { setActive(false); setPaused(false); }, []);
  const start = useCallback(() => { setIndex(0); setPaused(false); setActive(true); }, []);
  const next = useCallback(() => {
    setIndex(i => {
      if (i + 1 >= steps.length) { setActive(false); return i; }
      return i + 1;
    });
  }, [steps.length]);
  const prev = useCallback(() => setIndex(i => Math.max(0, i - 1)), []);
  const goTo = useCallback((i: number) => { setIndex(i); setActive(true); }, []);

  // Auto-advance timer with a smooth progress readout.
  useEffect(() => {
    setAutoProgress(0);
    if (!active || !autoPlay || paused) return;

    const startedAt = performance.now();
    let frame = 0;

    const tick = () => {
      const elapsed = performance.now() - startedAt;
      const p = Math.min(1, elapsed / stepMs);
      setAutoProgress(p);
      if (p >= 1) {
        next();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [active, autoPlay, paused, stepMs, index, next]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === ' ' && autoPlay) { e.preventDefault(); setPaused(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, stop, next, prev, autoPlay]);

  return (
    <Ctx.Provider
      value={{
        active, index, steps, start, stop, next, prev, goTo,
        autoPlay, setAutoPlay, paused, setPaused, stepMs, setStepMs, autoProgress,
      }}
    >
      {children}
    </Ctx.Provider>
  );
};

export const useTour = () => useContext(Ctx);
