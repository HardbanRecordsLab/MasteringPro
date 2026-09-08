import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square, ArrowLeftRight, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAudio } from '@/contexts/AudioContext';
import { renderProcessed } from '@/lib/offlineRender';
import { analyzeAudio, type AudioMetrics } from '@/lib/audioAnalysis';
import { toast } from 'sonner';

type Side = 'A' | 'B';

const AIABCompare = () => {
  const { state, processing } = useAudio();
  const [isRendering, setIsRendering] = useState(false);
  const [dryMetrics, setDryMetrics] = useState<AudioMetrics | null>(null);
  const [wetMetrics, setWetMetrics] = useState<AudioMetrics | null>(null);
  const dryRef = useRef<AudioBuffer | null>(null);
  const wetRef = useRef<AudioBuffer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startCtxTimeRef = useRef(0);
  const startOffsetRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSide, setActiveSide] = useState<Side>('B');
  const [matchLoudness, setMatchLoudness] = useState(true);

  /** Gain that plays `side` at the loudness of the quieter of the two takes. */
  const matchGainFor = (side: Side): number => {
    if (!matchLoudness || !dryMetrics || !wetMetrics) return 1;
    const ref = Math.min(dryMetrics.lufs, wetMetrics.lufs);
    const sideLufs = side === 'A' ? dryMetrics.lufs : wetMetrics.lufs;
    return Math.pow(10, (ref - sideLufs) / 20); // ≤ 1 — only ever attenuates
  };

  useEffect(() => () => stopPlayback(), []);

  const ensureCtx = () => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  };

  const stopPlayback = () => {
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
    setIsPlaying(false);
  };

  const startAt = (side: Side, offset: number) => {
    const buf = side === 'A' ? dryRef.current : wetRef.current;
    if (!buf) return;
    const ctx = ensureCtx();
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = matchGainFor(side);
    src.connect(g);
    g.connect(ctx.destination);
    const safeOffset = Math.max(0, Math.min(offset, buf.duration - 0.001));
    src.start(0, safeOffset);
    startCtxTimeRef.current = ctx.currentTime;
    startOffsetRef.current = safeOffset;
    src.onended = () => {
      if (sourceRef.current === src) {
        sourceRef.current = null;
        setIsPlaying(false);
      }
    };
    sourceRef.current = src;
    setIsPlaying(true);
  };

  const togglePlay = () => {
    if (!dryRef.current || !wetRef.current) return;
    if (isPlaying) stopPlayback();
    else startAt(activeSide, 0);
  };

  const flipSide = () => {
    const next: Side = activeSide === 'A' ? 'B' : 'A';
    setActiveSide(next);
    if (isPlaying && ctxRef.current) {
      const elapsed = ctxRef.current.currentTime - startCtxTimeRef.current + startOffsetRef.current;
      startAt(next, elapsed);
    }
  };

  // Re-apply the match gain live when the toggle changes mid-playback.
  useEffect(() => {
    if (isPlaying && ctxRef.current) {
      const elapsed = ctxRef.current.currentTime - startCtxTimeRef.current + startOffsetRef.current;
      startAt(activeSide, elapsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchLoudness]);

  const renderBoth = async () => {
    if (!state.audioBuffer) return;
    stopPlayback();
    setIsRendering(true);
    try {
      const dry = state.audioBuffer;
      const wet = await renderProcessed(dry, processing);
      dryRef.current = dry;
      wetRef.current = wet;
      setDryMetrics(analyzeAudio(dry));
      setWetMetrics(analyzeAudio(wet));
      toast.success('A/B render complete');
    } catch (e) {
      toast.error('A/B render failed');
      console.error(e);
    } finally {
      setIsRendering(false);
    }
  };

  const delta = (a?: number, b?: number) => {
    if (a == null || b == null) return '';
    const d = b - a;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}`;
  };

  const hasRender = !!(dryMetrics && wetMetrics);

  return (
    <div className="space-y-2 p-2 bg-background rounded-sm border border-primary/20">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-primary flex items-center gap-1">
          <ArrowLeftRight className="w-3 h-3" /> A/B Preview
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 text-[9px] px-2"
          onClick={renderBoth}
          disabled={!state.audioBuffer || isRendering}
        >
          {isRendering ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Render A/B'}
        </Button>
      </div>

      {hasRender && (
        <>
          {/* Transport: single Play + A/B toggle */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 px-2 gap-1"
              onClick={togglePlay}
              title={isPlaying ? 'Stop' : 'Play'}
            >
              {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span className="text-[10px]">{isPlaying ? 'Stop' : 'Play'}</span>
            </Button>
            <button
              onClick={flipSide}
              className="flex-1 flex items-center justify-center gap-1 h-7 rounded-sm border border-primary/40 bg-card hover:bg-secondary transition-colors"
              title="Flip A/B (keeps playhead in sync)"
            >
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${activeSide === 'A' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>A</span>
              <ArrowLeftRight className="w-3 h-3 text-primary" />
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${activeSide === 'B' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>B</span>
            </button>
            <button
              onClick={() => setMatchLoudness(v => !v)}
              className={`flex items-center gap-1 h-7 px-2 rounded-sm border text-[9px] font-mono transition-colors ${
                matchLoudness ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border bg-card text-muted-foreground'
              }`}
              title="Play both takes at equal loudness so you judge the processing, not the level"
            >
              <Scale className="w-3 h-3" /> {matchLoudness ? 'MATCHED' : 'RAW'}
            </button>
          </div>
          {matchLoudness && dryMetrics && wetMetrics && (
            <div className="text-[8px] font-mono text-muted-foreground">
              Loudness-matched to {Math.min(dryMetrics.lufs, wetMetrics.lufs).toFixed(1)} LUFS ·
              B trimmed {(20 * Math.log10(matchGainFor('B'))).toFixed(1)} dB
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {(['A', 'B'] as const).map(side => {
              const m = side === 'A' ? dryMetrics! : wetMetrics!;
              const active = activeSide === side;
              return (
                <div
                  key={side}
                  className={`space-y-1 p-1.5 rounded-sm border transition-colors ${
                    active ? 'bg-primary/10 border-primary/40' : 'bg-card border-border'
                  }`}
                >
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                    {side === 'A' ? 'A · Dry' : 'B · Mastered'}
                  </div>
                  <div className="text-[9px] font-mono text-foreground space-y-0.5">
                    <div>LUFS <span className="text-primary">{m.lufs}</span></div>
                    <div>TP <span className="text-primary">{m.truePeak}</span> dB</div>
                    <div>DR <span className="text-primary">{m.dynamicRange}</span></div>
                    <div>LRA <span className="text-primary">{m.lra}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-[9px] font-mono text-muted-foreground border-t border-border/50 pt-1">
            Δ LUFS {delta(dryMetrics!.lufs, wetMetrics!.lufs)} · Δ TP {delta(dryMetrics!.truePeak, wetMetrics!.truePeak)} · Δ DR {delta(dryMetrics!.dynamicRange, wetMetrics!.dynamicRange)}
          </div>
        </>
      )}

      {!hasRender && !isRendering && (
        <p className="text-[9px] text-muted-foreground">
          Render an offline pass of the current chain to A/B against the dry source — Play once, then flip A/B without restarting.
        </p>
      )}
    </div>
  );
};

export default AIABCompare;
