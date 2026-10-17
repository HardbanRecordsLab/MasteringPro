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
  data: { object: { id, payment_status: 'paid', payment_intent: 'pi_' + id, amount_total: 7900, currency: 'pln',
    client_reference_id: u.id, metadata: { user_id: u.id, pack_id: 'mastering', credits: '20' }, ...over } },
});

let r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_1'));
ok(r.body.status === 'success' && (await credits(u.id)) === 23, 'paid checkout grants the pack (3 + 20)');

r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_1'));
ok(r.body.status === 'already_processed' && (await credits(u.id)) === 23, 'the same event delivered again grants nothing');

const burst = await Promise.all(Array.from({ length: 6 }, () => processStripeEvent(db, checkout('checkout.session.completed', 'cs_2'))));
ok(burst.filter((x) => x.body.status === 'success').length === 1 && (await credits(u.id)) === 43, 'six simultaneous deliveries grant exactly once');

r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_3', { payment_status: 'unpaid' }));
ok(r.body.status === 'waiting' && (await credits(u.id)) === 43, 'unpaid (delayed method) completed → waits, no credits');
r = await processStripeEvent(db, checkout('checkout.session.async_payment_succeeded', 'cs_3'));
ok(r.body.status === 'success' && (await credits(u.id)) === 63, 'async_payment_succeeded → credits granted');

const charge = (pi, amount, refunded) => ({ type: 'charge.refunded', data: { object: { payment_intent: pi, amount, amount_refunded: refunded } } });
r = await processStripeEvent(db, charge('pi_cs_3', 7900, 3000));
ok(r.body.status === 'ignored' && (await credits(u.id)) === 63, 'partial refund leaves credits (manual decision)');
r = await processStripeEvent(db, charge('pi_cs_3', 7900, 7900));
ok(r.body.status === 'refunded' && (await credits(u.id)) === 43, 'full refund takes the pack back');
r = await processStripeEvent(db, charge('pi_cs_3', 7900, 7900));
ok(r.body.status === 'ignored' && (await credits(u.id)) === 43, 'refund event repeated → nothing more is taken');

await db.update(schema.users).set({ credits: 5 }).where(eq(schema.users.id, u.id));
r = await processStripeEvent(db, charge('pi_cs_1', 7900, 7900));
ok((await credits(u.id)) === 0, 'refund after the credits were spent never goes below zero');

r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_4', { client_reference_id: '00000000-0000-0000-0000-000000000000', metadata: { user_id: '00000000-0000-0000-0000-000000000000', credits: '20' } }));
ok(r.status === 404, 'unknown user → 404 (Stripe retries, nothing granted)');
r = await processStripeEvent(db, checkout('checkout.session.completed', 'cs_5', { client_reference_id: null, metadata: {} }));
ok(r.status === 400, 'missing metadata → 400');
r = await processStripeEvent(db, { type: 'customer.created', data: { object: {} } });
ok(r.body.status === 'ignored', 'unrelated events are ignored');

console.log(failed ? `\n${failed} FAILED` : '\nall billing checks passed');
process.exit(failed ? 1 : 0);
