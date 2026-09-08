import { useRef, useEffect } from 'react';
import { useAudio } from '@/contexts/AudioContext';

const WaveformDisplay = () => {
  const { state, seek } = useAudio();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!state.audioBuffer || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const data = state.audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const mid = height / 2;

    ctx.clearRect(0, 0, width, height);

    // Draw waveform
    const playProgress = state.duration > 0 ? state.currentTime / state.duration : 0;
    const playX = playProgress * width;

    for (let i = 0; i < width; i++) {
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step; j++) {
        const idx = i * step + j;
        if (idx < data.length) {
          const val = data[idx];
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }

      const isPlayed = i < playX;
      ctx.fillStyle = isPlayed
        ? 'hsl(205, 90%, 54%)'
        : 'hsl(240, 5%, 35%)';

      const top = mid + min * mid;
      const bottom = mid + max * mid;
      ctx.fillRect(i, top, 1, bottom - top || 1);
    }

    // Playhead
    if (state.isPlaying || state.currentTime > 0) {
      ctx.strokeStyle = 'hsl(205, 90%, 68%)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();
    }
  }, [state.audioBuffer, state.currentTime, state.duration, state.isPlaying]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!state.audioBuffer || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    seek(ratio * state.duration);
  };

  if (!state.audioBuffer) return null;

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-section-header">Waveform</span>
        <span className="text-xs font-mono text-muted-foreground">
          {formatTime(state.currentTime)} / {formatTime(state.duration)}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full h-24 cursor-crosshair rounded-sm bg-background"
        onClick={handleClick}
      />
    </div>
  );
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default WaveformDisplay;
