import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, asc, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { requireUser } from '../auth.js';

export const albumRoutes = new Hono();
albumRoutes.use('*', requireUser);

const ownedAlbum = async (db, userId, id) => {
  const [a] = await db.select().from(schema.albums)
    .where(and(eq(schema.albums.id, id), eq(schema.albums.userId, userId))).limit(1);
  return a ?? null;
};

albumRoutes.get('/', async (c) => {
  const db = getDb();
  const rows = await db.select().from(schema.albums)
    .where(eq(schema.albums.userId, c.get('user').id))
    .orderBy(desc(schema.albums.createdAt));
  return c.json({ albums: rows });
});

albumRoutes.post('/', async (c) => {
  const body = z.object({
    title: z.string().min(1).max(200),
    targetLufs: z.number().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid album' }, 400);
  const db = getDb();
  const [row] = await db.insert(schema.albums)
    .values({ ...body.data, userId: c.get('user').id }).returning();
  return c.json({ album: row }, 201);
});

albumRoutes.get('/:id', async (c) => {
  const db = getDb();
  const album = await ownedAlbum(db, c.get('user').id, c.req.param('id'));
  if (!album) return c.json({ error: 'Not found' }, 404);
  const tracks = await db.select().from(schema.albumTracks)
    .where(eq(schema.albumTracks.albumId, album.id))
    .orderBy(asc(schema.albumTracks.position));
  return c.json({ album, tracks });
});

albumRoutes.put('/:id/tracks', async (c) => {
  const db = getDb();
  const album = await ownedAlbum(db, c.get('user').id, c.req.param('id'));
  if (!album) return c.json({ error: 'Not found' }, 404);
  const body = z.object({
    tracks: z.array(z.object({
      projectId: z.string().uuid(),
      position: z.number().int().min(0),
      gapS: z.number().min(0).max(30).default(2),
    })).max(50),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid track list' }, 400);

  // verify every project belongs to the user
  const userProjects = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(eq(schema.projects.userId, c.get('user').id));
  const owned = new Set(userProjects.map((p) => p.id));
  if (body.data.tracks.some((t) => !owned.has(t.projectId))) {
    return c.json({ error: 'Album can only contain your own projects' }, 400);
  }

  await db.transaction(async (tx) => {
    await tx.delete(schema.albumTracks).where(eq(schema.albumTracks.albumId, album.id));
    if (body.data.tracks.length) {
      await tx.insert(schema.albumTracks)
        .values(body.data.tracks.map((t) => ({ ...t, albumId: album.id })));
    }
  });
  return c.json({ ok: true });
});
