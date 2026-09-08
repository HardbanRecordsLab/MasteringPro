import { useState } from 'react';
import ModulePanel, { KnobControl } from './ModulePanel';
import { useAudio } from '@/contexts/AudioContext';

const MidSideEQModule = () => {
  const { processing, setProcessing } = useAudio();
  const [view, setView] = useState<'mid' | 'side' | 'stereo'>('stereo');

  const set = (key: string, v: number) => setProcessing(p => ({ ...p, [key]: v }));

  return (
    <ModulePanel
      title="Mid/Side EQ"
      enabled={processing.msEnabled}
      onToggle={() => setProcessing(p => ({ ...p, msEnabled: !p.msEnabled }))}
    >
      <div className="flex gap-1 mb-3">
        {(['mid', 'side', 'stereo'] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`text-[9px] uppercase px-2 py-0.5 rounded-sm transition-colors ${
              view === v ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="w-full h-20 bg-background rounded-sm mb-3 relative overflow-hidden">
        <svg className="w-full h-full" viewBox="0 0 400 80" preserveAspectRatio="none">
          <line x1="0" y1="40" x2="400" y2="40" stroke="hsl(var(--border))" strokeWidth="0.5" />
          {(view === 'mid' || view === 'stereo') && (
            <path
              d={curveFor([processing.msMidLow, processing.msMidMid, processing.msMidHigh])}
              fill="none" stroke="hsl(var(--primary))" strokeWidth="1.2"
              opacity={view === 'stereo' ? 0.7 : 1}
            />
          )}
          {(view === 'side' || view === 'stereo') && (
            <path
              d={curveFor([processing.msSideLow, processing.msSideMid, processing.msSideHigh])}
              fill="none" stroke="hsl(var(--success))" strokeWidth="1.2"
              opacity={view === 'stereo' ? 0.7 : 1}
            />
          )}
        </svg>
      </div>
      {(view === 'mid' || view === 'stereo') && (
        <div className="space-y-1 mb-2">
          <span className="text-[8px] uppercase text-primary tracking-wider">Mid Channel</span>
          <div className="grid grid-cols-3 gap-2">
            <KnobControl label="Low" value={processing.msMidLow} min={-12} max={6} step={0.1} unit="dB"
              onChange={(v) => set('msMidLow', v)} />
            <KnobControl label="Mid" value={processing.msMidMid} min={-12} max={6} step={0.1} unit="dB"
              onChange={(v) => set('msMidMid', v)} />
            <KnobControl label="High" value={processing.msMidHigh} min={-12} max={6} step={0.1} unit="dB"
              onChange={(v) => set('msMidHigh', v)} />
          </div>
        </div>
      )}
      {(view === 'side' || view === 'stereo') && (
        <div className="space-y-1">
          <span className="text-[8px] uppercase text-success tracking-wider">Side Channel</span>
          <div className="grid grid-cols-3 gap-2">
            <KnobControl label="Low" value={processing.msSideLow} min={-12} max={6} step={0.1} unit="dB"
              onChange={(v) => set('msSideLow', v)} />
            <KnobControl label="Mid" value={processing.msSideMid} min={-12} max={6} step={0.1} unit="dB"
              onChange={(v) => set('msSideMid', v)} />
            <KnobControl label="High" value={processing.msSideHigh} min={-12} max={6} step={0.1} unit="dB"
              onChange={(v) => set('msSideHigh', v)} />
          </div>
        </div>
      )}
    </ModulePanel>
  );
};

// Approximate curve: 3 peaking bands at fixed positions on log freq axis
function curveFor(gains: number[]): string {
  const positions = [80, 200, 320]; // x positions of band centers
  const points: string[] = [];
  for (let x = 0; x <= 400; x += 4) {
    let g = 0;
    for (let i = 0; i < positions.length; i++) {
      const d = (x - positions[i]) / 80;
      g += gains[i] * Math.exp(-d * d);
    }
    const y = 40 - g * 2.5;
    points.push(`${x === 0 ? 'M' : 'L'}${x},${Math.max(2, Math.min(78, y))}`);
  }
  return points.join(' ');
}

export default MidSideEQModule;
