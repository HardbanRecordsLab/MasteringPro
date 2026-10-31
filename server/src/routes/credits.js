import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { requireUser, isWalletUser } from '../auth.js';
import { wallet, WalletError, WalletUnavailable } from '../services/wallet.js';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { chargeExports, EXPORT_WINDOW_DAYS, MAX_TRACKS_PER_EXPORT } from '../services/exportCredits.js';

export const creditsRoutes = new Hono();

// Public: does the app charge for exports yet? (the browser asks before it demands a sign-in)
creditsRoutes.get('/status', (c) =>
  c.json({ export_metering: config.exportMetering, window_days: EXPORT_WINDOW_DAYS, max_tracks: MAX_TRACKS_PER_EXPORT }),
);

// Called by the browser right BEFORE it exports a master (the audio itself never leaves the browser).
// Body: { tracks: [{ key, label? }] } — 1..16 tracks (a single track, or a whole album).
creditsRoutes.post('/export', requireUser, async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const tracks = body?.tracks;
  if (!Array.isArray(tracks) || tracks.length < 1) return c.json({ error: 'tracks[] required' }, 400);
  if (tracks.length > MAX_TRACKS_PER_EXPORT) {
    return c.json({ error: `Max ${MAX_TRACKS_PER_EXPORT} tracks per export`, max: MAX_TRACKS_PER_EXPORT }, 400);
  }
  for (const t of tracks) {
    if (!t || typeof t.key !== 'string' || t.key.length < 1 || t.key.length > 400) return c.json({ error: 'Invalid track key' }, 400);
  }

  const user = c.get('user');
  if (!config.exportMetering || config.adminEmails.includes(String(user.email || '').toLowerCase())) {
    // metering off, or an operator account: nothing is charged
    // metering not switched on yet: nothing is charged
    return c.json({ charged: 0, covered: tracks.length, credits: user.credits ?? 0, covered_until: null, window_days: EXPORT_WINDOW_DAYS, metering: false });
  }
  if (isWalletUser(user)) return chargeInWallet(c, user, tracks);
  const r = await chargeExports(getDb(), user.id, tracks);
  if (!r.ok) {
    return c.json(
      {
        error: 'CREDITS_EXHAUSTED',
        message: `Brak kredytów: ten eksport wymaga ${r.needed}, masz ${r.credits}. Dokup pakiet, aby kontynuować.`,
        needed: r.needed,
        credits: r.credits,
      },
      402,
    );
  }
  return c.json({ charged: r.charged, covered: r.covered, credits: r.credits, covered_until: r.coveredUntil, window_days: EXPORT_WINDOW_DAYS });
});

// Credits live in HRL Wallet: 1 track = 9 credits, the same track is free for 3 days, an album is all or nothing.
// The key covers the exact set of tracks inside one minute, so a double click or a retried request charges once.
async function chargeInWallet(c, user, tracks) {
  const set = [...new Set(tracks.map((t) => String(t.key)))].sort().join('\n');
  const key = `mp:export:${user.walletAccountId}:${createHash('sha256').update(set).digest('hex').slice(0, 24)}:${Math.floor(Date.now() / 60000)}`;
  try {
    const r = await wallet.chargeExport(user.walletAccountId, key, tracks.map((t) => ({ key: String(t.key), label: String(t.label || '').slice(0, 200) })));
    const bal = await wallet.balance(user.walletAccountId);
    // a replay is the same request paid a moment ago (double click, retry): this one costs nothing
    const unique = new Set(tracks.map((t) => String(t.key))).size;
    const charged = r.replayed ? 0 : r.charged_units ?? 0;
    return c.json({ charged, covered: r.replayed ? unique : r.covered ?? 0, credits: bal.units, covered_until: r.covered_until ?? null, window_days: EXPORT_WINDOW_DAYS });
  } catch (e) {
    if (e instanceof WalletUnavailable) return c.json({ error: 'WALLET_UNAVAILABLE', message: 'Kredyty są chwilowo niedostępne — spróbuj za minutę.' }, 503);
    if (e instanceof WalletError && e.status === 402) {
      const cost = e.payload.cost || 9;
      const needed = Math.ceil((e.payload.needed ?? cost) / cost);
      const have = Math.floor((e.payload.credits ?? 0) / cost);
      return c.json({ error: 'CREDITS_EXHAUSTED', message: `Brak kredytów: ten eksport wymaga ${needed}, masz ${have}. Dokup pakiet, aby kontynuować.`, needed, credits: have }, 402);
    }
    console.error('[credits] wallet charge failed:', e.message);
    return c.json({ error: 'Could not charge credits' }, 502);
  }
}
