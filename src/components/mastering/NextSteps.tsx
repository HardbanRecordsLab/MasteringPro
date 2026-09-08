import { useEffect, useMemo, useState } from 'react';
import { Lightbulb, ArrowRight, Check, Compass } from 'lucide-react';
import { useAudio } from '@/contexts/AudioContext';
import { useUIMode } from '@/contexts/UIModeContext';
import { useTour } from '@/contexts/TourContext';
import { STEPS_BY_MODE } from '@/lib/tourSteps';

const NextSteps = () => {
  const { mode } = useUIMode();
  const { state } = useAudio();
  const { start, goTo, active: tourActive } = useTour();
  const hasAudio = !!state.audioBuffer;

  const steps = STEPS_BY_MODE[mode];

  // Default "current" = first step whose prerequisite is unmet.
  const autoIndex = useMemo(() => {
    const idx = steps.findIndex(s => (s.requiresAudio ? hasAudio : true) === false);
    if (idx === -1) return hasAudio ? 1 : 0;
    return idx;
  }, [steps, hasAudio]);

  const [activeIndex, setActiveIndex] = useState(autoIndex);
  useEffect(() => { setActiveIndex(autoIndex); }, [autoIndex, mode]);


  // Highlight the target element via a global class (off while the guided tour runs).
  useEffect(() => {
    const step = steps[activeIndex];
    if (!step || tourActive) return;


    let el: Element | null = null;
    let raf = 0;

    const attach = () => {
      el = document.querySelector(step.selector);
      if (el) {
        el.classList.add('tour-highlight');
      } else {
        raf = window.setTimeout(attach, 250) as unknown as number;
      }
    };
    attach();

    return () => {
      if (raf) window.clearTimeout(raf);
      if (el) el.classList.remove('tour-highlight');
    };
  }, [activeIndex, steps, mode, hasAudio, tourActive]);

  const active = steps[activeIndex];

  return (
    <div className="panel p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-display text-base text-foreground flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-primary" strokeWidth={1.5} />
          Co dalej?
        </h3>
        <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
          Tryb {mode}
        </span>
      </div>

      {active && (
        <div className="mb-4 p-3 rounded-xl inset-well border-primary/25">
          <div className="flex items-start gap-2.5">
            <ArrowRight className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" strokeWidth={1.5} />
            <div>
              <div className="text-sm font-semibold text-foreground">{active.label}</div>
              <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{active.hint}</div>
            </div>
          </div>
        </div>
      )}

      <ol className="space-y-1.5">
        {steps.map((s, i) => {
          const done = i < activeIndex;
          const current = i === activeIndex;
          return (
            <li key={s.label}>
              <button
                onClick={() => { setActiveIndex(i); goTo(i); }}
                className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left text-xs border transition-all ${
                  current
                    ? 'border-primary/25 bg-primary/5 text-primary'
                    : 'border-transparent text-foreground hover:border-border hover:bg-background'
                }`}
              >
                <span
                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-mono font-bold flex-shrink-0 ${
                    done
                      ? 'bg-secondary text-primary'
                      : current
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="w-3 h-3" strokeWidth={2} /> : String(i + 1).padStart(2, '0')}
                </span>
                <span className={done ? 'line-through opacity-50' : 'font-medium'}>{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <button
        onClick={start}
        className="mt-5 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-[0.14em] bg-primary text-primary-foreground hover:brightness-110 transition-all"
      >
        <Compass className="w-3.5 h-3.5" strokeWidth={1.75} />
        Uruchom przewodnik
      </button>

      <div className="mt-auto pt-5">
        <div className="p-4 inset-well rounded-xl">
          <span className="block text-[9px] font-bold uppercase tracking-[0.2em] text-primary mb-2">Pro tip</span>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Użyj utworu referencyjnego, aby AI mogło lepiej dopasować balans tonalny.
          </p>
        </div>
      </div>
    </div>
  );
};

export default NextSteps;
