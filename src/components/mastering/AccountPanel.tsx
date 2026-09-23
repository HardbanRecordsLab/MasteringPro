import { useEffect, useState } from 'react';
import { User, LogOut, Loader2, Save, FolderOpen, Trash2, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useAudio } from '@/contexts/AudioContext';
import { accountApi, billingApi, type Project, type CreditPack, ApiError } from '@/lib/accountApi';
import { toast } from 'sonner';

const AccountPanel = () => {
  const { user, enabled, loading, login, register, logout, refreshUser } = useAuth();
  const { state, processing, setProcessing } = useAudio();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [showPacks, setShowPacks] = useState(false);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);

  const refreshProjects = () => {
    if (user) accountApi.listProjects().then(setProjects).catch(() => {});
  };
  useEffect(refreshProjects, [user]);

  // Back from a Stripe redirect: pick up the new balance and say so once.
  useEffect(() => {
    const url = new URL(window.location.href);
    const billing = url.searchParams.get('billing');
    if (!billing) return;
    url.searchParams.delete('billing');
    url.searchParams.delete('session_id');
    window.history.replaceState({}, '', url.toString());
    if (billing === 'success') {
      refreshUser().then(() => toast.success('Płatność zaksięgowana — kredyty doładowane.'));
    } else if (billing === 'cancelled') {
      toast.info('Zakup anulowany — nic nie pobrano.');
    }
  }, [refreshUser]);

  const buyPack = async (packId: string) => {
    setCheckingOut(packId);
    try {
      const { checkout_url } = await billingApi.checkout(packId);
      window.location.href = checkout_url;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Nie udało się otworzyć płatności.');
      setCheckingOut(null);
    }
  };

  const openPacks = () => {
    setShowPacks((v) => !v);
    if (!packs.length) billingApi.listPacks().then((r) => setPacks(r.packs)).catch(() => {});
  };

  if (loading) {
    return (
      <div className="panel p-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking account…
      </div>
    );
  }
  if (!enabled) return null; // backend has no database → local-only mode

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'register') await register(email, password);
      else await login(email, password);
      toast.success(mode === 'register' ? 'Account created' : 'Signed in');
      setPassword('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const saveProject = async () => {
    if (!state.fileInfo) return;
    setBusy(true);
    try {
      const project = await accountApi.createProject({
        title: state.fileInfo.name.replace(/\.[^.]+$/, ''),
        sourceName: state.fileInfo.name,
        sourceSampleRate: state.fileInfo.sampleRate,
        sourceChannels: state.fileInfo.channels,
        sourceDurationS: state.fileInfo.duration,
      });
      await accountApi.addVersion(project.id, {
        label: 'v1',
        chainParams: processing as unknown as Record<string, unknown>,
      });
      toast.success(`Saved "${project.title}"`);
      refreshProjects();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const loadProject = async (id: string) => {
    try {
      const { project, versions } = await accountApi.getProject(id);
      const latest = versions[0];
      if (latest?.chainParams) {
        setProcessing((prev) => ({ ...prev, ...(latest.chainParams as object) }));
        toast.success(`Loaded chain from "${project.title}"`);
      } else {
        toast.info('That project has no saved chain yet');
      }
    } catch {
      toast.error('Load failed');
    }
  };

  const removeProject = async (id: string) => {
    try {
      await accountApi.deleteProject(id);
      setProjects((p) => p.filter((x) => x.id !== id));
    } catch {
      toast.error('Delete failed');
    }
  };

  return (
    <div className="panel p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-section-header flex items-center gap-1.5">
          <User className="w-3.5 h-3.5 text-primary" /> Account
        </span>
        {user && (
          <button onClick={logout} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
            <LogOut className="w-3 h-3" /> Sign out
          </button>
        )}
      </div>

      {!user && (
        <>
          <div className="flex gap-1 text-[10px]">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-1 rounded-sm ${mode === m ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}
              >
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>
          <input
            type="email" placeholder="email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-2 py-1 bg-background border border-border rounded-sm text-xs focus:border-primary/50 focus:outline-none"
          />
          <input
            type="password" placeholder="password (min 8)" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="w-full px-2 py-1 bg-background border border-border rounded-sm text-xs focus:border-primary/50 focus:outline-none"
          />
          <button
            onClick={submit}
            disabled={busy || !email || password.length < 8}
            className="w-full py-1.5 rounded-sm bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <p className="text-[8px] text-muted-foreground">Audio never leaves your browser — only chain settings and metrics are saved.</p>
        </>
      )}

      {user && (
        <>
          <div className="text-[10px] font-mono text-muted-foreground truncate">{user.email}</div>

          <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm bg-primary/10">
            <span className="flex items-center gap-1 text-xs font-medium text-primary">
              <Zap className="w-3 h-3" /> {user.credits} {user.credits === 1 ? 'kredyt' : 'kredytów'} AI
            </span>
            <button onClick={openPacks} className="text-[10px] underline text-primary hover:text-primary/80">
              {showPacks ? 'Ukryj' : 'Dokup'}
            </button>
          </div>

          {showPacks && (
            <div className="space-y-1">
              {packs.length === 0 && (
                <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 py-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Ładowanie pakietów…
                </div>
              )}
              {packs.map((p) => (
                <button
                  key={p.id}
                  onClick={() => buyPack(p.id)}
                  disabled={!p.available || checkingOut !== null}
                  title={!p.available ? 'Ten pakiet nie jest jeszcze dostępny' : undefined}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm text-[10px] disabled:opacity-40 ${
                    p.popular ? 'bg-primary/15 text-primary' : 'bg-secondary text-foreground hover:bg-secondary/70'
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {checkingOut === p.id && <Loader2 className="w-3 h-3 animate-spin" />}
                    {p.name} · {p.credits} kr.
                  </span>
                  <span className="font-mono font-semibold">{p.price_pln} zł</span>
                </button>
              ))}
            </div>
          )}

          <button
            onClick={saveProject}
            disabled={busy || !state.fileInfo}
            className="w-full py-1.5 rounded-sm bg-primary/15 text-primary text-xs font-medium disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save current chain
          </button>
          {projects.length > 0 && (
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-1 text-[10px] group">
                  <button
                    onClick={() => loadProject(p.id)}
                    className="flex-1 flex items-center gap-1.5 px-1.5 py-1 rounded-sm hover:bg-secondary text-left truncate"
                  >
                    <FolderOpen className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="truncate">{p.title}</span>
                  </button>
                  <button
                    onClick={() => removeProject(p.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AccountPanel;
