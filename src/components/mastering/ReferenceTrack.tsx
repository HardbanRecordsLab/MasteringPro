import { useState, useRef } from 'react';
import { Upload, Crosshair, Loader2, X, Music2, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAudio } from '@/contexts/AudioContext';
import { analyzeAudio } from '@/lib/audioAnalysis';
import { matchToReference } from '@/lib/referenceMatch';
import { invokeAI } from '@/lib/aiApi';
import { toast } from 'sonner';

const ReferenceTrack = () => {
  const { state, loadReference, setProcessing, processing } = useAudio();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isMatching, setIsMatching] = useState(false);
  const [isSpectral, setIsSpectral] = useState(false);

  const handleSpectralMatch = () => {
    if (!state.audioBuffer || !state.referenceBuffer) return;
    setIsSpectral(true);
    try {
      const r = matchToReference(state.audioBuffer, state.referenceBuffer, processing.eqBands);
      setProcessing((p) => ({ ...p, eqEnabled: true, eqBands: r.eqBands }));
      toast.success(
        r.moves.length
          ? `Matched EQ: ${r.moves.join(', ')} · ref is ${r.lufsDelta > 0 ? '+' : ''}${r.lufsDelta} LU`
          : `Already close to the reference (${r.lufsDelta > 0 ? '+' : ''}${r.lufsDelta} LU)`,
      );
    } catch (e) {
      toast.error('Spectral match failed');
      console.error(e);
    } finally {
      setIsSpectral(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await loadReference(file);
      toast.success(`Reference loaded: ${file.name}`);
    } catch (err) {
      toast.error('Failed to load reference');
    }
  };

  const handleMatchReference = async () => {
    if (!state.audioBuffer || !state.referenceMetrics) return;

    setIsMatching(true);
    try {
      const currentMetrics = analyzeAudio(state.audioBuffer);

      const { data, error } = await invokeAI('ai-mastering', {
        metrics: currentMetrics,
        referenceMetrics: state.referenceMetrics,
        mode: 'reference-match',
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      if (data?.config) {
        // Apply AI-generated params to processing state
        setProcessing(prev => ({
          ...prev,
          inputGain: data.config.inputGain ?? prev.inputGain,
          eqBands: data.config.parametricEQ?.map((eq: { freq?: number; gain?: number; q?: number; type?: string }, i: number) => ({
            freq: eq.freq ?? prev.eqBands[i]?.freq ?? 1000,
            gain: eq.gain ?? 0,
            q: eq.q ?? 1,
            type: (eq.type === 'lowShelf' ? 'lowshelf' : eq.type === 'highShelf' ? 'highshelf' : 'peaking') as BiquadFilterType,
          })) ?? prev.eqBands,
          compThreshold: data.config.compressor?.threshold ?? prev.compThreshold,
          compRatio: data.config.compressor?.ratio ?? prev.compRatio,
          compAttack: data.config.compressor?.attack ?? prev.compAttack,
          compRelease: data.config.compressor?.release ?? prev.compRelease,
          compKnee: data.config.compressor?.knee ?? prev.compKnee,
          compMakeup: data.config.compressor?.makeupGain ?? prev.compMakeup,
          stereoWidth: data.config.stereoWidth ?? prev.stereoWidth,
          limiterCeiling: data.config.limiter?.ceiling ?? prev.limiterCeiling,
          limiterRelease: data.config.limiter?.release ?? prev.limiterRelease,
        }));

        toast.success(`Reference matched: "${data.config.presetName}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Reference matching failed: ${msg}`);
    } finally {
      setIsMatching(false);
    }
  };

  return (
    <div className="panel p-3 space-y-3">
      <span className="text-section-header">Reference Track</span>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFile}
      />

      {state.referenceName ? (
        <div className="flex items-center gap-2 p-2 bg-background rounded-sm border border-border">
          <Music2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="text-xs text-foreground truncate flex-1">{state.referenceName}</span>
          <button
            onClick={() => {/* could clear reference here */}}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="w-full gap-2"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-3.5 h-3.5" /> Upload Reference
        </Button>
      )}

      {state.referenceMetrics && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 p-1.5 bg-background rounded-sm text-[8px] font-mono text-muted-foreground">
            <div>LUFS: {state.referenceMetrics.lufs}</div>
            <div>Peak: {state.referenceMetrics.truePeak}dB</div>
            <div>DR: {state.referenceMetrics.dynamicRange}</div>
            <div>Width: {state.referenceMetrics.stereoWidth}%</div>
            <div>Genre: {state.referenceMetrics.estimatedGenre}</div>
            <div>Corr: {state.referenceMetrics.stereoCorrelation}</div>
          </div>

          <div className="grid grid-cols-1 gap-1.5">
            <Button
              className="w-full gap-2"
              onClick={handleSpectralMatch}
              disabled={!state.audioBuffer || !state.referenceBuffer || isSpectral}
            >
              {isSpectral ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Analysing…</>
              ) : (
                <><SlidersHorizontal className="w-4 h-4" /> Spectral Match (EQ curve)</>
              )}
            </Button>
            <Button
              variant="secondary"
              className="w-full gap-2"
              onClick={handleMatchReference}
              disabled={!state.audioBuffer || isMatching}
            >
              {isMatching ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Matching…</>
              ) : (
                <><Crosshair className="w-4 h-4" /> AI Match (full chain)</>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default ReferenceTrack;
