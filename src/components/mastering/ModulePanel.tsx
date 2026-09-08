import { Power } from 'lucide-react';
import { Slider } from '@/components/ui/slider';

interface ModulePanelProps {
  title: string;
  children: React.ReactNode;
  enabled?: boolean;
  onToggle?: () => void;
}

const ModulePanel = ({ title, children, enabled = true, onToggle }: ModulePanelProps) => (
  <div className={`${enabled ? 'panel-active' : 'panel opacity-60'} tile-hover p-4`}>
    <div className="flex items-center justify-between mb-3.5">
      <span className="text-section-header">{title}</span>
      {onToggle && (
        <button
          onClick={onToggle}
          className={`p-1.5 rounded-md border transition-colors ${
            enabled
              ? 'text-primary border-primary/30 bg-primary/5'
              : 'text-muted-foreground border-border hover:text-foreground'
          }`}
        >
          <Power className="w-3.5 h-3.5" strokeWidth={1.5} />
        </button>
      )}
      {!onToggle && (
        <div className="w-2 h-2 rounded-full bg-primary/50 animate-pulse" title="Active" />
      )}
    </div>
    {enabled && children}
  </div>
);


interface KnobControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange?: (v: number) => void;
}

export const KnobControl = ({ label, value, min, max, step = 1, unit = '', onChange }: KnobControlProps) => (
  <div className="flex flex-col gap-2">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
      <span className="text-[11px] font-mono font-medium text-primary">
        {value.toFixed(step < 1 ? 1 : 0)}{unit}
      </span>
    </div>
    <Slider
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange?.(v[0])}
      className="w-full"
    />
  </div>
);


export const GainReductionMeter = ({ value = 0 }: { value?: number }) => {
  const width = Math.min(Math.abs(value) / 20 * 100, 100);
  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-[9px] text-muted-foreground uppercase">GR</span>
      <div className="flex-1 h-1.5 bg-background rounded-sm overflow-hidden">
        <div
          className="h-full bg-meter-yellow rounded-sm transition-all duration-75"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-[9px] font-mono text-muted-foreground">{value.toFixed(1)}dB</span>
    </div>
  );
};

export default ModulePanel;
