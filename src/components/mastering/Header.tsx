import { Link } from 'react-router-dom';
import { useAudio } from '@/contexts/AudioContext';
import { BrandMark, Wordmark } from '@/components/Brand';
import ModeSelector from './ModeSelector';

const Header = () => {
  const { state } = useAudio();

  return (
    <header className="px-2 sm:px-4 pt-3 pb-2">
      <div className="panel flex items-center justify-between gap-2 px-3 sm:px-5 py-2.5">
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          <Link to="/" className="flex items-center gap-2.5 flex-shrink-0" aria-label="MasteringPro — strona główna">
            <BrandMark className="w-7 h-7" />
            <Wordmark className="text-base sm:text-lg font-extrabold" />
          </Link>

          <div className="hidden sm:block h-5 w-px bg-border" />
          <span className="hidden sm:block text-[11px] text-muted-foreground font-mono truncate">
            {state.fileInfo ? state.fileInfo.name : 'No file loaded'}
          </span>
        </div>

        <div className="flex items-center gap-3 sm:gap-5 flex-shrink-0">
          {state.fileInfo && (
            <div className="hidden md:flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              <span>{state.fileInfo.sampleRate / 1000}kHz</span>
              <span>{state.fileInfo.bitDepth}bit</span>
              <span>{state.fileInfo.channels === 2 ? 'Stereo' : 'Mono'}</span>
              <span className="text-foreground">{formatDuration(state.fileInfo.duration)}</span>
            </div>
          )}
          <ModeSelector />
          <div className="hidden lg:flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
              AI Ready
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default Header;
