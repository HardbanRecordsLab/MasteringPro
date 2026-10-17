import { useEffect, useMemo, useState } from 'react';
import { Loader2, Crosshair, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { useAudio } from '@/contexts/AudioContext';
import { profileAudio } from '@/lib/profileClient';
import { computeMatch, tuneMultiband, type MatchResult } from '@/lib/dsp/match';
import type { TrackProfile } from '@/lib/dsp/profile';
import { BAND_NAMES } from '@/lib/multiband';

const W = 248, H = 64, F_LO = 25, F_HI = 18000, DB = 9;
const xOf = (hz: number) => (Math.log(hz / F_LO) / Math.log(F_HI / F_LO)) * W;
const yOf = (db: number) => H / 2 - (db / DB) * (H / 2 - 4);

/** the correction curve, drawn */
const CurvePlot = ({ f, g }: { f: number[]; g: number[] }) => {
  const d = useMemo(() => f.map((hz, i) => `${i ? 'L' : 'M'}${xOf(hz).toFixed(1)},${yOf(g[i]).toFixed(1)}`).join(' '), [f, g]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16 bg-background rounded-sm border border-border" role="img" aria-label="Matching EQ curve">
      {[-6, -3, 3, 6].map((v) => <line key={v} x1={0} x2={W} y1={yOf(v)} y2={yOf(v)} stroke="currentColor" className="text-border" strokeWidth={0.4} />)}
      <line x1={0} x2={W} y1={yOf(0)} y2={yOf(0)} stroke="currentColor" className="text-muted-foreground" strokeWidth={0.6} />
      {[100, 1000, 10000].map((hz) => <line key={hz} x1={xOf(hz)} x2={xOf(hz)} y1={0} y2={H} stroke="currentColor" className="text-border" strokeWidth={0.4} />)}
      <path d={d} fill="none" stroke="currentColor" className="text-primary" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
};

const MatchPanel = () => {
  const { state, processing, setProcessing } = useAudio();
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState<TrackProfile | null>(null);
  const [ref, setRef] = useState<TrackProfile | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [strength, setStrength] = useState(80);
  const [useEq, setUseEq] = useState(true);
  const [useStereo, setUseStereo] = useState(true);
  const [useDyn, setUseDyn] = useState(true);

  // a new file or a new reference invalidates the analysis
  useEffect(() => { setResult(null); setTrack(null); setRef(null); }, [state.audioBuffer, state.referenceBuffer]);

  if (!state.audioBuffer || !state.referenceBuffer) return null;

  const analyse = async () => {
    setBusy(true);
    try {
      const [t, r] = await Promise.all([profileAudio(state.audioBuffer!), profileAudio(state.referenceBuffer!)]);
      setTrack(t); setRef(r);
      setResult(computeMatch(t, r));
    } catch (e) {
      toast.error('Analysis failed');
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!result || !track || !ref) return;
    const s = strength / 100;
    setProcessing((p) => {
      const next = { ...p };
      if (useEq) { next.matchEnabled = true; next.matchCurve = result.curve; next.matchAmount = strength; }
      if (useStereo && result.stereo) {
        next.msEnabled = true;
        next.msSideLow = Math.round(result.stereo.sideLow * s * 2) / 2;
        next.msSideMid = Math.round(result.stereo.sideMid * s * 2) / 2;
        next.msSideHigh = Math.round(result.stereo.sideHigh * s * 2) / 2;
        if (result.stereo.bassMonoHint) { next.bassMonoEnabled = true; }
      }
      if (useDyn) {
        next.mbEnabled = true;
        next.mbBands = tuneMultiband(track, ref.dynRange, s);
        next.mbXovers = track.edges;
      }
      return next;
    });
    toast.success('Match applied — every part is editable in its own module');
  };

  const matched = !!processing.matchEnabled && !!processing.matchCurve;
  const names = BAND_NAMES[5];

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Match 2.0 · spectrum + width + dynamics</span>

      {!result && (
        <Button className="w-full gap-2" onClick={analyse} disabled={busy}>
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Analysing both tracks…</> : <><Crosshair className="w-4 h-4" /> Analyse &amp; match</>}
        </Button>
      )}

      {result && (
        <>
          <CurvePlot f={result.curve.f} g={result.curve.g} />
          <div className="p-1.5 bg-background rounded-sm text-[9px] font-mono text-muted-foreground space-y-0.5">
            <div>Tone: {result.rmsBeforeDb.toFixed(1)} → {result.rmsAfterDb.toFixed(1)} dB rms off the reference</div>
            <div>Level: reference is {result.loudnessDeltaLu > 0 ? '+' : ''}{result.loudnessDeltaLu} LU (not changed)</div>
            {result.stereo && <div>Width (side): L {result.stereo.sideLow > 0 ? '+' : ''}{result.stereo.sideLow} · M {result.stereo.sideMid > 0 ? '+' : ''}{result.stereo.sideMid} · H {result.stereo.sideHigh > 0 ? '+' : ''}{result.stereo.sideHigh} dB{result.stereo.bassMonoHint ? ' · mono bass' : ''}</div>}
            <div>Range (dB, you → ref): {names.map((n, i) => `${n[0]}${n.includes('-') ? '·' + n.split('-')[1][0] : ''} ${result.dynRangeTrack[i]}→${result.dynRangeRef[i]}`).join(' | ')}</div>
            {result.notes.map((n) => <div key={n}>{n}</div>)}
          </div>

          <div className="space-y-1.5">
            {[
              { label: 'EQ curve (min-phase FIR)', on: useEq, set: setUseEq, ok: true },
              { label: 'Stereo width (side EQ)', on: useStereo, set: setUseStereo, ok: !!result.stereo },
              { label: 'Dynamics (multiband)', on: useDyn, set: setUseDyn, ok: true },
            ].map((r) => (
              <div key={r.label} className="flex items-center justify-between">
                <span className={`text-xs ${r.ok ? 'text-foreground' : 'text-muted-foreground'}`}>{r.label}</span>
                <Switch checked={r.on && r.ok} onCheckedChange={r.set} disabled={!r.ok} aria-label={r.label} />
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
              <span>Strength</span><span className="text-primary font-mono">{strength} %</span>
            </div>
            <Slider value={[strength]} min={10} max={100} step={5} onValueChange={(v) => setStrength(v[0])} />
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => setResult(null)}>Re-analyse</Button>
            <Button size="sm" onClick={apply} disabled={!(useEq || (useStereo && result.stereo) || useDyn)}>Apply match</Button>
          </div>
        </>
      )}

      {matched && (
        <Button variant="secondary" size="sm" className="w-full gap-2"
          onClick={() => setProcessing((p) => ({ ...p, matchEnabled: false }))}>
          <Undo2 className="w-3.5 h-3.5" /> Remove EQ match
        </Button>
      )}
    </div>
  );
};

export default MatchPanel;
