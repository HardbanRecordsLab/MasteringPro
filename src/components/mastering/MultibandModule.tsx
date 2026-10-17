import { useEffect, useRef, useState } from 'react';
import ModulePanel, { KnobControl, GainReductionMeter } from './ModulePanel';
import { Loader2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAudio } from '@/contexts/AudioContext';
import { profileAudio } from '@/lib/profileClient';
import { autoTuneMultiband, type TuneMode } from '@/lib/dsp/match';
import {
  BAND_NAMES,
  DEFAULT_XOVERS_5,
  convertBandCount,
  resolveMultiband,
} from '@/lib/multiband';

const pill = (on: boolean) =>
  `text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground hover:text-foreground'}`;

/** crossover limits so neighbouring crossovers can never cross or collapse */
function xoverRange(xovers: number[], i: number): [number, number] {
  const lo = i === 0 ? 30 : Math.round(xovers[i - 1] * 1.25);
  const hi = i === xovers.length - 1 ? 16000 : Math.round(xovers[i + 1] / 1.25);
  return [lo, Math.max(lo + 10, hi)];
}

const MultibandModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();
  const cfg = resolveMultiband(processing);
  const n = cfg.bands.length;
  const names = BAND_NAMES[n] ?? cfg.bands.map((_, i) => `Band ${i + 1}`);
  const [gr, setGr] = useState<number[]>(() => Array(n).fill(0));
  const [lvl, setLvl] = useState<number[]>(() => Array(n).fill(-120));
  const [monitor, setMonitor] = useState(-1);
  const [advanced, setAdvanced] = useState(false);
  const [tuneMode, setTuneMode] = useState<TuneMode>('balanced');
  const [tuning, setTuning] = useState(false);
  const rafRef = useRef(0);

  const active = state.isPlaying && processing.mbEnabled;
  useEffect(() => {
    if (!engine || !active) { setGr(Array(n).fill(0)); return; }
    const tick = () => {
      setGr(engine.getMultibandGR().slice());
      setLvl(engine.getMultibandLevels().slice());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, active, n]);

  // monitoring (solo / delta) is a listening aid only: it must never stay on after this panel goes away or the module is bypassed
  useEffect(() => {
    engine?.setMultibandMonitor(processing.mbEnabled ? monitor : -1);
  }, [engine, monitor, processing.mbEnabled]);
  useEffect(() => () => { engine?.setMultibandMonitor(-1); }, [engine]);
  useEffect(() => { if (monitor >= n) setMonitor(-1); }, [n, monitor]);

  const setBand = (i: number, key: string, v: number) =>
    setProcessing((p) => ({ ...p, mbBands: p.mbBands.map((b, j) => (j === i ? { ...b, [key]: v } : b)) }));

  const setXover = (i: number, v: number) =>
    setProcessing((p) => {
      if (p.mbBands.length === 3) return i === 0 ? { ...p, mbXover1: v } : { ...p, mbXover2: v };
      const x = (p.mbXovers ?? DEFAULT_XOVERS_5).slice();
      x[i] = v;
      return { ...p, mbXovers: x };
    });

  const autoTune = async () => {
    if (!state.audioBuffer) return;
    setTuning(true);
    try {
      const prof = await profileAudio(state.audioBuffer);
      const bands = autoTuneMultiband(prof, tuneMode);
      setProcessing((p) => ({ ...p, mbEnabled: true, mbBands: bands, mbXovers: prof.edges }));
      const worked = bands.filter((b) => b.ratio > 1).length;
      toast.success(worked ? `Auto-tuned ${worked} of 5 bands (${tuneMode})` : 'Dynamics already tight — nothing to compress');
    } catch (e) {
      toast.error('Auto-tune failed');
      console.error(e);
    } finally {
      setTuning(false);
    }
  };

  const setLayout = (target: 3 | 5) =>
    setProcessing((p) => ({ ...p, ...convertBandCount(p, target) }));

  return (
    <ModulePanel
      title="Multiband Comp 2.0"
      enabled={processing.mbEnabled}
      onToggle={() => setProcessing((p) => ({ ...p, mbEnabled: !p.mbEnabled }))}
    >
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <button onClick={() => setLayout(3)} className={pill(n === 3)}>3 bands</button>
        <button onClick={() => setLayout(5)} className={pill(n === 5)}>5 bands</button>
        <span className="w-px h-3 bg-border mx-1" />
        <span className="text-[8px] uppercase tracking-wider text-muted-foreground">Listen</span>
        <button onClick={() => setMonitor(-1)} className={pill(monitor === -1)}>Off</button>
        <button onClick={() => setMonitor(-2)} className={pill(monitor === -2)} title="Hear only what the compressor removes">Delta</button>
        {names.map((nm, i) => (
          <button key={nm} onClick={() => setMonitor(monitor === i ? -1 : i)} className={pill(monitor === i)} title={`Solo ${nm}`}>S{i + 1}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 mb-3">
        {(['gentle', 'balanced', 'dense'] as TuneMode[]).map((m) => (
          <button key={m} onClick={() => setTuneMode(m)} className={pill(tuneMode === m)}>{m}</button>
        ))}
        <button
          onClick={autoTune}
          disabled={tuning || !state.audioBuffer}
          className="ml-auto flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50"
          title="Measure the level range of each band and set threshold and ratio to tighten it"
        >
          {tuning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Auto-tune
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        {cfg.xovers.map((f, i) => {
          const [lo, hi] = xoverRange(cfg.xovers, i);
          return (
            <KnobControl
              key={i}
              label={`XOver ${names[i]}/${names[i + 1]}`}
              value={f} min={lo} max={hi} step={1} unit="Hz"
              onChange={(v) => setXover(i, v)}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <KnobControl label="Mix (parallel)" value={processing.mbMix ?? 100} min={0} max={100} step={1} unit="%"
          onChange={(v) => setProcessing((p) => ({ ...p, mbMix: v }))} />
        <KnobControl label="Lookahead" value={processing.mbLookahead ?? 0} min={0} max={5} step={0.5} unit="ms"
          onChange={(v) => setProcessing((p) => ({ ...p, mbLookahead: v }))} />
      </div>

      {cfg.bands.map((band, i) => (
        <div key={names[i]} className={`mb-2 ${monitor === i ? 'ring-1 ring-primary/40 rounded-sm p-1 -m-1' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase text-muted-foreground tracking-wider">{names[i]}</span>
            <span className="text-[8px] font-mono text-primary">
              {(lvl[i] ?? -120) > -100 ? `${(lvl[i] ?? 0).toFixed(0)} dB · ` : ''}{(gr[i] ?? 0).toFixed(1)} dB GR
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-1">
            <KnobControl label="Thresh" value={band.threshold} min={-48} max={0} step={0.5} unit="dB" onChange={(v) => setBand(i, 'threshold', v)} />
            <KnobControl label="Ratio" value={band.ratio} min={1} max={12} step={0.1} onChange={(v) => setBand(i, 'ratio', v)} />
            <KnobControl label="Makeup" value={band.makeup} min={-6} max={12} step={0.1} unit="dB" onChange={(v) => setBand(i, 'makeup', v)} />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-1">
            <KnobControl label="Attack" value={band.attack} min={0.5} max={100} step={0.5} unit="ms" onChange={(v) => setBand(i, 'attack', v)} />
            <KnobControl label="Release" value={band.release} min={20} max={800} step={5} unit="ms" onChange={(v) => setBand(i, 'release', v)} />
          </div>
          {advanced && (
            <div className="grid grid-cols-3 gap-2 mt-1">
              <KnobControl label="Knee" value={band.knee} min={0} max={18} step={0.5} unit="dB" onChange={(v) => setBand(i, 'knee', v)} />
              <KnobControl label="Link" value={Math.round((band.link ?? 1) * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => setBand(i, 'link', v / 100)} />
              <KnobControl label="Detect" value={Math.round((band.detect ?? 0.3) * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => setBand(i, 'detect', v / 100)} />
            </div>
          )}
          <GainReductionMeter value={gr[i] ?? 0} />
        </div>
      ))}

      <div className="flex items-center justify-between mt-1">
        <button onClick={() => setAdvanced((a) => !a)} className={pill(advanced)}>Advanced</button>
        <span className="text-[8px] text-muted-foreground">Detect 0 % = RMS · 100 % = peak</span>
      </div>
    </ModulePanel>
  );
};

export default MultibandModule;
