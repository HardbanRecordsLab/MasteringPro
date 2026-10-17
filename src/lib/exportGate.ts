import { useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, creditsApi } from '@/lib/accountApi';

/** 1 credit = 1 track exported as a master. The same track can be re-exported (other formats, fixes) for this long. */
export const EXPORT_WINDOW_DAYS = 3;
/** one purchase of the album pack covers a whole album */
export const MAX_ALBUM_TRACKS = 16;

/** AccountPanel listens for this and opens its pack list (and scrolls to itself). */
export const OPEN_PACKS_EVENT = 'mp:open-packs';

/** Identity of a track = its SOURCE file (so fixes / restoration / another format of the same song stay the same track). */
export const trackKeyOf = (f: { name: string; size: number; lastModified: number }) => `${f.name}|${f.size}|${f.lastModified}`;

export interface ExportTrack { key: string; label?: string }

/**
 * Returns an async function that settles the credit cost of an export BEFORE it starts. Resolves true when the export may
 * go ahead. Without a backend that has accounts (self-hosted, local-only) nothing is metered.
 */
export function useExportGate() {
  const { user, enabled, loading, refreshUser } = useAuth();
  return useCallback(
    async (tracks: ExportTrack[]): Promise<boolean> => {
      if (loading) { toast.info('Sprawdzam konto… spróbuj za chwilę.'); return false; }
      if (!enabled) return true;
      if (!user) {
        // not signed in: only block when exporting is actually charged
        try {
          if (!(await creditsApi.status()).export_metering) return true;
        } catch {
          return true;      // can't tell → don't lock people out of a free tool because the status call failed
        }
        toast.error('Zaloguj się lub załóż konto, aby wyeksportować master — pierwsze utwory są gratis.');
        window.dispatchEvent(new Event(OPEN_PACKS_EVENT));
        return false;
      }
      try {
        const r = await creditsApi.chargeExport(tracks);
        await refreshUser();
        if (r.charged > 0) {
          toast.info(`Rozliczono ${r.charged} ${r.charged === 1 ? 'kredyt' : 'kredyty'} (zostało ${r.credits}). Poprawki tych utworów przez ${r.window_days} dni są bezpłatne.`);
        }
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 402) {
          toast.error(e.message);
          window.dispatchEvent(new Event(OPEN_PACKS_EVENT));
        } else {
          toast.error('Nie udało się rozliczyć eksportu — spróbuj ponownie.');
        }
        return false;
      }
    },
    [user, enabled, loading, refreshUser],
  );
}
