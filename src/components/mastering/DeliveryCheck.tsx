import { useState } from 'react';
import { ShieldCheck, Loader2, RefreshCw } from 'lucide-react';
import { useAudio } from '@/contexts/AudioContext';
import { renderProcessed } from '@/lib/offlineRender';
import { measureTruePeak } from '@/lib/loudness';
import { analyseMono, codecTruePeaks, deliveryVerdict, CODEC_CEILING_DB, type CodecResult, type MonoReport, type Finding } from '@/lib/delivery';
import { toast } from 'sonner';

/** Codec-safe + mono-safe check of the current master (rendered offline, really encoded and decoded). */
const DeliveryCheck = () => {
  const { state, processing } = useAudio();
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<{ tp: number; codecs: CodecResult[]; mono: MonoReport; findings: Finding[] } | null>(null);

  const run = async () => {
    if (!state.audioBuffer) return;
    setBusy('Rendering master…');
    try {
      const master = await renderProcessed(state.audioBuffer, processing);
      const tp = measureTruePeak(master).truePeak;
      setBusy('Checking mono…');
      await new Promise((r) => setTimeout(r, 20));
      const mono = analyseMono(master);
      const codecs = await codecTruePeaks(master, (l) => setBusy(`Encoding ${l}…`));
      setRes({ tp, codecs, mono, findings: deliveryVerdict(tp, codecs, mono) });
    } catch (e) {
      console.error(e);
      toast.error('Delivery check failed');
    } finally {
      setBusy(null);
    }
  };

  if (!state.audioBuffer) return null;
  const tone = (l: Finding['level']) => (l === 'fail' ? 'text-destructive' : l === 'warn' ? 'text-warning' : 'text-meter-green');

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-section-header flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-primary" /> Delivery Check
        </span>
        <button
          onClick={run}
          disabled={!!busy}
          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : res ? <RefreshCw className="w-3 h-3" /> : null}
          {busy ?? (res ? 'Re-check' : 'Check delivery')}
        </button>
      </div>

      {!res && !busy && (
        <p className="text-[10px] text-muted-foreground">
          Encodes your master to AAC, Opus and MP3 the way streaming services do, decodes it again and measures the true peak
          after the transcode — plus how much of each band survives on mono speakers.
        </p>
      )}

      {res && (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <div className="flex justify-between text-[10px] font-mono py-0.5 border-b border-border/40">
              <span className="text-foreground">Master (WAV)</span>
              <span className={res.tp > CODEC_CEILING_DB + 0.05 ? 'text-warning' : 'text-primary'}>{res.tp.toFixed(1)} dBTP</span>
            </div>
            {res.codecs.map((c) => (
              <div key={c.id} className="flex justify-between text-[10px] font-mono py-0.5 border-b border-border/40 last:border-0" title={c.platforms}>
                <span className="text-foreground">{c.label}</span>
                {c.available && c.truePeak != null ? (
                  <span className={c.truePeak > 0 ? 'text-destructive' : c.truePeak > CODEC_CEILING_DB + 0.05 ? 'text-warning' : 'text-meter-green'}>
                    {c.truePeak.toFixed(1)} dBTP
                  </span>
                ) : (
                  <span className="text-muted-foreground" title={c.note}>n/a</span>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-4 gap-1 text-center">
            {res.mono.bands.map((b) => (
              <div key={b.name} className="inset-well py-1">
                <div className={`font-mono-display text-xs ${b.lossDb < -3 ? 'text-warning' : 'text-primary'}`}>{b.lossDb.toFixed(1)}</div>
                <div className="text-[8px] uppercase tracking-wider text-muted-foreground">{b.name} · mono dB</div>
              </div>
            ))}
          </div>
          <div className="text-[9px] font-mono text-muted-foreground">
            Correlation {res.mono.correlation.toFixed(2)} · worst {res.mono.worstCorrelation.toFixed(2)}
          </div>

          <ul className="space-y-1 pt-1 border-t border-border/50">
            {res.findings.map((f, i) => (
              <li key={i} className={`text-[10px] leading-snug flex gap-1.5 ${tone(f.level)}`}>
                <span className="shrink-0">{f.level === 'fail' ? '✕' : f.level === 'warn' ? '⚠' : '✓'}</span>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default DeliveryCheck;
