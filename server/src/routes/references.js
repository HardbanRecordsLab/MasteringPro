import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { requireUser } from '../auth.js';

export const referenceRoutes = new Hono();
referenceRoutes.use('*', requireUser);

const input = z.object({
  name: z.string().min(1).max(120),
  spectrum: z.record(z.string(), z.unknown()),
  loudness: z.record(z.string(), z.unknown()),
});

referenceRoutes.get('/', async (c) => {
  const db = getDb();
  const rows = await db.select().from(schema.referenceProfiles)
    .where(eq(schema.referenceProfiles.userId, c.get('user').id))
    .orderBy(desc(schema.referenceProfiles.createdAt));
  return c.json({ references: rows });
});

referenceRoutes.post('/', async (c) => {
  const body = input.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid reference profile' }, 400);
  const db = getDb();
  const [row] = await db.insert(schema.referenceProfiles)
    .values({ ...body.data, userId: c.get('user').id }).returning();
  return c.json({ reference: row }, 201);
});

referenceRoutes.delete('/:id', async (c) => {
  const db = getDb();
  const res = await db.delete(schema.referenceProfiles)
    .where(and(
      eq(schema.referenceProfiles.id, c.req.param('id')),
      eq(schema.referenceProfiles.userId, c.get('user').id),
    ))
    .returning({ id: schema.referenceProfiles.id });
  if (!res.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
