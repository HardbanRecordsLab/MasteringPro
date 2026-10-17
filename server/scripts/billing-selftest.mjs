/**
 * Stripe webhook processing against an in-memory PGlite database.
 *   node scripts/billing-selftest.mjs
 * Covers: grant, duplicate + concurrent delivery, delayed payment methods, full/partial refund, bad metadata.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { processStripeEvent } from '../src/services/stripeEvents.js';
import { chargeExports } from '../src/services/exportCredits.js';

const migDir = fileURLToPath(new URL('../drizzle', import.meta.url));
const pg = new PGlite();
const sql = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(`${migDir}/${f}`, 'utf8')).join('\n');
for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt.trim());
const db = drizzle(pg, { schema });

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) failed++; };
const credits = async (id) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0].credits;

const [u] = await db.insert(schema.users).values({ email: 'a@b.com', passwordHash: 'x' }).returning();
ok((await credits(u.id)) === 3, 'new account starts with the 3 free credits');

const checkout = (type, id, over = {}) => ({
  type,
  data: { object: { id, payment_status: 'paid', payment_intent: 'pi_' + id, amount_total: 3900, currency: 'usd',
    client_reference_id: u.id, metadata: { user_id: u.id, pack_id: 'ten', credits: '10' }, ...over } },
});

let r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_1'));
ok(r.body.status === 'success' && (await credits(u.id)) === 13, 'paid checkout grants the pack (3 + 10)');

r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_1'));
ok(r.body.status === 'already_processed' && (await credits(u.id)) === 13, 'the same event delivered again grants nothing');

const burst = await Promise.all(Array.from({ length: 6 }, () => processStripeEvent(db, checkout('checkout.session.completed', 'cs_2'))));
ok(burst.filter((x) => x.body.status === 'success').length === 1 && (await credits(u.id)) === 23, 'six simultaneous deliveries grant exactly once');

r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_3', { payment_status: 'unpaid' }));
ok(r.body.status === 'waiting' && (await credits(u.id)) === 23, 'unpaid (delayed method) completed → waits, no credits');
r = await processStripeEvent(db, checkout('checkout.session.async_payment_succeeded', 'cs_3'));
ok(r.body.status === 'success' && (await credits(u.id)) === 33, 'async_payment_succeeded → credits granted');

const charge = (pi, amount, refunded) => ({ type: 'charge.refunded', data: { object: { payment_intent: pi, amount, amount_refunded: refunded } } });
r = await processStripeEvent(db, charge('pi_cs_3', 3900, 1500));
ok(r.body.status === 'ignored' && (await credits(u.id)) === 33, 'partial refund leaves credits (manual decision)');
r = await processStripeEvent(db, charge('pi_cs_3', 3900, 3900));
ok(r.body.status === 'refunded' && (await credits(u.id)) === 23, 'full refund takes the pack back');
r = await processStripeEvent(db, charge('pi_cs_3', 3900, 3900));
ok(r.body.status === 'ignored' && (await credits(u.id)) === 23, 'refund event repeated → nothing more is taken');

await db.update(schema.users).set({ credits: 5 }).where(eq(schema.users.id, u.id));
r = await processStripeEvent(db, charge('pi_cs_1', 3900, 3900));
ok((await credits(u.id)) === 0, 'refund after the credits were spent never goes below zero');

r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_4', { client_reference_id: '00000000-0000-0000-0000-000000000000', metadata: { user_id: '00000000-0000-0000-0000-000000000000', credits: '20' } }));
ok(r.status === 404, 'unknown user → 404 (Stripe retries, nothing granted)');
r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_5', { client_reference_id: null, metadata: {} }));
ok(r.status === 400, 'missing metadata → 400');
r = await processStripeEvent(db, { type: 'customer.created', data: { object: {} } });
ok(r.body.status === 'ignored', 'unrelated events are ignored');

// ── export charging: 1 credit = 1 track, 3 days free re-export, album batch all-or-nothing ──
const [v] = await db.insert(schema.users).values({ email: 'v@b.com', passwordHash: 'x' }).returning();   // 3 free credits
const t0 = new Date('2026-10-20T10:00:00Z');
const day = 86400_000;
let c = await chargeExports(db, v.id, [{ key: 'song-A|1|1' }], t0);
ok(c.ok && c.charged === 1 && c.credits === 2, 'first export of a track costs 1 credit');
c = await chargeExports(db, v.id, [{ key: 'song-A|1|1' }], new Date(t0.getTime() + 2 * day));
ok(c.ok && c.charged === 0 && c.covered === 1 && c.credits === 2, 'same track again after 2 days is free (other format / fixes)');
c = await chargeExports(db, v.id, [{ key: 'song-A|1|1' }], new Date(t0.getTime() + 3 * day + 1000));
ok(c.ok && c.charged === 1 && c.credits === 1, 'after 3 days the same track is charged again');
c = await chargeExports(db, v.id, [{ key: 'x1' }, { key: 'x2' }, { key: 'x3' }], new Date(t0.getTime() + 3 * day + 2000));
ok(!c.ok && c.needed === 3 && c.credits === 1, 'album needing 3 credits with 1 left is refused…');
ok((await credits(v.id)) === 1, '…and nothing is charged (all-or-nothing)');
c = await chargeExports(db, v.id, [{ key: 'song-A|1|1' }, { key: 'song-A|1|1' }, { key: 'x1' }], new Date(t0.getTime() + 3 * day + 3000));
ok(c.ok && c.charged === 1 && c.covered === 1 && c.credits === 0, 'duplicates inside one request count once; already-paid tracks are covered');
const [w] = await db.insert(schema.users).values({ email: 'w@b.com', passwordHash: 'x' }).returning();
await db.update(schema.users).set({ credits: 16 }).where(eq(schema.users.id, w.id));
const sixteen = Array.from({ length: 16 }, (_, i) => ({ key: 'album-' + i }));
c = await chargeExports(db, w.id, sixteen, t0);
ok(c.ok && c.charged === 16 && c.credits === 0, 'a 16-track album costs 16 credits (the album pack)');
const [z] = await db.insert(schema.users).values({ email: 'z@b.com', passwordHash: 'x' }).returning();
await db.update(schema.users).set({ credits: 1 }).where(eq(schema.users.id, z.id));
const race = await Promise.all(Array.from({ length: 5 }, (_, i) => chargeExports(db, z.id, [{ key: 'race-' + i }], t0)));
ok(race.filter((r) => r.ok).length === 1 && (await credits(z.id)) === 0, 'five simultaneous exports with 1 credit: exactly one succeeds, balance never negative');

console.log(failed ? `\n${failed} FAILED` : '\nall billing checks passed');
process.exit(failed ? 1 : 0);
