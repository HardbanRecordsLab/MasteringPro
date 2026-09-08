import { useMemo, useState } from 'react';
import { Wrench, VolumeX, Waves, Zap, Radio, Speaker, Sparkles, Check } from 'lucide-react';
import { useAudio, type ProcessingParams } from '@/contexts/AudioContext';
import { analyzeAudio, type AudioMetrics } from '@/lib/audioAnalysis';
import AIExplain from './AIExplain';
import { toast } from 'sonner';

type FixId = 'mud' | 'harsh' | 'clip' | 'bass' | 'mono' | 'wide' | 'presence' | 'warmth';

interface FixDef {
  id: FixId;
  label: string;
  icon: typeof Wrench;
  explain: string;
  when: (m: AudioMetrics) => boolean;      // recommended?
  apply: (p: ProcessingParams, m: AudioMetrics) => ProcessingParams;
  summary: (m: AudioMetrics) => string;
}

const setBand = (p: ProcessingParams, idx: number, patch: Partial<ProcessingParams['eqBands'][number]>) => {
  const eqBands = p.eqBands.map((b, i) => i === idx ? { ...b, ...patch } : b);
  return { ...p, eqBands, eqEnabled: true };
};

// find band closest to freq
const nearest = (bands: ProcessingParams['eqBands'], freq: number) => {
  let best = 0, dist = Infinity;
  bands.forEach((b, i) => {
    const d = Math.abs(Math.log2(b.freq / freq));
    if (d < dist) { dist = d; best = i; }
  });
  return best;
};

const FIXES: FixDef[] = [
  {
    id: 'mud', label: 'Fix Mud', icon: Waves,
    explain: 'Cuts a bell around 250-350Hz to clear boxy/muddy low-mids.',
    when: m => m.mudIndex > 55,
    summary: m => `Mud index ${m.mudIndex}/100`,
    apply: (p) => {
      const idx = nearest(p.eqBands, 280);
      return setBand(p, idx, { freq: 280, gain: -3.5, q: 1.4, type: 'peaking' });
    },
  },
  {
    id: 'harsh', label: 'Fix Harsh', icon: VolumeX,
    explain: 'Gentle cut around 3-4kHz to reduce sibilance & listener fatigue.',
    when: m => m.harshnessIndex > 55 || m.sibilanceLevel > -30,
    summary: m => `Harsh ${m.harshnessIndex}/100 · Sib ${m.sibilanceLevel}dB`,
    apply: (p) => {
      const idx = nearest(p.eqBands, 3500);
      return setBand(p, idx, { freq: 3500, gain: -2.5, q: 1.8, type: 'peaking' });
    },
  },
  {
    id: 'clip', label: 'Fix Clipping', icon: Zap,
    explain: 'Sets limiter ceiling to -1.0dBFS and adds -1dB input trim so peaks stay legal.',
    when: m => m.truePeak > -0.3,
    summary: m => `TP ${m.truePeak}dBFS`,
    apply: (p) => ({
      ...p,
      inputGain: Math.max(-6, p.inputGain - 1),
      limiterEnabled: true,
      limiterCeiling: -1.0,
      limiterRelease: Math.max(50, Math.min(200, p.limiterRelease)),
    }),
  },
  {
    id: 'bass', label: 'Fix Bass', icon: Speaker,
    explain: 'Small low-shelf lift at 80Hz with tight Q, HPF-like taper below 30Hz via input gain safety.',
    when: m => m.frequencyBalance.sub + m.frequencyBalance.bass < 22,
    summary: m => `Low energy ${(m.frequencyBalance.sub + m.frequencyBalance.bass).toFixed(0)}%`,
    apply: (p) => {
      const idx = nearest(p.eqBands, 80);
      return setBand(p, idx, { freq: 80, gain: 2.5, q: 0.8, type: 'lowshelf' });
    },
  },
  {
    id: 'mono', label: 'Fix Mono Compat', icon: Radio,
    explain: 'Narrows the sides in the low end (Mid/Side EQ) so bass sums correctly to mono.',
    when: m => m.lowEndMonoCompat < 0.5,
    summary: m => `LowMono ${(m.lowEndMonoCompat*100).toFixed(0)}%`,
    apply: (p) => ({
      ...p,
      msEnabled: true,
      msSideLow: -6,
      msSideLowFreq: 120,
      stereoWidth: Math.min(p.stereoWidth, 110),
      widthEnabled: true,
    }),
  },
  {
    id: 'wide', label: 'Widen Stereo', icon: Sparkles,
    explain: 'Increases stereo width to ~120% while keeping correlation safe.',
    when: m => m.stereoWidth < 80 && !m.isMono,
    summary: m => `Width ${m.stereoWidth}%`,
    apply: (p) => ({ ...p, widthEnabled: true, stereoWidth: 120 }),
  },
  {
    id: 'presence', label: 'Add Presence', icon: Sparkles,
    explain: 'High-shelf lift near 10kHz for air, and 4-5kHz presence bump for vocals/guitars.',
    when: m => m.frequencyBalance.air < 10,
    summary: m => `Air ${m.frequencyBalance.air.toFixed(0)}%`,
    apply: (p) => {
      const air = nearest(p.eqBands, 10000);
      const pres = nearest(p.eqBands, 4500);
      let next = setBand(p, air, { freq: 10000, gain: 2, q: 0.7, type: 'highshelf' });
      next = setBand(next, pres, { freq: 4500, gain: 1.5, q: 1.2, type: 'peaking' });
      return next;
    },
  },
  {
    id: 'warmth', label: 'Add Warmth', icon: Waves,
    explain: 'Adds gentle tube-style saturation and a low-mid tilt for analog warmth.',
    when: m => m.spectralTilt > 0.5,
    summary: m => `Tilt ${m.spectralTilt}dB/oct (bright)`,
    apply: (p) => {
      const idx = nearest(p.eqBands, 200);
      let next = setBand(p, idx, { freq: 200, gain: 1.5, q: 0.9, type: 'peaking' });
      next = { ...next, saturationEnabled: true, saturation: Math.max(next.saturation, 20) };
      return next;
    },
  },
];

