import { useState, useEffect, useRef } from 'react';
import { Save, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import ModulePanel, { KnobControl, GainReductionMeter } from './ModulePanel';
import { useAudio } from '@/contexts/AudioContext';
import {
  loadGatePresets,
  saveGatePresets,
  type NoiseGatePreset,
} from '@/lib/noiseGatePresets';
import { estimateAutoThreshold, type AutoThresholdResult } from '@/lib/noiseFloorAnalysis';

// Hook to poll gain reduction from a DynamicsCompressorNode
function useGainReduction(getGR: (() => number) | undefined, active: boolean): number {
  const [gr, setGr] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!getGR || !active) { setGr(0); return; }
    const tick = () => {
      setGr(getGR());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getGR, active]);

  return gr;
}

const InputGainModule = () => {
  const { processing, setProcessing } = useAudio();
  return (
    <ModulePanel title="Input Gain">
      <KnobControl
        label="Gain" value={processing.inputGain}
        min={-24} max={24} step={0.1} unit="dB"
        onChange={(v) => setProcessing(p => ({ ...p, inputGain: v }))}
      />
    </ModulePanel>
  );
};

type AutoMode = 'mono' | 'lr' | 'midside';

const NoiseGateModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();
  const [gr, setGr] = useState(0);
  const [autoResult, setAutoResult] = useState<AutoThresholdResult | null>(null);
  const [autoInfo, setAutoInfo] = useState<string | null>(null);
  const [previewThreshold, setPreviewThreshold] = useState<number | null>(null);
  const rafRef = useRef(0);

  // Auto-threshold settings
  const [autoMode, setAutoMode] = useState<AutoMode>('mono');
  const [windowMs, setWindowMs] = useState(20);
  const [percentilePct, setPercentilePct] = useState(10); // 5..20 typical
  const [marginDb, setMarginDb] = useState(6);
  const [autoOpen, setAutoOpen] = useState(false);

  // Presets
  const [presets, setPresets] = useState<NoiseGatePreset[]>(() => loadGatePresets());
  const [presetName, setPresetName] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);

  useEffect(() => {
    saveGatePresets(presets);
  }, [presets]);

  useEffect(() => {
    if (!engine || !state.isPlaying || !processing.gateEnabled) { setGr(0); return; }
    const tick = () => {
      setGr(engine.getNoiseGateGR());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, state.isPlaying, processing.gateEnabled]);

  const computeAutoThreshold = (): { chosen: number; info: string; result: AutoThresholdResult } | null => {
    if (!state.audioBuffer) return null;
    const result = estimateAutoThreshold(state.audioBuffer, {
      windowMs,
      percentile: percentilePct / 100,
      marginDb,
    });
    let chosen: number;
    let info: string;
    if (autoMode === 'lr' && result.channels.length === 2) {
      const [l, r] = result.channels;
      chosen = Math.max(l.thresholdDb, r.thresholdDb);
      info = `L ${l.noiseFloorDb.toFixed(1)} / R ${r.noiseFloorDb.toFixed(1)} dB → Thr ${chosen.toFixed(1)} dB`;
    } else if (autoMode === 'midside' && result.midSide) {
      const { mid, side } = result.midSide;
      chosen = Math.max(mid.thresholdDb, side.thresholdDb);
      info = `M ${mid.noiseFloorDb.toFixed(1)} / S ${side.noiseFloorDb.toFixed(1)} dB → Thr ${chosen.toFixed(1)} dB`;
    } else {
      chosen = result.combined.thresholdDb;
      info = `Floor ${result.combined.noiseFloorDb.toFixed(1)} dB → Thr ${chosen.toFixed(1)} dB`;
    }
    return { chosen: Math.round(chosen * 10) / 10, info, result };
  };

  const handlePreviewThreshold = () => {
    const out = computeAutoThreshold();
    if (!out) {
      setAutoInfo('Load audio first');
      setAutoResult(null);
      setPreviewThreshold(null);
      return;
    }
    setAutoResult(out.result);
    setAutoInfo(`Preview: ${out.info}`);
    setPreviewThreshold(out.chosen);
  };

  const handleAutoThreshold = () => {
    const out = computeAutoThreshold();
    if (!out) {
      setAutoInfo('Load audio first');
      setAutoResult(null);
      return;
    }
    setAutoResult(out.result);
    setProcessing(p => ({ ...p, gateThreshold: out.chosen }));
    setAutoInfo(out.info);
    setPreviewThreshold(null);
  };

  const handleApplyPreview = () => {
    if (previewThreshold === null) return;
    setProcessing(p => ({ ...p, gateThreshold: previewThreshold }));
    setAutoInfo(`Applied ${previewThreshold.toFixed(1)} dB`);
    setPreviewThreshold(null);
  };

  const handleSavePreset = () => {
    const name = presetName.trim() || `Gate ${presets.length + 1}`;
    const preset: NoiseGatePreset = {
      id: crypto.randomUUID(),
      name,
      timestamp: Date.now(),
      threshold: processing.gateThreshold,
      range: processing.gateRange,
      attack: processing.gateAttack,
      hold: processing.gateHold,
      release: processing.gateRelease,
      autoMode,
      autoWindowMs: windowMs,
      autoPercentile: percentilePct / 100,
      autoMarginDb: marginDb,
    };
    setPresets(prev => [preset, ...prev]);
    setPresetName('');
  };

  const handleLoadPreset = (preset: NoiseGatePreset) => {
    setProcessing(p => ({
      ...p,
      gateEnabled: true,
      gateThreshold: preset.threshold,
      gateRange: preset.range,
      gateAttack: preset.attack,
      gateHold: preset.hold,
      gateRelease: preset.release,
    }));
    setAutoMode(preset.autoMode);
    setWindowMs(preset.autoWindowMs);
    setPercentilePct(Math.round(preset.autoPercentile * 100));
    setMarginDb(preset.autoMarginDb);
  };

  const handleDeletePreset = (id: string) => {
    setPresets(prev => prev.filter(p => p.id !== id));
  };

  return (
    <ModulePanel
      title="Noise Gate"
      enabled={processing.gateEnabled}
      onToggle={() => setProcessing(p => ({ ...p, gateEnabled: !p.gateEnabled }))}
    >
      <div className="grid grid-cols-2 gap-3">
        <KnobControl label="Threshold" value={processing.gateThreshold} min={-80} max={0} unit="dB"
          onChange={(v) => setProcessing(p => ({ ...p, gateThreshold: v }))} />
        <KnobControl label="Attack" value={processing.gateAttack} min={0.1} max={50} step={0.1} unit="ms"
          onChange={(v) => setProcessing(p => ({ ...p, gateAttack: v }))} />
        <KnobControl label="Hold" value={processing.gateHold} min={0} max={500} unit="ms"
          onChange={(v) => setProcessing(p => ({ ...p, gateHold: v }))} />
        <KnobControl label="Release" value={processing.gateRelease} min={5} max={1000} unit="ms"
          onChange={(v) => setProcessing(p => ({ ...p, gateRelease: v }))} />
      </div>
      <KnobControl label="Range" value={processing.gateRange} min={-80} max={0} unit="dB"
        onChange={(v) => setProcessing(p => ({ ...p, gateRange: v }))} />

      {/* Auto Threshold section */}
      <div className="mt-3 border-t border-border/50 pt-2">
        <button
          onClick={() => setAutoOpen(o => !o)}
          className="w-full flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="flex items-center gap-1">
            {autoOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Auto Threshold
          </span>
          <span className="font-mono text-[9px] text-primary/70">
            {autoMode === 'mono' ? 'Mono' : autoMode === 'lr' ? 'L+R' : 'Mid/Side'}
          </span>
        </button>

        {autoOpen && (
          <div className="mt-2 space-y-2">
            {/* Mode selector */}
            <div className="grid grid-cols-3 gap-1">
              {(['mono', 'lr', 'midside'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setAutoMode(m)}
                  className={`text-[9px] uppercase tracking-wider py-1 rounded-sm border transition-colors ${
                    autoMode === m
                      ? 'border-primary text-primary bg-primary/10'
                      : 'border-border text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  {m === 'mono' ? 'Mono' : m === 'lr' ? 'L + R' : 'Mid/Side'}
                </button>
              ))}
            </div>

            {/* Numeric controls */}
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[9px] uppercase text-muted-foreground">Window</span>
                <input
                  type="number" min={2} max={200} step={1} value={windowMs}
                  onChange={(e) => setWindowMs(Math.max(2, Math.min(200, Number(e.target.value) || 20)))}
                  className="px-1.5 py-1 bg-background border border-border rounded-sm text-[10px] font-mono text-foreground focus:border-primary/50 focus:outline-none"
                />
                <span className="text-[8px] font-mono text-muted-foreground">ms</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[9px] uppercase text-muted-foreground">Percentile</span>
                <input
                  type="number" min={1} max={50} step={1} value={percentilePct}
                  onChange={(e) => setPercentilePct(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                  className="px-1.5 py-1 bg-background border border-border rounded-sm text-[10px] font-mono text-foreground focus:border-primary/50 focus:outline-none"
                />
                <span className="text-[8px] font-mono text-muted-foreground">%</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[9px] uppercase text-muted-foreground">Margin</span>
                <input
                  type="number" min={0} max={24} step={0.5} value={marginDb}
                  onChange={(e) => setMarginDb(Math.max(0, Math.min(24, Number(e.target.value) || 6)))}
                  className="px-1.5 py-1 bg-background border border-border rounded-sm text-[10px] font-mono text-foreground focus:border-primary/50 focus:outline-none"
                />
                <span className="text-[8px] font-mono text-muted-foreground">dB</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={handlePreviewThreshold}
                disabled={!state.audioBuffer}
                className="text-[10px] uppercase tracking-wider px-2 py-1.5 rounded-sm border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Preview
              </button>
              <button
                onClick={handleAutoThreshold}
                disabled={!state.audioBuffer}
                className="text-[10px] uppercase tracking-wider px-2 py-1.5 rounded-sm border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Analyze & Apply
              </button>
            </div>

            {previewThreshold !== null && (
              <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm border border-primary/30 bg-primary/5">
                <div className="flex flex-col text-[9px] font-mono">
                  <span className="text-muted-foreground uppercase text-[8px]">Current → Suggested</span>
                  <span className="text-foreground">
                    {processing.gateThreshold.toFixed(1)} dB
                    <span className="text-primary mx-1">→</span>
                    <span className="text-primary">{previewThreshold.toFixed(1)} dB</span>
                    <span className="text-muted-foreground ml-1">
                      ({(previewThreshold - processing.gateThreshold >= 0 ? '+' : '')}
                      {(previewThreshold - processing.gateThreshold).toFixed(1)})
                    </span>
                  </span>
                </div>
                <button
                  onClick={handleApplyPreview}
                  className="text-[9px] uppercase tracking-wider px-2 py-1 rounded-sm border border-primary text-primary hover:bg-primary/15 transition-colors"
                >
                  Apply
                </button>
              </div>
            )}

            {autoInfo && (
              <div className="text-[9px] font-mono text-muted-foreground text-center">{autoInfo}</div>
            )}

            {/* Per-channel breakdown */}
            {autoResult && autoResult.channels.length === 2 && (
              <div className="grid grid-cols-2 gap-1 text-[9px] font-mono">
                {autoMode === 'midside' && autoResult.midSide ? (
                  <>
                    <div className="bg-background rounded-sm p-1">
                      <div className="text-muted-foreground uppercase text-[8px]">Mid</div>
                      <div className="text-foreground">{autoResult.midSide.mid.noiseFloorDb.toFixed(1)} dB</div>
                      <div className="text-primary/80">→ {autoResult.midSide.mid.thresholdDb.toFixed(1)}</div>
                    </div>
                    <div className="bg-background rounded-sm p-1">
                      <div className="text-muted-foreground uppercase text-[8px]">Side</div>
                      <div className="text-foreground">{autoResult.midSide.side.noiseFloorDb.toFixed(1)} dB</div>
                      <div className="text-primary/80">→ {autoResult.midSide.side.thresholdDb.toFixed(1)}</div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="bg-background rounded-sm p-1">
                      <div className="text-muted-foreground uppercase text-[8px]">L</div>
                      <div className="text-foreground">{autoResult.channels[0].noiseFloorDb.toFixed(1)} dB</div>
                      <div className="text-primary/80">→ {autoResult.channels[0].thresholdDb.toFixed(1)}</div>
                    </div>
                    <div className="bg-background rounded-sm p-1">
                      <div className="text-muted-foreground uppercase text-[8px]">R</div>
                      <div className="text-foreground">{autoResult.channels[1].noiseFloorDb.toFixed(1)} dB</div>
                      <div className="text-primary/80">→ {autoResult.channels[1].thresholdDb.toFixed(1)}</div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Presets section */}
      <div className="mt-2 border-t border-border/50 pt-2">
        <button
          onClick={() => setPresetsOpen(o => !o)}
          className="w-full flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="flex items-center gap-1">
            {presetsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Presets
          </span>
          <span className="font-mono text-[9px] text-primary/70">{presets.length}</span>
        </button>

        {presetsOpen && (
          <div className="mt-2 space-y-2">
            <div className="flex gap-1">
              <input
                className="flex-1 px-2 py-1 bg-background border border-border rounded-sm text-[10px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
                placeholder="Preset name..."
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                onClick={handleSavePreset}
                className="flex items-center gap-1 px-2 py-1 rounded-sm border border-primary/40 text-primary hover:bg-primary/10 text-[10px] uppercase tracking-wider transition-colors"
                title="Save current settings"
              >
                <Save className="w-3 h-3" /> Save
              </button>
            </div>

            {presets.length === 0 ? (
              <p className="text-[9px] text-muted-foreground italic">No presets saved yet</p>
            ) : (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {presets.map(preset => (
                  <div key={preset.id} className="flex items-center gap-2 p-1.5 bg-background rounded-sm group">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-foreground truncate">{preset.name}</div>
                      <div className="text-[8px] font-mono text-muted-foreground truncate">
                        Thr {preset.threshold}dB · A {preset.attack}ms · R {preset.release}ms · {preset.autoMode}
                      </div>
                    </div>
                    <button
                      onClick={() => handleLoadPreset(preset)}
                      className="text-muted-foreground hover:text-primary transition-colors"
                      title="Load"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDeletePreset(preset.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <GainReductionMeter value={gr} />
    </ModulePanel>
  );
};

const ParametricEQModule = () => {
  const { processing, setProcessing } = useAudio();
  const bands = processing.eqBands;

  const labels = ['Low Shelf', 'Low Mid', 'Mid', 'Hi Mid', 'Hi Shelf'];

  const updateBand = (index: number, key: string, value: number) => {
    setProcessing(p => {
      const newBands = [...p.eqBands];
      newBands[index] = { ...newBands[index], [key]: value };
      return { ...p, eqBands: newBands };
    });
  };

  return (
    <ModulePanel
      title="Parametric EQ"
      enabled={processing.eqEnabled}
      onToggle={() => setProcessing(p => ({ ...p, eqEnabled: !p.eqEnabled }))}
    >
      {/* EQ Curve visualization */}
      <div className="w-full h-28 bg-background rounded-sm mb-3 relative overflow-hidden">
        <svg className="w-full h-full" viewBox="0 0 400 100" preserveAspectRatio="none">
          <line x1="0" y1="50" x2="400" y2="50" stroke="hsl(var(--border))" strokeWidth="0.5" />
          {[80, 160, 240, 320].map(x => (
            <line key={x} x1={x} y1="0" x2={x} y2="100" stroke="hsl(var(--muted))" strokeWidth="0.3" />
          ))}
          {/* Draw approximate EQ curve based on actual gains */}
          <path
            d={generateEQCurve(bands)}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="1.5"
          />
          <path
            d={`${generateEQCurve(bands)} L400,100 L0,100 Z`}
            fill="hsl(var(--primary))"
            fillOpacity="0.08"
          />
        </svg>
        <div className="absolute bottom-1 left-2 flex gap-4 text-[8px] font-mono text-muted-foreground">
          {bands.map((b, i) => (
            <span key={i} className={b.gain !== 0 ? 'text-primary' : ''}>{b.freq >= 1000 ? `${b.freq / 1000}K` : b.freq}</span>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        {bands.map((band, i) => (
          <div key={i} className="grid grid-cols-4 gap-2 items-end">
            <span className="text-[10px] text-muted-foreground uppercase truncate">{labels[i]}</span>
            <KnobControl label="Freq" value={band.freq} min={20} max={20000} unit="Hz" onChange={(v) => updateBand(i, 'freq', v)} />
            <KnobControl label="Gain" value={band.gain} min={-12} max={6} step={0.1} unit="dB" onChange={(v) => updateBand(i, 'gain', v)} />
            <KnobControl label="Q" value={band.q} min={0.1} max={10} step={0.1} onChange={(v) => updateBand(i, 'q', v)} />
          </div>
        ))}
      </div>
    </ModulePanel>
  );
};

function generateEQCurve(bands: { freq: number; gain: number; q: number }[]): string {
  const points: string[] = [];
  const w = 400;
  for (let x = 0; x <= w; x += 2) {
    const logFreq = 20 * Math.pow(1000, x / w); // 20Hz to 20kHz log scale
    let totalGain = 0;
    for (const band of bands) {
      const logDist = Math.log2(logFreq / band.freq);
      const response = band.gain * Math.exp(-logDist * logDist * band.q * 2);
      totalGain += response;
    }
    const y = 50 - totalGain * 3; // Scale gain to pixels
    points.push(`${x === 0 ? 'M' : 'L'}${x},${Math.max(5, Math.min(95, y))}`);
  }
  return points.join(' ');
}

const BAND_LABELS = ['Low', 'Mid', 'High'] as const;

const MultibandCompModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();
  const [gr, setGr] = useState<number[]>([0, 0, 0]);
  const rafRef = useRef(0);

  const active = state.isPlaying && processing.mbEnabled;
  useEffect(() => {
    if (!engine || !active) { setGr([0, 0, 0]); return; }
    const tick = () => {
      setGr(engine.getMultibandGR());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, active]);

  const setBand = (i: number, key: string, v: number) =>
    setProcessing((p) => ({
      ...p,
      mbBands: p.mbBands.map((b, j) => (j === i ? { ...b, [key]: v } : b)),
    }));

  return (
    <ModulePanel
      title="Multiband Comp"
      enabled={processing.mbEnabled}
      onToggle={() => setProcessing((p) => ({ ...p, mbEnabled: !p.mbEnabled }))}
    >
      <div className="grid grid-cols-2 gap-2 mb-3">
        <KnobControl
          label="XOver Lo/Mid" value={processing.mbXover1} min={40} max={600} unit="Hz"
          onChange={(v) => setProcessing((p) => ({ ...p, mbXover1: v }))}
        />
        <KnobControl
          label="XOver Mid/Hi" value={processing.mbXover2} min={800} max={9000} unit="Hz"
          onChange={(v) => setProcessing((p) => ({ ...p, mbXover2: v }))}
        />
      </div>
      {processing.mbBands.map((band, i) => (
        <div key={BAND_LABELS[i]} className="mb-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase text-muted-foreground tracking-wider">{BAND_LABELS[i]}</span>
            <span className="text-[8px] font-mono text-primary">{(gr[i] ?? 0).toFixed(1)} dB GR</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-1">
            <KnobControl label="Thresh" value={band.threshold} min={-48} max={0} step={0.5} unit="dB" onChange={(v) => setBand(i, 'threshold', v)} />
            <KnobControl label="Ratio" value={band.ratio} min={1} max={12} step={0.1} onChange={(v) => setBand(i, 'ratio', v)} />
            <KnobControl label="Makeup" value={band.makeup} min={-6} max={12} step={0.1} unit="dB" onChange={(v) => setBand(i, 'makeup', v)} />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-1">
            <KnobControl label="Attack" value={band.attack} min={1} max={100} step={1} unit="ms" onChange={(v) => setBand(i, 'attack', v)} />
            <KnobControl label="Release" value={band.release} min={20} max={800} step={5} unit="ms" onChange={(v) => setBand(i, 'release', v)} />
          </div>
          <GainReductionMeter value={gr[i] ?? 0} />
        </div>
      ))}
    </ModulePanel>
  );
};

const UtilityModule = () => {
  const { processing, setProcessing } = useAudio();
  const set = (patch: Partial<typeof processing>) => setProcessing((p) => ({ ...p, ...patch }));
  const pill = (on: boolean) =>
    `text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground hover:text-foreground'}`;

  return (
    <ModulePanel title="Utility">
      <div className="space-y-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button onClick={() => set({ lowCutEnabled: !processing.lowCutEnabled })} className={pill(processing.lowCutEnabled)}>
              Low-Cut {processing.lowCutEnabled ? 'ON' : 'OFF'}
            </button>
            <span className="text-[8px] text-muted-foreground">subsonic rumble</span>
          </div>
          <KnobControl label="Freq" value={processing.lowCutFreq} min={12} max={200} step={1} unit="Hz"
            onChange={(v) => set({ lowCutFreq: v })} />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <button onClick={() => set({ tiltEnabled: !processing.tiltEnabled })} className={pill(processing.tiltEnabled)}>
              Tilt {processing.tiltEnabled ? 'ON' : 'OFF'}
            </button>
            <span className="text-[8px] text-muted-foreground">− dark · + bright</span>
          </div>
          <KnobControl label="Amount" value={processing.tiltAmount} min={-6} max={6} step={0.1} unit="dB"
            onChange={(v) => set({ tiltAmount: v })} />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <button onClick={() => set({ bassMonoEnabled: !processing.bassMonoEnabled })} className={pill(processing.bassMonoEnabled)}>
              Bass Mono {processing.bassMonoEnabled ? 'ON' : 'OFF'}
            </button>
            <span className="text-[8px] text-muted-foreground">vinyl / club</span>
          </div>
          <KnobControl label="Below" value={processing.bassMonoFreq} min={40} max={300} step={5} unit="Hz"
            onChange={(v) => set({ bassMonoFreq: v })} />
        </div>
      </div>
    </ModulePanel>
  );
};

const DeEsserModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();
  const [gr, setGr] = useState({ de: 0, dyn: 0 });
  const rafRef = useRef(0);
  const active = state.isPlaying && (processing.deEssEnabled || processing.dynEqEnabled);
  useEffect(() => {
    if (!engine || !active) { setGr({ de: 0, dyn: 0 }); return; }
    const tick = () => {
      setGr({ de: engine.getDeEsserGR(), dyn: engine.getDynEqGR() });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, active]);
  const set = (patch: Partial<typeof processing>) => setProcessing((p) => ({ ...p, ...patch }));

  return (
    <ModulePanel title="De-Ess / Dynamic EQ">
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <button
            onClick={() => set({ deEssEnabled: !processing.deEssEnabled })}
            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${processing.deEssEnabled ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}
          >
            De-esser {processing.deEssEnabled ? 'ON' : 'OFF'}
          </button>
          <span className="text-[8px] font-mono text-primary">{gr.de.toFixed(1)} dB</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <KnobControl label="Freq" value={processing.deEssFreq} min={3000} max={12000} step={100} unit="Hz" onChange={(v) => set({ deEssFreq: v })} />
          <KnobControl label="Thresh" value={processing.deEssThreshold} min={-50} max={-6} step={0.5} unit="dB" onChange={(v) => set({ deEssThreshold: v })} />
          <KnobControl label="Range" value={processing.deEssRange} min={1} max={15} step={0.5} unit="dB" onChange={(v) => set({ deEssRange: v })} />
        </div>
        <GainReductionMeter value={gr.de} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <button
            onClick={() => set({ dynEqEnabled: !processing.dynEqEnabled })}
            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${processing.dynEqEnabled ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}
          >
            Dyn EQ {processing.dynEqEnabled ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => set({ dynEqMode: processing.dynEqMode === 'cut' ? 'boost' : 'cut' })}
            className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground"
          >
            {processing.dynEqMode.toUpperCase()}
          </button>
          <span className="text-[8px] font-mono text-primary">{gr.dyn.toFixed(1)} dB</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <KnobControl label="Freq" value={processing.dynEqFreq} min={30} max={16000} step={10} unit="Hz" onChange={(v) => set({ dynEqFreq: v })} />
          <KnobControl label="Q" value={processing.dynEqQ} min={0.3} max={8} step={0.1} onChange={(v) => set({ dynEqQ: v })} />
          <KnobControl label="Thresh" value={processing.dynEqThreshold} min={-50} max={0} step={0.5} unit="dB" onChange={(v) => set({ dynEqThreshold: v })} />
          <KnobControl label="Range" value={processing.dynEqRange} min={1} max={12} step={0.5} unit="dB" onChange={(v) => set({ dynEqRange: v })} />
        </div>
      </div>
    </ModulePanel>
  );
};

const ResonanceModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();
  const [gr, setGr] = useState(0);
  const rafRef = useRef(0);
  const active = state.isPlaying && processing.resoEnabled;
  useEffect(() => {
    if (!engine || !active) { setGr(0); return; }
    const tick = () => {
      setGr(engine.getResonanceGR());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, active]);
  const set = (patch: Partial<typeof processing>) => setProcessing((p) => ({ ...p, ...patch }));

  return (
    <ModulePanel
      title="Resonance Suppressor"
      enabled={processing.resoEnabled}
      onToggle={() => set({ resoEnabled: !processing.resoEnabled })}
    >
      <p className="text-[9px] text-muted-foreground mb-2 leading-snug">
        Dynamically tames ringing peaks and harshness — finds bins that stick out
        above the spectral envelope and pulls only those down, per frame.
      </p>
      <div className="flex items-center justify-end mb-1">
        <span className="text-[8px] font-mono text-primary">{gr.toFixed(1)} dB</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <KnobControl label="Amount" value={processing.resoAmount} min={0} max={100} step={1} unit="%"
          onChange={(v) => set({ resoAmount: v })} />
        <KnobControl label="Strength" value={processing.resoStrength} min={0} max={1} step={0.05}
          onChange={(v) => set({ resoStrength: v })} />
        <KnobControl label="Depth" value={processing.resoDepth} min={3} max={24} step={0.5} unit="dB"
          onChange={(v) => set({ resoDepth: v })} />
        <KnobControl label="Thresh" value={processing.resoThreshold} min={1} max={18} step={0.5} unit="dB"
          onChange={(v) => set({ resoThreshold: v })} />
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <KnobControl label="Low" value={processing.resoLowHz} min={20} max={2000} step={10} unit="Hz"
          onChange={(v) => set({ resoLowHz: Math.min(v, processing.resoHighHz - 500) })} />
        <KnobControl label="High" value={processing.resoHighHz} min={2000} max={20000} step={100} unit="Hz"
          onChange={(v) => set({ resoHighHz: Math.max(v, processing.resoLowHz + 500) })} />
      </div>
      <GainReductionMeter value={gr} />
    </ModulePanel>
  );
};

const StereoCompModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();

  const compGR = useGainReduction(
    engine ? () => engine.getCompressorGR() : undefined,
    state.isPlaying && processing.compEnabled
  );

  const set = (patch: Partial<typeof processing>) => setProcessing((p) => ({ ...p, ...patch }));
  const pill = (on: boolean) =>
    `text-[9px] font-mono px-1.5 py-0.5 rounded transition-colors ${on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground hover:text-foreground'}`;

  return (
    <ModulePanel
      title="Compressor"
      enabled={processing.compEnabled}
      onToggle={() => set({ compEnabled: !processing.compEnabled })}
    >
      <div className="flex flex-wrap gap-1 mb-2">
        {(['stereo', 'ms', 'dual'] as const).map((m) => (
          <button key={m} onClick={() => set({ compMode: m })} className={pill(processing.compMode === m)}>
            {m === 'stereo' ? 'Linked' : m === 'ms' ? 'M/S' : 'Dual'}
          </button>
        ))}
        <span className="w-px bg-border mx-0.5" />
        {(['peak', 'rms'] as const).map((d) => (
          <button key={d} onClick={() => set({ compDetect: d })} className={pill(processing.compDetect === d)}>
            {d.toUpperCase()}
          </button>
        ))}
        <span className="w-px bg-border mx-0.5" />
        <button onClick={() => set({ compAutoRelease: !processing.compAutoRelease })} className={pill(processing.compAutoRelease)}>AUTO REL</button>
        <button onClick={() => set({ compAutoMakeup: !processing.compAutoMakeup })} className={pill(processing.compAutoMakeup)}>AUTO GAIN</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <KnobControl label="Threshold" value={processing.compThreshold} min={-48} max={0} step={0.5} unit="dB"
          onChange={(v) => set({ compThreshold: v })} />
        <KnobControl label="Ratio" value={processing.compRatio} min={1} max={20} step={0.1}
          onChange={(v) => set({ compRatio: v })} />
        <KnobControl label="Attack" value={processing.compAttack} min={0.1} max={100} step={0.1} unit="ms"
          onChange={(v) => set({ compAttack: v })} />
        <KnobControl label="Release" value={processing.compRelease} min={10} max={1000} unit="ms"
          onChange={(v) => set({ compRelease: v })} />
        <KnobControl label="Knee" value={processing.compKnee} min={0} max={20} unit="dB"
          onChange={(v) => set({ compKnee: v })} />
        <KnobControl label="Mix" value={processing.compMix} min={0} max={100} unit="%"
          onChange={(v) => set({ compMix: v })} />
        <KnobControl label="Makeup" value={processing.compMakeup} min={-6} max={18} step={0.1} unit="dB"
          onChange={(v) => set({ compMakeup: v })} />
      </div>
      <GainReductionMeter value={compGR} />
    </ModulePanel>
  );
};

const SaturationModule = () => {
  const { processing, setProcessing } = useAudio();

  return (
    <ModulePanel
      title="Saturation / Warmth"
      enabled={processing.saturationEnabled}
      onToggle={() => setProcessing(p => ({ ...p, saturationEnabled: !p.saturationEnabled }))}
    >
      <KnobControl
        label="Drive" value={processing.saturation}
        min={0} max={100} step={1} unit="%"
        onChange={(v) => setProcessing(p => ({ ...p, saturation: v }))}
      />
      <div className="mt-2 text-[8px] text-muted-foreground">
        Soft-clip waveshaper with 2× oversampling
      </div>
    </ModulePanel>
  );
};

const StereoWidthModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();

  // Real-time correlation calculation
  const [correlation, setCorrelation] = useState(1);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!engine || !state.isPlaying) return;
    const tick = () => {
      const { l, r } = engine.getGoniometerData();
      let sumLR = 0, sumL2 = 0, sumR2 = 0;
      const len = Math.min(l.length, 512);
      for (let i = 0; i < len; i++) {
        sumLR += l[i] * r[i];
        sumL2 += l[i] * l[i];
        sumR2 += r[i] * r[i];
      }
      const corr = sumLR / Math.sqrt((sumL2 * sumR2) || 1);
      setCorrelation(Math.round(corr * 100) / 100);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, state.isPlaying]);

  return (
    <ModulePanel
      title="Stereo Width"
      enabled={processing.widthEnabled}
      onToggle={() => setProcessing(p => ({ ...p, widthEnabled: !p.widthEnabled }))}
    >
      <KnobControl
        label="Width" value={processing.stereoWidth}
        min={0} max={200} unit="%"
        onChange={(v) => setProcessing(p => ({ ...p, stereoWidth: v }))}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[9px] uppercase text-muted-foreground">Phase</span>
        <div className="flex-1 h-2 bg-background rounded-sm relative overflow-hidden">
          <div className="absolute left-1/2 top-0 h-full w-0.5 bg-border" />
          <div
            className="absolute top-0 h-full w-1 rounded-sm transition-all duration-100"
            style={{
              left: `${50 + correlation * 50}%`,
              backgroundColor: correlation > 0 ? 'hsl(var(--meter-green))' : 'hsl(var(--meter-red))',
            }}
          />
        </div>
        <span className={`text-[9px] font-mono ${correlation > 0 ? 'text-meter-green' : 'text-meter-red'}`}>
          {correlation > 0 ? '+' : ''}{correlation.toFixed(2)}
        </span>
      </div>
    </ModulePanel>
  );
};

const LimiterModule = () => {
  const { processing, setProcessing, engine, state } = useAudio();

  const limGR = useGainReduction(
    engine ? () => engine.getLimiterGR() : undefined,
    state.isPlaying && processing.limiterEnabled
  );

  return (
    <ModulePanel
      title="Limiter"
      enabled={processing.limiterEnabled}
      onToggle={() => setProcessing(p => ({ ...p, limiterEnabled: !p.limiterEnabled }))}
    >
      <div className="grid grid-cols-2 gap-3">
        <KnobControl label="Ceiling" value={processing.limiterCeiling} min={-6} max={0} step={0.1} unit="dBFS"
          onChange={(v) => setProcessing(p => ({ ...p, limiterCeiling: v }))} />
        <KnobControl label="Release" value={processing.limiterRelease} min={10} max={500} unit="ms"
          onChange={(v) => setProcessing(p => ({ ...p, limiterRelease: v }))} />
      </div>
      <GainReductionMeter value={limGR} />
    </ModulePanel>
  );
};

export {
  InputGainModule,
  UtilityModule,
  NoiseGateModule,
  ParametricEQModule,
  DeEsserModule,
  ResonanceModule,
  MultibandCompModule,
  StereoCompModule,
  SaturationModule,
  StereoWidthModule,
  LimiterModule,
};
