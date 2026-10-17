import { useState } from 'react';
import { Wand2, Loader2, Undo2, Activity, Zap, AudioWaveform, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { useAudio } from '@/contexts/AudioContext';
import { diagnoseAudio, restoreAudio, type Diagnosis, type RestoreReport } from '@/lib/restoration';

const STAGE_LABEL: Record<string, string> = {
  hum: 'Removing hum…',
  declip: 'Reconstructing clipped peaks…',
  declick: 'Removing clicks…',
  denoise: 'Reducing noise…',
};

interface Toggles { hum: boolean; clip: boolean; clicks: boolean; noise: boolean }

const Row = ({
  icon, title, detail, found, checked, onChange,
}: { icon: React.ReactNode; title: string; detail: string; found: boolean; checked: boolean; onChange: (v: boolean) => void }) => (
  <div className={`flex items-center gap-2 p-2 rounded-sm border ${found ? 'border-primary/30 bg-primary/5' : 'border-border bg-background'}`}>
    <span className={found ? 'text-primary' : 'text-muted-foreground'}>{icon}</span>
    <div className="flex-1 min-w-0">
      <div className="text-xs text-foreground">{title}</div>
      <div className="text-[10px] text-muted-foreground font-mono truncate">{detail}</div>
    </div>
    <Switch checked={checked} onCheckedChange={onChange} aria-label={`Apply ${title}`} />
  </div>
);

const RestorationPanel = () => {
  const { state, replaceAudioBuffer, revertAudioBuffer } = useAudio();
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState<'analyse' | 'restore' | null>(null);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [on, setOn] = useState<Toggles>({ hum: false, clip: false, clicks: false, noise: false });
  const [clickSens, setClickSens] = useState(5);
  const [noiseDb, setNoiseDb] = useState(12);

  if (!state.audioBuffer) return null;

  const analyse = async () => {
    setBusy('analyse');
    setReport(null);
    try {
      const d = await diagnoseAudio(state.audioBuffer!);
      setDiag(d);
      setOn({
        hum: !!d.hum,
        clip: !!d.clipping,
        clicks: d.clicks > 0,
        noise: !!d.noise && d.noise.confidence > 0.2 && d.noise.floorDb > -75,
      });
      const problems = [d.hum && 'hum', d.clipping && 'clipping', d.clicks > 0 && 'clicks', d.noise && d.noise.floorDb > -75 && 'noise'].filter(Boolean);
      toast[problems.length ? 'info' : 'success'](problems.length ? `Found: ${problems.join(', ')}` : 'No restoration issues found — the file is clean');
    } catch (e) {
      toast.error('Analysis failed');
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    setProgress(0);
    try {
      const { buffer, report: rep } = await restoreAudio(
        state.audioBuffer!,
        {
          dehum: { enabled: on.hum, lines: diag?.hum?.lines },
          declip: { enabled: on.clip },
          declick: { enabled: on.clicks, sensitivity: clickSens },
          denoise: { enabled: on.noise, reductionDb: noiseDb },
        },
        (st, f) => { setStage(STAGE_LABEL[st] ?? 'Restoring…'); setProgress(Math.round(f * 100)); },
      );
      replaceAudioBuffer(buffer, 'Restored');
      setReport(rep);
      setDiag(null);
      toast.success('Restoration applied — original is kept, you can revert any time');
    } catch (e) {
      toast.error('Restoration failed');
      console.error(e);
    } finally {
      setBusy(null);
      setStage('');
    }
  };

  const anyOn = on.hum || on.clip || on.clicks || on.noise;

  return (
    <div className="panel p-3 space-y-3" data-tour="restoration">
      <div className="flex items-center justify-between">
        <span className="text-section-header">Restoration</span>
        {state.workingLabel && (
          <span className="text-[9px] uppercase tracking-[0.16em] text-primary">{state.workingLabel} copy</span>
        )}
      </div>

      {state.originalBuffer && (
        <Button variant="secondary" size="sm" className="w-full gap-2" onClick={() => { revertAudioBuffer(); setReport(null); }}>
          <Undo2 className="w-3.5 h-3.5" /> Revert to original
        </Button>
      )}

      {report && (
        <div className="p-2 bg-background rounded-sm border border-border text-[10px] font-mono text-muted-foreground space-y-0.5">
          {report.hum && <div>Hum: {report.hum.lines.length} line(s) notched ({report.hum.lines.slice(0, 4).join(', ')} Hz…)</div>}
          {report.clip && <div>Clipping: {report.clip.runs} peaks rebuilt (ceiling {report.clip.ceilingDb.toFixed(1)} → up to {report.clip.rebuiltToDb.toFixed(1)} dB before trim)</div>}
          {report.clicks && <div>Clicks: {report.clicks.bursts} repaired ({report.clicks.samples} samples)</div>}
          {report.noise && <div>Noise floor: {report.noise.floorBeforeDb.toFixed(1)} → {report.noise.floorAfterDb.toFixed(1)} dBFS (−{report.noise.reducedDb.toFixed(1)} dB)</div>}
          {report.gainDb < -0.05 && <div>Level trim: {report.gainDb.toFixed(1)} dB (headroom after declip)</div>}
        </div>
      )}

      {!diag && (
        <Button className="w-full gap-2" onClick={analyse} disabled={busy !== null}>
          {busy === 'analyse'
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Analysing…</>
            : <><Activity className="w-4 h-4" /> Analyse file</>}
        </Button>
      )}

      {diag && (
        <>
          <div className="space-y-1.5">
            <Row
              icon={<AudioWaveform className="w-3.5 h-3.5" />} title="Mains hum"
              detail={diag.hum ? `${diag.hum.fundamental} Hz + ${diag.hum.lines.length - 1} harmonics · +${diag.hum.prominenceDb.toFixed(0)} dB` : 'not detected'}
              found={!!diag.hum} checked={on.hum} onChange={(v) => setOn((s) => ({ ...s, hum: v }))}
            />
            <Row
              icon={<Zap className="w-3.5 h-3.5" />} title="Clipping"
              detail={diag.clipping ? `${diag.clipping.runs} flat peaks · ${(diag.clipping.fraction * 100).toFixed(2)} % of samples` : 'not detected'}
              found={!!diag.clipping} checked={on.clip} onChange={(v) => setOn((s) => ({ ...s, clip: v }))}
            />
            <Row
              icon={<Zap className="w-3.5 h-3.5" />} title="Clicks & crackle"
              detail={diag.clicks > 0 ? `~${diag.clicks} found` : 'not detected'}
              found={diag.clicks > 0} checked={on.clicks} onChange={(v) => setOn((s) => ({ ...s, clicks: v }))}
            />
            <Row
              icon={<VolumeX className="w-3.5 h-3.5" />} title="Background noise"
              detail={diag.noise ? `${diag.noise.floorDb.toFixed(1)} dBFS floor${diag.noise.confidence < 0.2 ? ' · uncertain' : ''}` : 'no quiet passage to learn from'}
              found={!!diag.noise && diag.noise.floorDb > -75} checked={on.noise} onChange={(v) => setOn((s) => ({ ...s, noise: v }))}
            />
          </div>

          {on.clicks && (
            <div className="space-y-1">
              <div className="flex justify-between text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>Click sensitivity</span><span className="text-primary font-mono">{clickSens}</span>
              </div>
              <Slider value={[clickSens]} min={1} max={10} step={1} onValueChange={(v) => setClickSens(v[0])} />
            </div>
          )}
          {on.noise && (
            <div className="space-y-1">
              <div className="flex justify-between text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>Noise reduction</span><span className="text-primary font-mono">{noiseDb} dB</span>
              </div>
              <Slider value={[noiseDb]} min={3} max={24} step={1} onValueChange={(v) => setNoiseDb(v[0])} />
            </div>
          )}

          {busy === 'restore' && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">{stage}</div>
              <Progress value={progress} className="h-1.5" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => setDiag(null)} disabled={busy !== null}>Re-analyse</Button>
            <Button size="sm" className="gap-2" onClick={restore} disabled={!anyOn || busy !== null}>
              {busy === 'restore'
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working…</>
                : <><Wand2 className="w-3.5 h-3.5" /> Restore</>}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default RestorationPanel;
