// Credits = tracks. One credit pays for one track exported as a master; exporting the SAME track again (other formats,
// fixes) is free for EXPORT_WINDOW_DAYS. All-or-nothing for a batch (album), serialised per user by a row lock so two
// simultaneous exports can never spend the same credit twice.
import { createHash } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';

export const EXPORT_WINDOW_DAYS = 3;
export const MAX_TRACKS_PER_EXPORT = 16;   // an album

const keyHash = (k) => createHash('sha256').update(String(k)).digest('hex');

/**
 * @param {*} db drizzle instance
 * @param {string} userId
 * @param {{key: string, label?: string}[]} tracks
 * @returns {Promise<{ok: true, charged: number, covered: number, credits: number, coveredUntil: string}
 *                 | {ok: false, needed: number, credits: number}>}
 */
export async function chargeExports(db, userId, tracks, now = new Date()) {
  const unique = new Map();
  for (const t of tracks) unique.set(keyHash(t.key), { hash: keyHash(t.key), label: (t.label || '').slice(0, 200) });
  const items = [...unique.values()];
  const expiresAt = new Date(now.getTime() + EXPORT_WINDOW_DAYS * 86400_000);

  return db.transaction(async (tx) => {
    const [u] = await tx.select({ credits: schema.users.credits }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
    if (!u) throw new Error('user not found');

    const existing = await tx.select().from(schema.exportCharges).where(eq(schema.exportCharges.userId, userId));
    const live = new Map(existing.filter((r) => r.expiresAt > now).map((r) => [r.trackKey, r]));
    const toCharge = items.filter((i) => !live.has(i.hash));

    if (u.credits < toCharge.length) return { ok: false, needed: toCharge.length, credits: u.credits };

    if (toCharge.length) {
      await tx.update(schema.users).set({ credits: sql`${schema.users.credits} - ${toCharge.length}` }).where(eq(schema.users.id, userId));
      for (const i of toCharge) {
        await tx
          .insert(schema.exportCharges)
          .values({ userId, trackKey: i.hash, label: i.label, chargedAt: now, expiresAt })
          .onConflictDoUpdate({
            target: [schema.exportCharges.userId, schema.exportCharges.trackKey],
            set: { chargedAt: now, expiresAt, label: i.label },
          });
      }
    }
    return { ok: true, charged: toCharge.length, covered: items.length - toCharge.length, credits: u.credits - toCharge.length, coveredUntil: expiresAt.toISOString() };
  });
}
