import { Hono } from 'hono';
import { requireUser } from '../auth.js';
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
