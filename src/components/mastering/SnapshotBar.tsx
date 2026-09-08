import { Undo2, Redo2, RotateCcw } from 'lucide-react';
import { useAudio, type SnapshotSlot } from '@/contexts/AudioContext';

const SLOTS: SnapshotSlot[] = ['A', 'B', 'C', 'D'];

/** Undo/redo + four chain snapshots for quick A/B/C/D comparison. */
const SnapshotBar = () => {
  const { undo, redo, canUndo, canRedo, snapshots, saveSnapshot, recallSnapshot, resetProcessing } = useAudio();

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <div className="flex items-center gap-0.5">
        <button
          onClick={undo}
          disabled={!canUndo}
          className="p-1.5 rounded-sm hover:bg-secondary disabled:opacity-30 text-muted-foreground hover:text-foreground"
          title="Undo (chain)"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className="p-1.5 rounded-sm hover:bg-secondary disabled:opacity-30 text-muted-foreground hover:text-foreground"
          title="Redo (chain)"
        >
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="h-4 w-px bg-border" />

      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Snap</span>
      {SLOTS.map((s) => {
        const filled = !!snapshots[s];
        return (
          <button
            key={s}
            onClick={() => (filled ? recallSnapshot(s) : saveSnapshot(s))}
            onContextMenu={(e) => { e.preventDefault(); saveSnapshot(s); }}
            className={`w-6 h-6 rounded-sm text-[10px] font-mono transition-colors ${
              filled
                ? 'bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25'
                : 'bg-secondary text-muted-foreground border border-transparent hover:text-foreground'
            }`}
            title={filled ? `Recall snapshot ${s} (right-click to overwrite)` : `Save current chain to ${s}`}
          >
            {s}
          </button>
        );
      })}

      <div className="h-4 w-px bg-border" />
      <button
        onClick={resetProcessing}
        className="p-1.5 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground"
        title="Reset chain to defaults"
      >
        <RotateCcw className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default SnapshotBar;
