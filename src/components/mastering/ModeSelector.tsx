import { Zap, Sparkles, SlidersHorizontal } from 'lucide-react';
import { useUIMode, type UIMode } from '@/contexts/UIModeContext';

const MODES: { id: UIMode; label: string; icon: typeof Zap; hint: string }[] = [
  { id: 'quick', label: 'Quick',  icon: Zap,              hint: 'Upload → AI → Export. Zero knobs.' },
  { id: 'smart', label: 'Smart',  icon: Sparkles,         hint: 'AI + Fix + Score + A/B. Recommended.' },
  { id: 'pro',   label: 'Pro',    icon: SlidersHorizontal, hint: 'Full DSP: EQ, comp, M/S, metering.' },
];

const ModeSelector = () => {
  const { mode, setMode } = useUIMode();
  return (
    <div className="flex items-center gap-1 p-1 inset-well rounded-lg">
      {MODES.map(m => {
        const Icon = m.icon;
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            title={m.hint}
            className={`flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] rounded-md transition-all ${
              active
                ? 'bg-card text-primary border border-border shadow-[0_0_18px_-8px_hsl(var(--primary)/0.7)]'
                : 'text-muted-foreground hover:text-foreground border border-transparent'
            }`}
          >
            <Icon className="w-3 h-3" strokeWidth={1.5} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
};

export default ModeSelector;
