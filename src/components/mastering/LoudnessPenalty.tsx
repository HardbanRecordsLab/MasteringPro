import { useState } from 'react';
import { Gauge, Loader2, RefreshCw, Lightbulb } from 'lucide-react';
import { useAudio } from '@/contexts/AudioContext';
import { renderProcessed } from '@/lib/offlineRender';
import { measureLoudness } from '@/lib/loudness';
import { toast } from 'sonner';

/** Streaming / delivery loudness normalisation targets. */
const TARGETS = [
  { name: 'Spotify', lufs: -14, tp: -1 },
  { name: 'Spotify Loud', lufs: -11, tp: -1 },
  { name: 'Apple Music', lufs: -16, tp: -1 },
  { name: 'YouTube', lufs: -14, tp: -1 },
  { name: 'Tidal', lufs: -14, tp: -1 },
  { name: 'Amazon Music', lufs: -14, tp: -2 },
  { name: 'Deezer', lufs: -15, tp: -1 },
  { name: 'Club / DJ', lufs: -8, tp: -0.3 },
];

interface Measured {
  lufs: number;
  tp: number;
  lra: number;
}

interface Advice {
  kind: 'warn' | 'tip' | 'ok';
  text: string;
}

/** Rule-based loudness advisor — plain-language next steps from the measured master. */
export function adviseLoudness(m: Measured, target: { name: string; lufs: number; tp: number }): Advice[] {
  const out: Advice[] = [];
  const over = m.lufs - target.lufs;

  if (m.tp > target.tp + 0.05) {
    out.push({
      kind: 'warn',
      text: `True peak ${m.tp.toFixed(1)} dBTP is above ${target.name}'s ${target.tp} dBTP ceiling. Lower the limiter ceiling to ${target.tp.toFixed(1)} (−1.5 if you also make a lossy/MP3 version).`,
    });
  }
  if (over > 1.5) {
    out.push({
      kind: 'tip',
      text: `${over.toFixed(1)} LU louder than ${target.name} — it will be turned down by that much on playback, so the extra limiting buys nothing there. Ease the limiter or input drive unless you also deliver an un-normalised (DJ/download) master.`,
    });
  } else if (over < -1.5) {
    out.push({
      kind: 'tip',
      text: `${(-over).toFixed(1)} LU quieter than ${target.name}. You have loudness headroom — push input drive or the limiter if the material stays clean.`,
    });
  }
  if (m.lra > 11) {
    out.push({
      kind: 'tip',
      text: `LRA ${m.lra.toFixed(1)} LU is wide for streaming — level will jump between sections/songs. A gentle 1.5:1 bus compressor or a slower multiband release evens it out.`,
    });
  } else if (m.lra < 3 && m.lufs > -10) {
    out.push({
      kind: 'warn',
      text: `LRA ${m.lra.toFixed(1)} LU at ${m.lufs.toFixed(1)} LUFS — heavily limited. Listen for pumping/distortion and consider backing off 1–2 dB for a more open master.`,
    });
  }
  if (out.length === 0) {
    out.push({ kind: 'ok', text: `Master sits within spec for ${target.name}. Nothing urgent.` });
  }
  return out;
}

const LoudnessPenalty = () => {
  const { state, processing } = useAudio();
  const [busy, setBusy] = useState(false);
  const [m, setM] = useState<Measured | null>(null);
  const [primary, setPrimary] = useState('Spotify');
  const primaryTarget = TARGETS.find((t) => t.name === primary) ?? TARGETS[0];

  const measure = async () => {
    if (!state.audioBuffer) return;
    setBusy(true);
    try {
      const rendered = await renderProcessed(state.audioBuffer, processing);
      const l = measureLoudness(rendered);
      setM({ lufs: l.integrated, tp: l.truePeak, lra: l.lra });
    } catch (e) {
      toast.error('Measurement failed');
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (!state.audioBuffer) return null;

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-section-header flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-primary" /> Loudness Penalty
        </span>
        <button
          onClick={measure}
          disabled={busy}
          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : m ? <RefreshCw className="w-3 h-3" /> : null}
          {busy ? 'Measuring…' : m ? 'Re-measure' : 'Measure master'}
        </button>
      </div>

      {!m && !busy && (
        <p className="text-[10px] text-muted-foreground">
          Renders your current chain offline and measures BS.1770-4 loudness, then
          shows how far each platform will turn the track down.
        </p>
      )}

      {m && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-2 text-center">
            {[
              ['Integrated', `${m.lufs.toFixed(1)}`, 'LUFS'],
              ['True Peak', `${m.tp.toFixed(1)}`, 'dBTP'],
              ['LRA', `${m.lra.toFixed(1)}`, 'LU'],
            ].map(([l, v, u]) => (
              <div key={l} className="inset-well py-1.5">
                <div className="font-mono-display text-sm text-primary">{v}</div>
                <div className="text-[8px] uppercase tracking-wider text-muted-foreground">{l} · {u}</div>
              </div>
            ))}
          </div>

          <div className="space-y-0.5">
            {TARGETS.map((t) => {
              const penalty = m.lufs - t.lufs; // + = louder than target → turned down
              const tpOver = m.tp > t.tp + 0.05;
              return (
                <div key={t.name} className="flex items-center justify-between text-[10px] font-mono py-0.5 border-b border-border/40 last:border-0">
                  <span className="text-foreground">{t.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t.lufs} LUFS</span>
                    {penalty > 0.3 ? (
                      <span className="text-warning">−{penalty.toFixed(1)} dB</span>
                    ) : penalty < -0.3 ? (
                      <span className="text-muted-foreground">{penalty.toFixed(1)} dB quiet</span>
                    ) : (
                      <span className="text-meter-green">on target</span>
                    )}
                    {tpOver && <span className="text-destructive" title={`True peak over ${t.tp} dBTP`}>TP!</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[8px] text-muted-foreground leading-snug">
            −X dB = the platform's normalisation will play your track that much
            quieter. Aim for the target of your main platform; louder only wins on
            un-normalised playback (DJ, download).
          </p>

          <div className="mt-3 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <Lightbulb className="w-3 h-3 text-primary" /> Advisor
              </span>
              <select
                value={primary}
                onChange={(e) => setPrimary(e.target.value)}
                className="bg-background border border-border rounded-sm text-[10px] px-1 py-0.5 text-foreground focus:outline-none focus:border-primary/50"
              >
                {TARGETS.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
            <ul className="space-y-1">
              {adviseLoudness(m, primaryTarget).map((a, i) => (
                <li
                  key={i}
                  className={`text-[10px] leading-snug flex gap-1.5 ${
                    a.kind === 'warn' ? 'text-warning' : a.kind === 'ok' ? 'text-meter-green' : 'text-foreground'
                  }`}
                >
                  <span className="shrink-0">{a.kind === 'warn' ? '⚠' : a.kind === 'ok' ? '✓' : '→'}</span>
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
};

export default LoudnessPenalty;
