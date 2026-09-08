import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { requireUser } from '../auth.js';

export const renderRoutes = new Hono();
renderRoutes.use('*', requireUser);

const input = z.object({
  projectVersionId: z.string().uuid(),
  format: z.string().max(40),
  sampleRate: z.number().int().positive().optional(),
  integratedLufs: z.number().optional(),
  truePeakDb: z.number().optional(),
  lra: z.number().optional(),
});

// verify the version belongs to a project owned by this user
async function ownsVersion(db, userId, versionId) {
  const rows = await db
    .select({ id: schema.projectVersions.id })
    .from(schema.projectVersions)
    .innerJoin(schema.projects, eq(schema.projectVersions.projectId, schema.projects.id))
    .where(and(eq(schema.projectVersions.id, versionId), eq(schema.projects.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

renderRoutes.post('/', async (c) => {
  const body = input.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid render' }, 400);
  const db = getDb();
  if (!(await ownsVersion(db, c.get('user').id, body.data.projectVersionId))) {
    return c.json({ error: 'Not found' }, 404);
  }
  const [row] = await db.insert(schema.renders).values(body.data).returning();
  return c.json({ render: row }, 201);
});

renderRoutes.get('/', async (c) => {
  const versionId = c.req.query('versionId');
  if (!versionId) return c.json({ error: 'versionId required' }, 400);
  const db = getDb();
  if (!(await ownsVersion(db, c.get('user').id, versionId))) return c.json({ renders: [] });
  const rows = await db.select().from(schema.renders)
    .where(eq(schema.renders.projectVersionId, versionId))
    .orderBy(desc(schema.renders.renderedAt));
  return c.json({ renders: rows });
});
