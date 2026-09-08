import { useState } from 'react';
import { Sparkles, Loader2, Download, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useAudio, type ProcessingParams } from '@/contexts/AudioContext';
import { analyzeAudio } from '@/lib/audioAnalysis';
import { invokeAI } from '@/lib/aiApi';
import { encodeWav, downloadBlob, renderMaster } from '@/lib/audioExport';
import { saveLastAISettings } from '@/lib/aiMasteringPresets';
import { toast } from 'sonner';

const PLATFORMS = [
  { id: 'spotify', label: 'Spotify', lufs: -14, peak: -1.0 },
  { id: 'apple', label: 'Apple Music', lufs: -16, peak: -1.0 },
  { id: 'youtube', label: 'YouTube', lufs: -14, peak: -1.0 },
  { id: 'club', label: 'Club/DJ', lufs: -8, peak: -0.3 },
];

interface Stage {
  id: string;
  label: string;
  from: number;
  to: number;
}

const STAGES: Stage[] = [
  { id: 'analyze', label: 'Analiza audio (LUFS, TP, DR, spektrum)…', from: 0, to: 20 },
  { id: 'ai',      label: 'AI dobiera łańcuch masteringu…',           from: 20, to: 45 },
  { id: 'render',  label: 'Offline render przez łańcuch DSP…',        from: 45, to: 85 },
  { id: 'encode',  label: 'Kodowanie WAV 24-bit…',                    from: 85, to: 97 },
  { id: 'download',label: 'Przygotowanie pliku do pobrania…',         from: 97, to: 100 },
];

