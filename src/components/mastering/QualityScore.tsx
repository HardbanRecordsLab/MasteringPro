import { useMemo } from 'react';
import { useAudio } from '@/contexts/AudioContext';
import { analyzeAudio } from '@/lib/audioAnalysis';
import AIExplain from './AIExplain';

interface ScoreRow {
  label: string;
  value: number;
  explain: string;
}

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

const QualityScore = () => {
  const { state } = useAudio();

  const { overall, rows, m } = useMemo(() => {
    if (!state.audioBuffer) return { overall: 0, rows: [] as ScoreRow[], m: null as ReturnType<typeof analyzeAudio> | null };
    const m = analyzeAudio(state.audioBuffer);

    // Dynamics: DR 6→50, DR 14+→100
    const dynamics = clamp(((m.dynamicRange - 6) / 8) * 50 + 50);
    // Stereo: from correlation and width (penalize <0.2 correlation, reward width near 80-120)
    const widthScore = 100 - Math.min(100, Math.abs(m.stereoWidth - 100));
    const corrScore = clamp(m.stereoCorrelation * 100);
    const stereo = clamp((widthScore + corrScore) / 2);
    // Bass: penalize mud, reward good mono compat & sub/bass balance
    const bassBalance = clamp(100 - Math.abs((m.frequencyBalance.sub + m.frequencyBalance.bass) - 35) * 2);
    const bass = clamp((bassBalance + clamp(m.lowEndMonoCompat * 100) + (100 - m.mudIndex)) / 3);
    // Loudness: distance from -14 LUFS, gentle penalty
    const loudness = clamp(100 - Math.abs(m.lufs + 14) * 4);
    // Streaming Ready: TP below -1 & LUFS near -14
    const tpOk = m.truePeak <= -1 ? 100 : Math.max(0, 100 - (m.truePeak + 1) * 40);
    const streaming = clamp((loudness + tpOk) / 2);
    // Podcast Ready: LUFS near -16, low noise floor
    const podcast = clamp(100 - Math.abs(m.lufs + 16) * 6);
    // Club Ready: LUFS -8..-10, high punch
    const club = clamp(100 - Math.abs(m.lufs + 9) * 5 * 0.5 + m.punchScore * 0.3);
    // Clarity: penalize harshness
    const clarity = clamp(100 - m.harshnessIndex);

    const rows: ScoreRow[] = [
      { label: 'Dynamics',       value: dynamics, explain: `DR ${m.dynamicRange.toFixed(1)}dB, LRA ${m.lra.toFixed(1)}. Higher = more life & punch preserved.` },
      { label: 'Stereo',         value: stereo,   explain: `Width ${m.stereoWidth}%, correlation ${m.stereoCorrelation.toFixed(2)}. Should feel wide but mono-safe.` },
      { label: 'Bass',           value: bass,     explain: `Sub+Bass energy ${(m.frequencyBalance.sub + m.frequencyBalance.bass).toFixed(1)}%, mono compat ${(m.lowEndMonoCompat*100).toFixed(0)}%.` },
      { label: 'Loudness',       value: loudness, explain: `${m.lufs.toFixed(1)} LUFS vs -14 target. Closer to target = better score.` },
      { label: 'Clarity',        value: clarity,  explain: `Harshness index ${m.harshnessIndex}/100 in 2-5kHz. Lower harsh = more clarity.` },
      { label: 'Streaming Ready',value: streaming,explain: `LUFS ${m.lufs.toFixed(1)}, TP ${m.truePeak.toFixed(2)}dB. Ready for Spotify/YouTube if 90+.` },
      { label: 'Podcast Ready',  value: podcast,  explain: `-16 LUFS target for speech platforms.` },
      { label: 'Club Ready',     value: club,     explain: `Loudness -8 to -10 LUFS with high punch score.` },
    ];

    const overall = clamp((dynamics + stereo + bass + loudness + clarity + streaming) / 6);
    return { overall, rows, m };
  }, [state.audioBuffer]);

  if (!state.audioBuffer) return null;

  const scoreColor = (v: number) =>
    v >= 85 ? 'text-meter-green' : v >= 65 ? 'text-primary' : v >= 40 ? 'text-warning' : 'text-destructive';

  return (
    <div className="panel p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-section-header">Master Quality Score</span>
          <AIExplain text="A weighted assessment of your master across dynamics, tonal balance, stereo image, loudness targets and platform readiness." />
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex items-center justify-center w-20 h-20">
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="34" fill="none" stroke="hsl(var(--border))" strokeWidth="6" />
            <circle
              cx="40" cy="40" r="34" fill="none"
              stroke="currentColor" strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${(overall / 100) * 213.6} 213.6`}
              className={scoreColor(overall)}
            />
          </svg>
          <div className="text-center">
            <div className={`text-2xl font-bold ${scoreColor(overall)}`}>{overall}</div>
            <div className="text-[8px] uppercase text-muted-foreground -mt-1">/100</div>
          </div>
        </div>
        <div className="flex-1 text-[10px] text-muted-foreground leading-relaxed">
          {overall >= 85 ? 'Excellent master — release-ready across platforms.' :
           overall >= 65 ? 'Good master — a few tweaks would push it to release quality.' :
           overall >= 40 ? 'Needs work — try AI Auto-Master or AI Fix suggestions.' :
                          'Raw source — run AI Analyze & Master to get a starting chain.'}
        </div>
      </div>

      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.label} className="space-y-0.5">
            <div className="flex items-center justify-between text-[10px]">
              <div className="flex items-center gap-1 text-muted-foreground">
                {r.label}
                <AIExplain text={r.explain} />
              </div>
              <span className={`font-mono ${scoreColor(r.value)}`}>{r.value}</span>
            </div>
            <div className="h-1 bg-background rounded overflow-hidden">
              <div
                className={`h-full ${r.value >= 85 ? 'bg-meter-green' : r.value >= 65 ? 'bg-primary' : r.value >= 40 ? 'bg-warning' : 'bg-destructive'}`}
                style={{ width: `${r.value}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {m && (
        <div className="pt-2 border-t border-border/50 space-y-1.5">
          <div className="grid grid-cols-3 gap-1.5 text-center">
            {[
              ['LUFS-I', m.lufs.toFixed(1)],
              ['True Peak', `${m.truePeak.toFixed(1)}`],
              ['LRA', `${m.lra.toFixed(1)}`],
              ['DR', `${m.dr}`],
              ['PSR', `${m.psr.toFixed(1)}`],
              ['PLR', `${m.plr.toFixed(1)}`],
            ].map(([l, v]) => (
              <div key={l} className="inset-well py-1">
                <div className="font-mono-display text-xs text-primary">{v}</div>
                <div className="text-[7px] uppercase tracking-wider text-muted-foreground">{l}</div>
              </div>
            ))}
          </div>
          {(m.clipEvents > 0 || m.ispOvers > 0) && (
            <div className="text-[9px] font-mono text-destructive flex flex-wrap gap-x-3">
              {m.clipEvents > 0 && <span>⚠ {m.clipEvents} clip events ({m.clippedSamples} samples)</span>}
              {m.ispOvers > 0 && <span>⚠ {m.ispOvers} inter-sample peaks &gt; −1 dBTP</span>}
            </div>
          )}
          <p className="text-[8px] text-muted-foreground leading-snug">
            DR = TT Dynamic Range · PSR/PLR = peak vs short-term / integrated loudness — under ~6 means heavily compressed.
          </p>
        </div>
      )}
    </div>
  );
};

export default QualityScore;
