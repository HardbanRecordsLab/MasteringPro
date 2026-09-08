import { useEffect, useState } from 'react';
import { Library, Save, Loader2, Trash2 } from 'lucide-react';
import { useAudio } from '@/contexts/AudioContext';
import { useAuth } from '@/contexts/AuthContext';
import { FACTORY_PRESETS } from '@/lib/factoryPresets';
import { accountApi } from '@/lib/accountApi';
import { toast } from 'sonner';

const LOCAL_KEY = 'masterpro-user-presets';

interface UserPreset {
  id: string;
  name: string;
  genre?: string | null;
  chainParams: Record<string, unknown>;
}

const readLocal = (): UserPreset[] => {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
};
const writeLocal = (p: UserPreset[]) => {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(p)); } catch { /* quota */ }
};

const PresetLibrary = () => {
  const { processing, setProcessing } = useAudio();
  const { user } = useAuth();
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    if (user) {
      accountApi.listPresets()
        .then((ps) => setUserPresets(ps.filter((p) => !p.isFactory).map((p) => ({ id: p.id, name: p.name, genre: p.genre, chainParams: p.chainParams }))))
        .catch(() => setUserPresets(readLocal()));
    } else {
      setUserPresets(readLocal());
    }
  };
  useEffect(refresh, [user]);

  const apply = (chain: Record<string, unknown>) => {
    setProcessing((p) => ({ ...p, ...(chain as object) }));
    toast.success('Preset applied');
  };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const chainParams = processing as unknown as Record<string, unknown>;
    try {
      if (user) {
        await accountApi.savePreset(name.trim(), chainParams);
      } else {
        const next = [...readLocal(), { id: crypto.randomUUID(), name: name.trim(), chainParams }];
        writeLocal(next);
      }
      setName('');
      refresh();
      toast.success('Preset saved');
    } catch {
      toast.error('Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      if (user) await accountApi.deletePreset(id);
      else writeLocal(readLocal().filter((p) => p.id !== id));
      refresh();
    } catch {
      toast.error('Delete failed');
    }
  };

  return (
    <div className="panel p-3 space-y-2">
      <span className="text-section-header flex items-center gap-1.5">
        <Library className="w-3.5 h-3.5 text-primary" /> Preset Library
      </span>

      <div>
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Factory · by genre</span>
        <div className="grid grid-cols-2 gap-1 mt-1">
          {FACTORY_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => apply(p.chain as Record<string, unknown>)}
              className="text-left px-2 py-1 rounded-sm bg-secondary hover:bg-primary/15 hover:text-primary transition-colors"
              title={p.blurb}
            >
              <div className="text-[10px] font-medium truncate">{p.name}</div>
              <div className="text-[8px] text-muted-foreground truncate">{p.genre}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="Save current chain as…"
            className="flex-1 px-2 py-1 bg-background border border-border rounded-sm text-[10px] focus:border-primary/50 focus:outline-none"
          />
          <button
            onClick={save}
            disabled={busy || !name.trim()}
            className="px-2 rounded-sm bg-primary/15 text-primary disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          </button>
        </div>
        {!user && <p className="text-[8px] text-muted-foreground mt-1">Saved in this browser. Sign in to sync.</p>}

        {userPresets.length > 0 && (
          <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {userPresets.map((p) => (
              <div key={p.id} className="flex items-center gap-1 text-[10px] group">
                <button
                  onClick={() => apply(p.chainParams)}
                  className="flex-1 px-1.5 py-1 rounded-sm hover:bg-secondary text-left truncate"
                >
                  {p.name}
                </button>
                <button onClick={() => remove(p.id)} className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default PresetLibrary;
