/**
 * DB layer self-test against an in-memory PGlite instance.
 *   node scripts/db-selftest.mjs
 * Exercises the generated migration + the auth/project query paths so schema
 * mistakes surface without a live Postgres.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../src/auth.js';
import * as schema from '../src/db/schema.js';

const migDir = fileURLToPath(new URL('../drizzle', import.meta.url));

const pg = new PGlite();
const sql = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(`${migDir}/${f}`, 'utf8')).join('\n');

for (const stmt of sql.split('--> statement-breakpoint')) {
  const s = stmt.trim();
  if (s) await pg.exec(s);
}
console.log('✓ migration applied');

const db = drizzle(pg, { schema });

// register
const hash = await hashPassword('correct horse battery');
const [user] = await db.insert(schema.users)
  .values({ email: 'a@b.com', passwordHash: hash, displayName: 'A' }).returning();
console.log('✓ user created', user.id.slice(0, 8), 'plan=' + user.plan);

// verify password
if (!(await verifyPassword(user.passwordHash, 'correct horse battery'))) throw new Error('pw verify failed');
if (await verifyPassword(user.passwordHash, 'wrong')) throw new Error('pw verify false-positive');
console.log('✓ argon2id verify ok');

// session
await db.insert(schema.sessions).values({
  userId: user.id, tokenHash: 'x'.repeat(64), expiresAt: new Date(Date.now() + 1e6),
});
const sess = await db.select().from(schema.sessions)
  .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
  .where(eq(schema.sessions.tokenHash, 'x'.repeat(64)));
if (sess.length !== 1) throw new Error('session join failed');
console.log('✓ session join ok');

// project + version + render + cascade
const [proj] = await db.insert(schema.projects)
  .values({ userId: user.id, title: 'Track 1', sourceSampleRate: 48000, sourceChannels: 2, sourceDurationS: 210 })
  .returning();
const [ver] = await db.insert(schema.projectVersions)
  .values({ projectId: proj.id, label: 'A', chainParams: { inputGain: 0, limiterCeiling: -1 }, targetLufs: -14 })
  .returning();
await db.insert(schema.renders)
  .values({ projectVersionId: ver.id, format: 'wav24', integratedLufs: -14.1, truePeakDb: -1 });
console.log('✓ project/version/render inserted, chainParams=', JSON.stringify(ver.chainParams));

// preset (factory + user)
await db.insert(schema.presets).values({ name: 'Factory Loud', chainParams: {}, isFactory: true });
await db.insert(schema.presets).values({ userId: user.id, name: 'Mine', chainParams: {} });
const presets = await db.select().from(schema.presets);
console.log('✓ presets:', presets.length);

// album
const [album] = await db.insert(schema.albums).values({ userId: user.id, title: 'LP', targetLufs: -14 }).returning();
await db.insert(schema.albumTracks).values({ albumId: album.id, projectId: proj.id, position: 0, gapS: 3 });
console.log('✓ album + track');

// cascade delete
await db.delete(schema.users).where(eq(schema.users.id, user.id));
const left = await Promise.all([
  db.select().from(schema.projects),
  db.select().from(schema.projectVersions),
  db.select().from(schema.renders),
  db.select().from(schema.sessions),
  db.select().from(schema.albumTracks),
]);
if (left.some((r) => r.length)) throw new Error('cascade delete left orphans');
console.log('✓ cascade delete clean');

await pg.close();
console.log('\nALL DB SELF-TESTS PASSED');