const OneClickMaster = () => {
  const { state, processing, setProcessing } = useAudio();
  const [platform, setPlatform] = useState('spotify');
  const [busy, setBusy] = useState(false);
  const [stageId, setStageId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [completedFile, setCompletedFile] = useState<string | null>(null);

  const setStage = (id: Stage['id']) => {
    const s = STAGES.find(st => st.id === id)!;
    setStageId(id);
    setProgress(s.from);
  };

  const bumpTo = (id: Stage['id']) => {
    const s = STAGES.find(st => st.id === id)!;
    setProgress(s.to);
  };

  const applyAIConfig = (config: any): ProcessingParams => {
    const next: ProcessingParams = {
      ...processing,
      inputGain: config.inputGain ?? processing.inputGain,
      eqBands: config.parametricEQ?.map((eq: any, i: number) => ({
        freq: eq.freq ?? processing.eqBands[i]?.freq ?? 1000,
        gain: eq.gain ?? 0,
        q: eq.q ?? 1,
        type: (eq.type === 'lowShelf' ? 'lowshelf' : eq.type === 'highShelf' ? 'highshelf' : 'peaking') as BiquadFilterType,
      })) ?? processing.eqBands,
      compThreshold: config.compressor?.threshold ?? processing.compThreshold,
      compRatio: config.compressor?.ratio ?? processing.compRatio,
      compAttack: config.compressor?.attack ?? processing.compAttack,
      compRelease: config.compressor?.release ?? processing.compRelease,
      compKnee: config.compressor?.knee ?? processing.compKnee,
      compMakeup: config.compressor?.makeupGain ?? processing.compMakeup,
      stereoWidth: config.stereoWidth ?? processing.stereoWidth,
      limiterCeiling: config.limiter?.ceiling ?? processing.limiterCeiling,
      limiterRelease: config.limiter?.release ?? processing.limiterRelease,
      saturation: typeof config.saturation === 'number' ? config.saturation : processing.saturation,
      saturationEnabled: typeof config.saturation === 'number' && config.saturation > 0,
      eqEnabled: true,
      compEnabled: true,
      limiterEnabled: true,
      widthEnabled: true,
    };
    setProcessing(next);
    return next;
  };

  const handleOneClick = async () => {
    if (!state.audioBuffer || !state.fileInfo) return;
    setBusy(true);
    setDone(false);
    setCompletedFile(null);
    setProgress(0);
    try {
      const plat = PLATFORMS.find(p => p.id === platform)!;

      setStage('analyze');
      await new Promise(r => setTimeout(r, 30));
      const metrics = analyzeAudio(state.audioBuffer);
      bumpTo('analyze');

      setStage('ai');
      const { data, error } = await invokeAI('ai-mastering', {
        metrics, platform: plat.id, style: 'transparent', intensity: 'standard', validate: true,
      });
      if (error) throw new Error(error.message || 'AI failed');
      if (data?.error) throw new Error(data.error);
      if (!data?.config) throw new Error('No AI config returned');
      bumpTo('ai');

      const nextProcessing = applyAIConfig(data.config);
      saveLastAISettings({
        platform: plat.id, style: 'transparent', intensity: 'standard',
        aiConfig: data.config, validation: data.validation || null,
        processing: nextProcessing,
      });

      setStage('render');
      // Simulated intermediate progress during offline render
      const renderStart = 45;
      const renderEnd = 85;
      const durMs = Math.max(400, state.audioBuffer.duration * 40);
      const startedAt = performance.now();
      const tick = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        const pct = Math.min(1, elapsed / durMs);
        setProgress(renderStart + (renderEnd - renderStart) * pct * 0.95);
      }, 100);
      let rendered: AudioBuffer;
      let report;
      try {
        const res = await renderMaster(state.audioBuffer, {
          processing: nextProcessing,
          targetPeakDb: plat.peak,
          targetLufs: plat.lufs,
        });
        rendered = res.buffer;
        report = res.report;
      } finally {
        clearInterval(tick);
      }
      bumpTo('render');

      setStage('encode');
      await new Promise(r => setTimeout(r, 30));
      const wav = encodeWav(rendered, 24);
      bumpTo('encode');

      setStage('download');
      const baseName = state.fileInfo.name.replace(/\.[^.]+$/, '');
      const outName = `${baseName}_master_${plat.id}.wav`;
      downloadBlob(new Blob([wav], { type: 'audio/wav' }), outName);
      bumpTo('download');

      setDone(true);
      setCompletedFile(outName);
      toast.success(
        `Master ready: ${plat.label} — ${report.integratedLufs.toFixed(1)} LUFS / ${report.truePeakDb.toFixed(1)} dBTP` +
          (report.onTarget ? '' : ' (limiter maxed)'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`One-Click Master failed: ${msg}`);
    } finally {
      setBusy(false);
      setStageId(null);
    }
  };

  const currentStage = stageId ? STAGES.find(s => s.id === stageId) : null;

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-section-header">One-Click Master</span>
      </div>

      <p className="text-[11px] text-muted-foreground">
        AI analizuje utwór, tworzy master i pobiera plik WAV — wszystko w jednym kliknięciu.
      </p>

      <div className="space-y-1">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Target Platform</span>
        <div className="grid grid-cols-2 gap-1">
          {PLATFORMS.map(p => (
            <button
              key={p.id}
              onClick={() => setPlatform(p.id)}
              disabled={busy}
              className={`text-[10px] px-2 py-1.5 rounded transition-colors text-left ${
                platform === p.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="font-medium">{p.label}</div>
              <div className="opacity-70 text-[9px] font-mono">{p.lufs} LUFS</div>
            </button>
          ))}
        </div>
      </div>

      <Button
        className={`w-full h-12 gap-2 text-sm ${busy ? 'animate-pulse-glow' : ''}`}
        onClick={handleOneClick}
        disabled={!state.audioBuffer || busy}
      >
        {busy ? (
          <><Loader2 className="w-5 h-5 animate-spin" /> Mastering…</>
        ) : (
          <><Sparkles className="w-5 h-5" /> Master & Download</>
        )}
      </Button>

      {(busy || done) && (
        <div className="space-y-2 pt-1">
          <Progress value={progress} className="h-1.5" />
          <div className="flex items-center justify-between text-[10px] font-mono">
            <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
              {busy ? (
                <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-meter-green shrink-0" />
              )}
              <span className="truncate">
                {busy
                  ? (currentStage?.label ?? 'Starting…')
                  : `Gotowe — pobrano ${completedFile}`}
              </span>
            </div>
            <span className="text-primary shrink-0 ml-2">{Math.round(progress)}%</span>
          </div>

          {/* Stage timeline */}
          <div className="grid grid-cols-5 gap-0.5">
            {STAGES.map(s => {
              const isDone = progress >= s.to || done;
              const isActive = stageId === s.id && !done;
              return (
                <div
                  key={s.id}
                  className={`h-0.5 rounded-full ${
                    isDone
                      ? 'bg-meter-green'
                      : isActive
                      ? 'bg-primary animate-pulse'
                      : 'bg-border'
                  }`}
                  title={s.label}
                />
              );
            })}
          </div>
        </div>
      )}

      {!busy && !done && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Download className="w-3 h-3" />
          <span>Analyze → AI Master → WAV 24-bit — auto-download</span>
        </div>
      )}
    </div>
  );
};

export default OneClickMaster;
