import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  sessionCookie, clearCookie, requireUser, userPayload, isWalletUser,
} from '../auth.js';
import { wallet, walletEnabled, registerOrLink, accountError } from '../services/wallet.js';

export const authRoutes = new Hono();

const credentials = z.object({
  email: z.string().email().max(200).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(80).optional(),
});

authRoutes.post('/register', async (c) => {
  const body = credentials.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid email or password (min 8 chars)' }, 400);
  const db = getDb();

  const exists = await db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.email, body.data.email)).limit(1);
  if (exists.length) return c.json({ error: 'That email is already registered' }, 409);

  let walletAccountId = null;
  if (walletEnabled()) {
    try {
      walletAccountId = await registerOrLink(body.data.email, body.data.password);
    } catch (e) {
      const [err, status] = accountError(e);
      return c.json(err, status);
    }
  }

  const [user] = await db.insert(schema.users).values({
    email: body.data.email,
    passwordHash: await hashPassword(body.data.password),   // a local copy even for wallet accounts, so switching the flag off stays safe
    displayName: body.data.displayName ?? null,
    walletAccountId,
    ...(walletAccountId ? { credits: 0 } : {}),
  }).returning();

  const { token, expiresAt } = await createSession(user.id, c.req.header('user-agent'));
  c.header('Set-Cookie', sessionCookie(token, expiresAt));
  return c.json({ user: await userPayload(user) }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = credentials.pick({ email: true, password: true })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid credentials' }, 400);
  const db = getDb();

  const [user] = await db.select().from(schema.users)
    .where(eq(schema.users.email, body.data.email)).limit(1);
  if (isWalletUser(user)) {
    // the password lives in HRL Wallet (it may have been changed in another HRL app); keep the local copy in step
    try {
      await wallet.login(body.data.email, body.data.password);
    } catch (e) {
      const [err, status] = accountError(e);
      return c.json(err, status);
    }
    if (!(await verifyPassword(user.passwordHash, body.data.password))) {
      await db.update(schema.users).set({ passwordHash: await hashPassword(body.data.password) }).where(eq(schema.users.id, user.id));
    }
  } else {
    const ok = user && (await verifyPassword(user.passwordHash, body.data.password));
    if (!ok) return c.json({ error: 'Wrong email or password' }, 401);
  }

  const { token, expiresAt } = await createSession(user.id, c.req.header('user-agent'));
  c.header('Set-Cookie', sessionCookie(token, expiresAt));
  return c.json({ user: await userPayload(user) });
});

authRoutes.post('/logout', async (c) => {
  await destroySession(c.get('token'));
  c.header('Set-Cookie', clearCookie());
  return c.json({ ok: true });
});

authRoutes.get('/me', requireUser, async (c) => c.json({ user: await userPayload(c.get('user')) }));