const AIFixPanel = () => {
  const { state, processing, setProcessing } = useAudio();
  const [applied, setApplied] = useState<Set<FixId>>(new Set());

  const metrics = useMemo(
    () => state.audioBuffer ? analyzeAudio(state.audioBuffer) : null,
    [state.audioBuffer]
  );

  if (!metrics) return null;

  const handleFix = (fix: FixDef) => {
    setProcessing(prev => fix.apply(prev, metrics));
    setApplied(prev => new Set(prev).add(fix.id));
    toast.success(`Applied: ${fix.label}`);
  };

  const recommended = FIXES.filter(f => f.when(metrics));
  const others = FIXES.filter(f => !f.when(metrics));

  return (
    <div className="panel p-3 space-y-3">
      <div className="flex items-center gap-1.5">
        <Wrench className="w-3.5 h-3.5 text-primary" />
        <span className="text-section-header">AI Fix</span>
        <AIExplain text="One-click surgical fixes based on live analysis of your track. Highlighted fixes are recommended right now." />
      </div>

      {recommended.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[9px] uppercase tracking-wider text-warning">Recommended for this track</span>
          <div className="grid grid-cols-2 gap-1.5">
            {recommended.map(f => {
              const Icon = f.icon;
              const done = applied.has(f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => handleFix(f)}
                  className="group flex flex-col items-start gap-0.5 p-2 rounded-sm border border-warning/40 bg-warning/5 hover:bg-warning/10 transition-colors text-left"
                  title={f.explain}
                >
                  <div className="flex items-center gap-1 w-full">
                    <Icon className="w-3 h-3 text-warning" />
                    <span className="text-[10px] text-foreground flex-1">{f.label}</span>
                    {done && <Check className="w-3 h-3 text-meter-green" />}
                    <AIExplain text={f.explain} />
                  </div>
                  <span className="text-[8px] text-muted-foreground font-mono">{f.summary(metrics)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">All fixes</span>
        <div className="grid grid-cols-2 gap-1.5">
          {others.map(f => {
            const Icon = f.icon;
            const done = applied.has(f.id);
            return (
              <button
                key={f.id}
                onClick={() => handleFix(f)}
                className="group flex items-center gap-1 p-1.5 rounded-sm bg-background hover:bg-secondary transition-colors text-left"
                title={f.explain}
              >
                <Icon className="w-3 h-3 text-muted-foreground group-hover:text-primary" />
                <span className="text-[10px] text-muted-foreground group-hover:text-foreground flex-1">{f.label}</span>
                {done && <Check className="w-3 h-3 text-meter-green" />}
                <AIExplain text={f.explain} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default AIFixPanel;
