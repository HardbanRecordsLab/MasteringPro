import { useRef, useEffect, useState, useCallback } from 'react';
import { useAudio } from '@/contexts/AudioContext';

const MeteringPanel = () => {
  const { state, engine } = useAudio();
  const [levels, setLevels] = useState({ left: -60, right: -60 });
  const [peakHold, setPeakHold] = useState({ left: -60, right: -60 });
  const [compGR, setCompGR] = useState(0);
  const [limGR, setLimGR] = useState(0);
  const [loud, setLoud] = useState({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, lra: 0 });
  const [corr, setCorr] = useState(1);
  const corrHistRef = useRef<number[]>([]);
  const corrCanvasRef = useRef<HTMLCanvasElement>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const gonioRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const peakDecayRef = useRef({ left: -60, right: -60, time: 0 });

  const draw = useCallback(() => {
    if (!engine || !state.isPlaying) return;

    // Level metering
    const ch = engine.getChannelLevels();
    setLevels({ left: Math.max(ch.left, -60), right: Math.max(ch.right, -60) });

    // Peak hold with decay
    const now = performance.now();
    const pd = peakDecayRef.current;
    if (ch.left > pd.left || now - pd.time > 2000) {
      pd.left = ch.left;
      pd.time = now;
    }
    if (ch.right > pd.right || now - pd.time > 2000) {
      pd.right = ch.right;
      pd.time = now;
    }
    setPeakHold({ left: pd.left, right: pd.right });

    // Gain reduction
    setCompGR(engine.getCompressorGR());
    setLimGR(engine.getLimiterGR());
    setLoud(engine.getLoudness());

    // Spectrum analyzer
    const specCanvas = spectrumRef.current;
    if (specCanvas) {
      const ctx = specCanvas.getContext('2d');
      if (ctx) {
        const freqData = engine.getPostFrequencyData();
        drawSpectrum(ctx, specCanvas, freqData);
      }
    }

    // Goniometer + phase correlation
    const gonioData = engine.getGoniometerData();
    const gonioCanvas = gonioRef.current;
    if (gonioCanvas) {
      const ctx = gonioCanvas.getContext('2d');
      if (ctx) drawGoniometer(ctx, gonioCanvas, gonioData.l, gonioData.r);
    }
    {
      const { l, r } = gonioData;
      let lr = 0, ll = 0, rr = 0;
      for (let i = 0; i < l.length; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
      const c = ll > 1e-9 && rr > 1e-9 ? lr / Math.sqrt(ll * rr) : 1;
      setCorr(c);
      const hist = corrHistRef.current;
      hist.push(c);
      if (hist.length > 160) hist.shift();
      const cc = corrCanvasRef.current?.getContext('2d');
      if (cc && corrCanvasRef.current) drawCorrHistory(cc, corrCanvasRef.current, hist);
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [engine, state.isPlaying]);

  useEffect(() => {
    if (state.isPlaying && engine) {
      rafRef.current = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(rafRef.current);
      setLevels({ left: -60, right: -60 });
      setCompGR(0);
      setLimGR(0);
      setLoud({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, lra: 0 });
      setCorr(1);
      corrHistRef.current = [];
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [state.isPlaying, engine, draw]);

  const fmtLufs = (v: number) => (state.isPlaying && Number.isFinite(v) ? v.toFixed(1) : '—');

  return (
    <div className="panel p-3 space-y-4">
      <span className="text-section-header">Meters</span>

      {/* VU Meters */}
      <div className="space-y-2">
        <LevelMeter label="L" value={levels.left} peak={peakHold.left} />
        <LevelMeter label="R" value={levels.right} peak={peakHold.right} />
      </div>

      {/* BS.1770-4 loudness */}
      <div className="grid grid-cols-4 gap-1.5 text-center">
        {[
          ['LUFS-M', fmtLufs(loud.momentary)],
          ['LUFS-S', fmtLufs(loud.shortTerm)],
          ['LUFS-I', fmtLufs(loud.integrated)],
          ['LRA · LU', state.isPlaying ? loud.lra.toFixed(1) : '—'],
        ].map(([l, v]) => (
          <div key={l} className="inset-well py-1">
            <div className="font-mono-display text-xs text-primary">{v}</div>
            <div className="text-[7px] uppercase tracking-wider text-muted-foreground">{l}</div>
          </div>
        ))}
      </div>

      {/* Readouts */}
      <div className="space-y-1.5">
        <MetricDisplay label="True Peak L" value={state.isPlaying ? `${peakHold.left.toFixed(1)}` : '—'} warn={peakHold.left > -1} />
        <MetricDisplay label="True Peak R" value={state.isPlaying ? `${peakHold.right.toFixed(1)}` : '—'} warn={peakHold.right > -1} />
        <MetricDisplay label="Comp GR" value={state.isPlaying ? `${compGR.toFixed(1)} dB` : '—'} />
        <MetricDisplay label="Lim GR" value={state.isPlaying ? `${limGR.toFixed(1)} dB` : '—'} />
      </div>

      {/* Phase correlation */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Correlation</span>
          <span
            className={`text-[10px] font-mono ${
              corr < 0 ? 'text-destructive' : corr < 0.4 ? 'text-warning' : 'text-meter-green'
            }`}
          >
            {state.isPlaying ? corr.toFixed(2) : '—'}
          </span>
        </div>
        <div className="relative h-1.5 rounded-sm bg-background overflow-hidden">
          <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
          <div
            className={`absolute inset-y-0 ${corr >= 0 ? 'left-1/2' : 'right-1/2'} ${
              corr < 0 ? 'bg-destructive' : corr < 0.4 ? 'bg-warning' : 'bg-meter-green'
            }`}
            style={{ width: `${Math.abs(corr) * 50}%` }}
          />
        </div>
        <canvas ref={corrCanvasRef} width={220} height={28} className="w-full h-7 bg-background rounded-sm mt-1" />
      </div>

      {/* Real-time Goniometer */}
      <div className="space-y-1">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Phase Scope</span>
        <canvas
          ref={gonioRef}
          width={180}
          height={180}
          className="w-full aspect-square bg-background rounded-sm"
        />
      </div>

      {/* Real-time Spectrum Analyzer */}
      <div className="space-y-1">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Spectrum</span>
        <canvas
          ref={spectrumRef}
          width={220}
          height={80}
          className="w-full h-16 bg-background rounded-sm"
        />
      </div>
    </div>
  );
};

function drawCorrHistory(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, hist: number[]) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'hsl(240, 5%, 22%)';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  if (hist.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = 'hsl(205, 90%, 60%)';
  ctx.lineWidth = 1;
  hist.forEach((c, i) => {
    const x = (i / (hist.length - 1)) * w;
    const y = h / 2 - (c * h) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // shade the below-zero (out-of-phase) region if it occurs
  const anyNeg = hist.some((c) => c < 0);
  if (anyNeg) {
    ctx.fillStyle = 'hsl(0, 70%, 45%, 0.12)';
    ctx.fillRect(0, h / 2, w, h / 2);
  }
}

function drawSpectrum(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, data: Float32Array) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const barCount = 32;
  const barWidth = w / barCount - 1;
  const binCount = data.length;

  for (let i = 0; i < barCount; i++) {
    // Log-scale frequency mapping
    const logIndex = Math.round(Math.pow(binCount, i / barCount));
    const value = data[Math.min(logIndex, binCount - 1)] || -100;
    const normalized = Math.max(0, (value + 100) / 100); // -100dB to 0dB → 0 to 1
    const barHeight = normalized * h;

    const hue = normalized > 0.85 ? 0 : normalized > 0.65 ? 60 : 145;
    ctx.fillStyle = `hsl(${hue}, 60%, 50%)`;
    ctx.fillRect(i * (barWidth + 1), h - barHeight, barWidth, barHeight);
  }
}

function drawGoniometer(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, l: Float32Array, r: Float32Array) {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = w * 0.35;

  // Fade previous frame
  ctx.fillStyle = 'rgba(10, 10, 12, 0.3)';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'hsla(240, 5%, 20%, 0.5)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
  ctx.moveTo(0, cy); ctx.lineTo(w, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, scale * 0.5, 0, Math.PI * 2);
  ctx.arc(cx, cy, scale, 0, Math.PI * 2);
  ctx.stroke();

  // Plot L/R as M/S rotated 45°
  ctx.fillStyle = 'hsl(205, 90%, 54%)';
  const step = Math.max(1, Math.floor(l.length / 256));
  for (let i = 0; i < l.length; i += step) {
    const mid = (l[i] + r[i]) * 0.5;
    const side = (l[i] - r[i]) * 0.5;
    const px = cx + side * scale;
    const py = cy - mid * scale;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(px, py, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  // Labels
  ctx.fillStyle = 'hsl(240, 5%, 40%)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('M', cx, 10);
  ctx.fillText('S', cx, h - 4);
  ctx.fillText('L', 6, cy + 3);
  ctx.fillText('R', w - 6, cy + 3);
}

const LevelMeter = ({ label, value, peak }: { label: string; value: number; peak?: number }) => {
  const pct = Math.max(0, Math.min(100, ((value + 60) / 60) * 100));
  const peakPct = peak !== undefined ? Math.max(0, Math.min(100, ((peak + 60) / 60) * 100)) : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-mono text-muted-foreground w-3">{label}</span>
      <div className="flex-1 h-2.5 bg-background rounded-sm overflow-hidden relative">
        <div className="flex gap-[1px] h-full">
          {Array.from({ length: 30 }).map((_, i) => {
            const segPct = (i / 30) * 100;
            const active = segPct < pct;
            const color = i > 25 ? 'bg-meter-red' : i > 20 ? 'bg-meter-yellow' : 'bg-meter-green';
            return (
              <div
                key={i}
                className={`flex-1 h-full rounded-[1px] transition-opacity duration-50 ${active ? color : 'bg-background'}`}
                style={{ opacity: active ? 1 : 0.1 }}
              />
            );
          })}
        </div>
        {/* Peak hold indicator */}
        {peak !== undefined && peakPct > 0 && (
          <div
            className="absolute top-0 h-full w-0.5 bg-foreground"
            style={{ left: `${peakPct}%` }}
          />
        )}
      </div>
      <span className="text-[9px] font-mono text-muted-foreground w-10 text-right">{value.toFixed(1)}</span>
    </div>
  );
};

const MetricDisplay = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="flex items-center justify-between">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className={`text-xs font-mono ${warn ? 'text-meter-red' : 'text-primary'}`}>{value}</span>
  </div>
);

export default MeteringPanel;
