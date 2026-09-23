// Gates the AI endpoints (chain generation / QA / reference match / Copilot)
// behind a signed-in user with a positive credit balance, and deducts exactly
// one credit per successful call. The manual DSP console never touches this —
// it's pure client-side Web Audio and stays free and unmetered.
import { eq, and, gt, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';

/** Use after loadUser + requireUser. Rejects with 402 when credits are exhausted. */
export async function requireCredits(c, next) {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Not signed in' }, 401);

  if ((user.credits ?? 0) <= 0) {
    return c.json(
      {
        error: 'CREDITS_EXHAUSTED',
        message: 'Brak kredytów AI Mastering. Kup pakiet, aby kontynuować.',
        credits: user.credits ?? 0,
      },
      402,
    );
  }

  await next();

  // Only spend a credit for a call that actually succeeded — a 4xx/5xx from
  // the AI handler (rate limit, invalid body, provider error) costs nothing.
  if (c.res && c.res.status === 200) {
    const db = getDb();
    const rows = await db
      .update(schema.users)
      .set({ credits: sql`${schema.users.credits} - 1` })
      .where(and(eq(schema.users.id, user.id), gt(schema.users.credits, 0)))
      .returning({ credits: schema.users.credits });
    if (rows[0]) c.set('user', { ...user, credits: rows[0].credits });
  }
}
