import { useCallback } from 'react';
import { useAudio } from '@/contexts/AudioContext';

const AudioUpload = () => {
  const { loadFile, state } = useAudio();

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && isAudioFile(file)) loadFile(file);
  }, [loadFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }, [loadFile]);

  if (state.audioBuffer) return null;

  return (
    <div
      className="dropzone-glow group relative h-full min-h-[380px] bg-card border-2 border-dashed rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer overflow-hidden"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      onClick={() => document.getElementById('audio-input')?.click()}
    >
      {/* ambient brand wash */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{ background: 'radial-gradient(circle at 50% 45%, hsl(var(--primary) / 0.09), transparent 65%)' }} />

      <div className="relative flex flex-col items-center px-8">
        <div className="w-16 h-16 rounded-2xl inset-well flex items-center justify-center mb-6">
          <svg viewBox="0 0 24 24" className="w-8 h-8 text-primary" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15.5V4.5" />
            <path d="m7.5 9 4.5-4.5L16.5 9" />
            <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
          </svg>
        </div>

        <h2 className="font-display text-2xl text-foreground mb-2">Upuść plik audio tutaj</h2>
        <p className="text-sm text-muted-foreground">WAV, AIFF, MP3, FLAC, OGG, AAC</p>

        <button
          type="button"
          className="mt-8 px-8 py-3 bg-primary text-primary-foreground rounded-full text-xs font-bold uppercase tracking-[0.14em] transition-transform hover:scale-105 active:scale-95"
        >
          Wybierz z dysku
        </button>

        <p className="mt-6 text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground/70">
          44.1 / 48 / 96 kHz supported
        </p>
      </div>

      <input
        id="audio-input"
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  );
};

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|aac)$/i.test(file.name);
}

export default AudioUpload;
