import { useState, useEffect } from 'react';
import { Save, Clock, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAudio, type ProcessingParams } from '@/contexts/AudioContext';
import { toast } from 'sonner';

interface Session {
  id: string;
  name: string;
  timestamp: number;
  params: ProcessingParams;
}

const STORAGE_KEY = 'masterpro-sessions';

function loadSessions(): Session[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function saveSessions(sessions: Session[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

const SessionHistory = () => {
  const { processing, setProcessing } = useAudio();
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [sessionName, setSessionName] = useState('');

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  const handleSave = () => {
    const name = sessionName.trim() || `Session ${sessions.length + 1}`;
    const session: Session = {
      id: crypto.randomUUID(),
      name,
      timestamp: Date.now(),
      params: { ...processing },
    };
    setSessions(prev => [session, ...prev]);
    setSessionName('');
    toast.success(`Saved: ${name}`);
  };

  const handleLoad = (session: Session) => {
    setProcessing(session.params);
    toast.success(`Loaded: ${session.name}`);
  };

  const handleDelete = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
  };

  return (
    <div className="panel p-3 space-y-3">
      <span className="text-section-header">Session History</span>

      <div className="flex gap-2">
        <input
          className="flex-1 px-2 py-1 bg-background border border-border rounded-sm text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
          placeholder="Session name..."
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
        />
        <Button size="sm" variant="secondary" className="gap-1" onClick={handleSave}>
          <Save className="w-3 h-3" /> Save
        </Button>
      </div>

      {sessions.length === 0 ? (
        <p className="text-[9px] text-muted-foreground italic">No saved sessions yet</p>
      ) : (
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {sessions.map(session => (
            <div key={session.id} className="flex items-center gap-2 p-1.5 bg-background rounded-sm group">
              <Clock className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-foreground truncate">{session.name}</div>
                <div className="text-[8px] text-muted-foreground">
                  {new Date(session.timestamp).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => handleLoad(session)}
                className="text-muted-foreground hover:text-primary transition-colors"
                title="Load"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
              <button
                onClick={() => handleDelete(session.id)}
                className="text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SessionHistory;
