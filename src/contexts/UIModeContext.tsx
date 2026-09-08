import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type UIMode = 'quick' | 'smart' | 'pro';

const STORAGE_KEY = 'masterpro-ui-mode';

interface UIModeCtx {
  mode: UIMode;
  setMode: (m: UIMode) => void;
}

const Ctx = createContext<UIModeCtx | null>(null);

export const UIModeProvider = ({ children }: { children: ReactNode }) => {
  const [mode, setModeState] = useState<UIMode>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'quick' || v === 'smart' || v === 'pro') return v;
    } catch {}
    return 'smart';
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  }, [mode]);

  return <Ctx.Provider value={{ mode, setMode: setModeState }}>{children}</Ctx.Provider>;
};

export const useUIMode = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUIMode must be within UIModeProvider');
  return c;
};
