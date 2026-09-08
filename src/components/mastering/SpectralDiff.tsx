import { useRef, useEffect, useState } from 'react';
import { useAudio } from '@/contexts/AudioContext';
import { Eye, EyeOff } from 'lucide-react';

const SpectralDiff = () => {
  const { engine, state } = useAudio();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [showPre, setShowPre] = useState(true);
  const [showPost, setShowPost] = useState(true);

  useEffect(() => {
    if (!engine || !state.isPlaying || !canvasRef.current) {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = 'hsla(240, 5%, 20%, 0.3)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 5; i++) {
        const y = (i / 5) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const nyquist = (engine.ctx?.sampleRate ?? 48000) / 2;
      const F_MIN = 20;
      const F_MAX = Math.min(20000, nyquist);
      const logMin = Math.log10(F_MIN);
      const logMax = Math.log10(F_MAX);
      const xForFreq = (f: number) => ((Math.log10(f) - logMin) / (logMax - logMin)) * w;

      // Frequency grid + labels (true log scale)
      ctx.fillStyle = 'hsl(240, 5%, 35%)';
      ctx.font = '8px monospace';
      ctx.strokeStyle = 'hsla(240, 5%, 20%, 0.25)';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f > F_MAX) continue;
        const x = xForFreq(f);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h - 10);
        ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 1, h - 2);
      }

      const binCount = engine.preAnalyser.frequencyBinCount;
      const plot = (data: Float32Array, stroke: string, fill: string) =>
        drawCurve(ctx, data, binCount, nyquist, F_MIN, F_MAX, w, h, stroke, fill);

      if (showPre) plot(engine.getPreFrequencyData(), 'hsla(240, 5%, 50%, 0.6)', 'hsla(240, 5%, 50%, 0.05)');
      if (showPost) plot(engine.getPostFrequencyData(), 'hsl(205, 90%, 54%)', 'hsla(205, 90%, 54%, 0.08)');

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [engine, state.isPlaying, showPre, showPost]);

  if (!state.audioBuffer) return null;

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-section-header">Spectral Diff — Before / After</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPre(!showPre)}
            className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded transition-colors ${showPre ? 'bg-secondary text-muted-foreground' : 'text-muted-foreground/40'}`}
          >
            {showPre ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />} DRY
          </button>
          <button
            onClick={() => setShowPost(!showPost)}
            className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded transition-colors ${showPost ? 'bg-primary/20 text-primary' : 'text-primary/40'}`}
          >
            {showPost ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />} WET
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        width={600}
        height={120}
        className="w-full h-24 bg-background rounded-sm"
      />
      <div className="flex gap-4 mt-1 text-[8px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="w-2 h-0.5 bg-muted-foreground inline-block" /> Before (Dry)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-0.5 bg-primary inline-block" /> After (Wet)
        </span>
      </div>
    </div>
  );
};

function drawCurve(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  binCount: number,
  nyquist: number,
  fMin: number,
  fMax: number,
  w: number,
  h: number,
  strokeColor: string,
  fillColor: string,
) {
  ctx.beginPath();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;

  const logMin = Math.log10(fMin);
  const logMax = Math.log10(fMax);
  for (let x = 0; x <= w; x++) {
    const freq = Math.pow(10, logMin + (x / w) * (logMax - logMin));
    const idx = Math.min(binCount - 1, Math.max(0, Math.round((freq / nyquist) * binCount)));
    const value = data[idx] ?? -100;
    const normalized = Math.max(0, Math.min(1, (value + 100) / 80)); // -100 … -20 dBFS
    const y = h - normalized * (h - 12);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

export default SpectralDiff;
