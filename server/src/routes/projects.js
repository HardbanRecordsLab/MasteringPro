import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { requireUser } from '../auth.js';

export const projectRoutes = new Hono();
projectRoutes.use('*', requireUser);

const jsonObj = z.record(z.string(), z.unknown());

const projectInput = z.object({
  title: z.string().min(1).max(200),
  sourceName: z.string().max(400).optional(),
  sourceSampleRate: z.number().int().positive().optional(),
  sourceChannels: z.number().int().min(1).max(8).optional(),
  sourceDurationS: z.number().nonnegative().optional(),
  sourceHash: z.string().max(128).optional(),
});

const versionInput = z.object({
  label: z.string().max(120).optional(),
  chainParams: jsonObj,
  analysis: jsonObj.optional(),
  targetPlatform: z.string().max(60).optional(),
  targetLufs: z.number().optional(),
  targetTp: z.number().optional(),
  aiConfig: jsonObj.optional(),
  aiReport: jsonObj.optional(),
});

const ownedProject = async (db, userId, id) => {
  const [p] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.userId, userId))).limit(1);
  return p ?? null;
};

projectRoutes.get('/', async (c) => {
  const db = getDb();
  const rows = await db.select().from(schema.projects)
    .where(eq(schema.projects.userId, c.get('user').id))
    .orderBy(desc(schema.projects.updatedAt))
    .limit(200);
  return c.json({ projects: rows });
});

projectRoutes.post('/', async (c) => {
  const body = projectInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid project' }, 400);
  const db = getDb();
  const [row] = await db.insert(schema.projects)
    .values({ ...body.data, userId: c.get('user').id }).returning();
  return c.json({ project: row }, 201);
});

projectRoutes.get('/:id', async (c) => {
  const db = getDb();
  const project = await ownedProject(db, c.get('user').id, c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);
  const versions = await db.select().from(schema.projectVersions)
    .where(eq(schema.projectVersions.projectId, project.id))
    .orderBy(desc(schema.projectVersions.createdAt));
  return c.json({ project, versions });
});

projectRoutes.patch('/:id', async (c) => {
  const db = getDb();
  const project = await ownedProject(db, c.get('user').id, c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);
  const body = z.object({ title: z.string().min(1).max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid' }, 400);
  const [row] = await db.update(schema.projects)
    .set({ title: body.data.title, updatedAt: new Date() })
    .where(eq(schema.projects.id, project.id)).returning();
  return c.json({ project: row });
});

projectRoutes.delete('/:id', async (c) => {
  const db = getDb();
  const project = await ownedProject(db, c.get('user').id, c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);
  await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  return c.json({ ok: true });
});

projectRoutes.post('/:id/versions', async (c) => {
  const db = getDb();
  const project = await ownedProject(db, c.get('user').id, c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);
  const body = versionInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid version' }, 400);
  const [row] = await db.insert(schema.projectVersions)
    .values({ ...body.data, projectId: project.id }).returning();
  await db.update(schema.projects).set({ updatedAt: new Date() })
    .where(eq(schema.projects.id, project.id));
  return c.json({ version: row }, 201);
});
