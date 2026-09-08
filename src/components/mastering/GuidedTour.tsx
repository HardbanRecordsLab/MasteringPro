import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X, Compass, Play, Pause, Timer, SkipForward } from 'lucide-react';
import { useTour, MIN_STEP_MS, MAX_STEP_MS } from '@/contexts/TourContext';
import { useUIMode } from '@/contexts/UIModeContext';

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 8;

const GuidedTour = () => {
  const {
    active, index, steps, next, prev, stop,
    autoPlay, setAutoPlay, paused, setPaused, stepMs, setStepMs, autoProgress,
  } = useTour();

  const { mode } = useUIMode();
  const step = steps[index];
  const [rect, setRect] = useState<Rect | null>(null);

  // Track the target element position (scroll / resize / late mount).
  useLayoutEffect(() => {
    if (!active || !step) return;
    let frame = 0;
    let scrolled = false;

    const measure = () => {
      const el = document.querySelector(step.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        if (!scrolled) {
          scrolled = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        setRect(null);
      }
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [active, step, index, mode]);

  useEffect(() => {
    if (!active) setRect(null);
  }, [active]);

  // Keyboard focus follows the step: focus the target element when it can take
  // focus, otherwise fall back to the step card so screen readers announce it.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !step) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector(step.selector) as HTMLElement | null;
      const focusable = el?.matches('button, a[href], input, select, textarea, [tabindex]')
        ? el
        : (el?.querySelector('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])') as HTMLElement | null);
      if (focusable) focusable.focus({ preventScroll: true });
      else cardRef.current?.focus({ preventScroll: true });
    }, 350);
    return () => window.clearTimeout(t);
  }, [active, step, index, mode]);

  if (!active || !step) return null;

  const spotlight: Rect | null = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  // Card placement: below the target if there's room, otherwise above; fallback = centered.
  const cardWidth = 300;
  let cardStyle: React.CSSProperties = {
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: cardWidth,
  };
  if (spotlight) {
    const below = spotlight.top + spotlight.height + 12;
    const placeBelow = below + 230 < window.innerHeight;
    const top = placeBelow ? below : Math.max(12, spotlight.top - 242);

    const left = Math.min(
      Math.max(12, spotlight.left + spotlight.width / 2 - cardWidth / 2),
      window.innerWidth - cardWidth - 12,
    );
    cardStyle = { top, left, width: cardWidth };
  }

  const isLast = index === steps.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[100] pointer-events-none">
      {/* Dimmed backdrop with a cut-out over the target */}
      {spotlight ? (
        <div
          className="absolute inset-0 transition-all duration-200"
          style={{
            boxShadow: `0 0 0 9999px hsl(var(--background) / 0.78)`,
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            borderRadius: 'var(--radius)',
            outline: '2px solid hsl(var(--primary) / 0.9)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-background/70" />
      )}

      {/* Step card */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-step-label"
        aria-describedby="tour-step-hint"
        tabIndex={-1}
        className="absolute panel p-3 pointer-events-auto shadow-xl border-primary/40 animate-fade-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        style={cardStyle}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-section-header flex items-center gap-1.5">
            <Compass className="w-3 h-3 text-primary" aria-hidden="true" />
            Przewodnik · {mode}
          </span>
          <button
            type="button"
            onClick={stop}
            aria-label="Zamknij przewodnik"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        <div id="tour-step-label" className="text-sm font-medium text-foreground">{step.label}</div>
        <div id="tour-step-hint" className="text-[11px] text-muted-foreground mt-1">{step.hint}</div>
        <div aria-live="polite" className="sr-only">
          Krok {index + 1} z {steps.length}: {step.label}. {step.hint}
        </div>
        {!rect && (
          <div className="text-[10px] text-primary mt-2">
            Ten element pojawi się po wykonaniu poprzedniego kroku.
          </div>
        )}


        {/* Progress dots */}
        <div
          className="flex items-center gap-1 mt-3"
          role="progressbar"
          aria-label="Postęp przewodnika"
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={index + 1}
          aria-valuetext={`Krok ${index + 1} z ${steps.length}`}
        >
          {steps.map((s, i) => (
            <span
              key={s.label}
              aria-hidden="true"
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= index ? 'bg-primary' : 'bg-secondary'
              }`}
            />
          ))}
        </div>

        {/* Auto-advance timer bar */}
        {autoPlay && (
          <div className="h-0.5 mt-1.5 rounded-full bg-secondary overflow-hidden" aria-hidden="true">
            <div
              className={`h-full ${paused ? 'bg-muted-foreground' : 'bg-primary'}`}
              style={{ width: `${Math.round(autoProgress * 100)}%` }}
            />
          </div>
        )}

        {/* Autoplay controls */}
        <div className="mt-3 pt-2 border-t border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={autoPlay}
                onChange={e => setAutoPlay(e.target.checked)}
                className="accent-primary w-3 h-3"
                aria-label="Auto-przechodzenie kroków"
              />
              Auto-przechodzenie
            </label>
            {autoPlay && (
              <button
                type="button"
                onClick={() => setPaused(!paused)}
                aria-label={paused ? 'Wznów auto-przechodzenie' : 'Wstrzymaj auto-przechodzenie'}
                aria-pressed={paused}
                className="px-2 py-1 rounded-sm text-[10px] bg-secondary text-foreground hover:bg-muted transition-colors flex items-center gap-1"
              >
                {paused
                  ? <><Play className="w-3 h-3" aria-hidden="true" /> Wznów</>
                  : <><Pause className="w-3 h-3" aria-hidden="true" /> Pauza</>}
              </button>
            )}
          </div>

          {autoPlay && (
            <div className="flex items-center gap-2">
              <Timer className="w-3 h-3 text-muted-foreground flex-shrink-0" aria-hidden="true" />
              <input
                type="range"
                min={MIN_STEP_MS}
                max={MAX_STEP_MS}
                step={500}
                value={stepMs}
                onChange={e => setStepMs(Number(e.target.value))}
                className="flex-1 accent-primary h-1"
                aria-label="Czas trwania kroku"
                aria-valuetext={`${(stepMs / 1000).toFixed(1)} sekundy`}
              />
              <span className="text-[10px] font-mono text-muted-foreground w-9 text-right">
                {(stepMs / 1000).toFixed(1)}s
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-3">
          <span className="text-[10px] font-mono text-muted-foreground" aria-hidden="true">
            {index + 1}/{steps.length}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={prev}
              disabled={index === 0}
              aria-label="Poprzedni krok przewodnika"
              className="px-2 py-1 rounded-sm text-[11px] bg-secondary text-foreground hover:bg-muted disabled:opacity-40 transition-colors flex items-center gap-1"
            >
              <ArrowLeft className="w-3 h-3" aria-hidden="true" /> Wstecz
            </button>
            {!isLast && (
              <button
                type="button"
                onClick={next}
                aria-label="Pomiń bieżący krok i przejdź do następnego"
                className="px-2 py-1 rounded-sm text-[11px] bg-secondary text-foreground hover:bg-muted transition-colors flex items-center gap-1"
              >
                Pomiń <SkipForward className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={isLast ? stop : next}
              aria-label={isLast ? 'Zakończ przewodnik' : 'Następny krok przewodnika'}
              className="px-2.5 py-1 rounded-sm text-[11px] bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center gap-1"
            >
              {isLast ? 'Zakończ' : 'Dalej'}
              {!isLast && <ArrowRight className="w-3 h-3" aria-hidden="true" />}
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body,
  );
};

export default GuidedTour;
