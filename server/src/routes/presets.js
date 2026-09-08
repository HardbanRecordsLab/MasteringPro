import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, or, isNull, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { requireUser } from '../auth.js';

export const presetRoutes = new Hono();
presetRoutes.use('*', requireUser);

const input = z.object({
  name: z.string().min(1).max(120),
  genre: z.string().max(60).optional(),
  chainParams: z.record(z.string(), z.unknown()),
});

// factory presets (user_id null) + this user's own
presetRoutes.get('/', async (c) => {
  const db = getDb();
  const rows = await db.select().from(schema.presets)
    .where(or(isNull(schema.presets.userId), eq(schema.presets.userId, c.get('user').id)))
    .orderBy(desc(schema.presets.isFactory), desc(schema.presets.createdAt));
  return c.json({ presets: rows });
});

presetRoutes.post('/', async (c) => {
  const body = input.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid preset' }, 400);
  const db = getDb();
  const [row] = await db.insert(schema.presets)
    .values({ ...body.data, userId: c.get('user').id, isFactory: false }).returning();
  return c.json({ preset: row }, 201);
});

presetRoutes.delete('/:id', async (c) => {
  const db = getDb();
  const res = await db.delete(schema.presets)
    .where(and(eq(schema.presets.id, c.req.param('id')), eq(schema.presets.userId, c.get('user').id)))
    .returning({ id: schema.presets.id });
  if (!res.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
