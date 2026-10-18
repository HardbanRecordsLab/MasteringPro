// AI Mastering / Copilot are INCLUDED in the price of a track: they need a signed-in account but never spend credits
// (credits pay for exported masters — see routes/credits.js). Because every call costs a little real money, each account
// has a daily call cap on top of the per-IP rate limit.
import { config } from './config.js';
const DAILY_CAP = Number(process.env.AI_DAILY_PER_USER) || 200;
const usage = new Map(); // userId -> { day, n }

/** Use after loadUser + requireUser. */
export async function requireAiQuota(c, next) {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Not signed in' }, 401);
  if (config.adminEmails.includes(String(user.email || '').toLowerCase())) return next();
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(user.id);
  const n = u && u.day === day ? u.n : 0;
  if (n >= DAILY_CAP) {
    return c.json({ error: 'AI_DAILY_LIMIT', message: 'Dzienny limit zapytań AI wyczerpany — wróć jutro.' }, 429);
  }
  await next();
  if (c.res && c.res.status === 200) usage.set(user.id, { day, n: n + 1 });
}
