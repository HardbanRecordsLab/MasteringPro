import { Play, Square, Repeat } from 'lucide-react';
import { useAudio } from '@/contexts/AudioContext';
import { Button } from '@/components/ui/button';

const TransportControls = () => {
  const { state, play, stop, toggleLoop } = useAudio();

  if (!state.audioBuffer) return null;

  return (
    <div className="flex items-center gap-2">
      {state.isPlaying ? (
        <Button size="sm" variant="secondary" onClick={stop} className="gap-1.5">
          <Square className="w-3.5 h-3.5" /> Stop
        </Button>
      ) : (
        <Button size="sm" variant="default" onClick={play} className="gap-1.5">
          <Play className="w-3.5 h-3.5" /> Play
        </Button>
      )}
      <Button
        size="sm"
        variant={state.isLooping ? 'default' : 'secondary'}
        onClick={toggleLoop}
        className="gap-1.5"
      >
        <Repeat className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
};

export default TransportControls;
