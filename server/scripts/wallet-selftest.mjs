/**
 * MasteringPro with HRL Wallet switched on, against an in-memory PGlite database and an in-memory fake wallet.
 *   node scripts/wallet-selftest.mjs
 * Covers: one sign-up for all HRL apps, credits shown in tracks (1 track = 9 wallet credits), the 3 free tracks of the start grant,
 * the export charge (3-day window, album all-or-nothing, a double click charges once), checkout and history through the wallet,
 * a wallet that is down, operator accounts on the old local credits, and the flag off.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

process.env.WALLET_ENABLED = 'true';
process.env.WALLET_URL = 'http://wallet.test';
process.env.WALLET_TOKEN = 'test-token';
process.env.EXPORT_METERING = 'true';
process.env.ADMIN_EMAILS = 'boss@example.com';

const { Hono } = await import('hono');
const schema = await import('../src/db/schema.js');
const { setDbForTests } = await import('../src/db/index.js');
const { loadUser, hashPassword } = await import('../src/auth.js');
const { authRoutes } = await import('../src/routes/auth.js');
const { creditsRoutes } = await import('../src/routes/credits.js');
const { billingRoutes } = await import('../src/routes/billing.js');
const { config } = await import('../src/config.js');

const migDir = fileURLToPath(new URL('../drizzle', import.meta.url));
const pg = new PGlite();
const sql = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(`${migDir}/${f}`, 'utf8')).join('\n');
for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt.trim());
const db = drizzle(pg, { schema });
setDbForTests(db);

// ── the fake wallet (the real one has its own suite in the HRL-Wallet repo) ──
const COST = 9;
const fake = { accounts: new Map(), keys: new Map(), windows: new Set(), down: false, checkouts: [] };
const seed = (email, pw, credits = 30) => { const a = { id: 'acc_' + fake.accounts.size, pw, credits }; fake.accounts.set(email, a); return a; };
const byId = (id) => [...fake.accounts.values()].find((a) => a.id === id);
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  if (fake.down) throw new Error('connect ECONNREFUSED');
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : {};
  const path = u.pathname;
  if (path === '/v1/accounts/register') {
    if (fake.accounts.has(body.email)) return reply(409, { ok: false, error: 'email_taken' });
    const a = seed(body.email, body.password);
    return reply(201, { ok: true, account_id: a.id, credits: a.credits });
  }
  if (path === '/v1/accounts/login') {
    const a = fake.accounts.get(body.email);
    if (!a || a.pw !== body.password) return reply(401, { ok: false, error: 'bad_credentials' });
    return reply(200, { ok: true, account_id: a.id, credits: a.credits });
  }
  const bal = path.match(/^\/v1\/wallet\/([^/]+)\/balance$/);
  if (bal) { const a = byId(bal[1]); return reply(200, { ok: true, credits: a.credits, unlimited: false, units: Math.floor(a.credits / COST), cost: COST }); }
  const pur = path.match(/^\/v1\/wallet\/([^/]+)\/purchases$/);
  if (pur) return reply(200, { ok: true, purchases: [{ id: 'cs_9', pack_id: 'ten', credits: 90, amount_cents: 4900, currency: 'usd', created_at: '2026-10-31T00:00:00+00:00' }] });
  if (path === '/v1/wallet/charge') {
    const a = byId(body.account_id);
    if (fake.keys.has(body.idempotency_key)) return reply(200, { ...fake.keys.get(body.idempotency_key), replayed: true });
    const fresh = body.tracks.filter((t) => !fake.windows.has(a.id + '|' + t.key));
    if (a.credits < fresh.length * COST) return reply(402, { ok: false, error: 'insufficient_credits', needed: fresh.length * COST, credits: a.credits });
    a.credits -= fresh.length * COST;
    for (const t of fresh) fake.windows.add(a.id + '|' + t.key);
    const out = { ok: true, charged_credits: fresh.length * COST, charged_units: fresh.length, covered: body.tracks.length - fresh.length, credits: a.credits, covered_until: '2026-11-03T00:00:00+00:00', replayed: false };
    fake.keys.set(body.idempotency_key, out);
    return reply(200, out);
  }
  if (path === '/v1/checkout') { fake.checkouts.push(body); return reply(200, { ok: true, checkout_url: 'https://checkout.stripe.test/c1', session_id: 'cs_c1' }); }
  throw new Error('unexpected wallet call ' + path);
};

const app = new Hono();
app.use('*', loadUser);
app.route('/api/auth', authRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/credits', creditsRoutes);

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) failed++; };
const post = (path, body, cookie) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const get = (path, cookie) => app.request(path, { headers: cookie ? { cookie } : {} });
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const PW = 'correct horse battery';
const track = (k) => ({ key: k, label: k });

// 1. sign-up
let r = await post('/api/auth/register', { email: 'new@example.com', password: PW });
let j = await r.json();
const ck = cookieOf(r);
ok(r.status === 201 && j.user.credits === 3, 'sign-up creates the wallet account: the start grant (30 credits) shows as the 3 free tracks');
const [lu] = await db.select().from(schema.users).where(eq(schema.users.email, 'new@example.com'));
ok(lu.walletAccountId === fake.accounts.get('new@example.com').id && lu.credits === 0, 'the local user is linked to the wallet account and holds no credits of its own');
ok((await (await get('/api/auth/me', ck)).json()).user.credits === 3, '/me reads the balance from the wallet, in tracks');

// 2. login through the wallet
r = await post('/api/auth/login', { email: 'new@example.com', password: 'wrong password!' });
ok(r.status === 401, 'wrong password is refused by the wallet');
fake.accounts.get('new@example.com').pw = 'changed in metadata engine';
r = await post('/api/auth/login', { email: 'new@example.com', password: PW });
ok(r.status === 401, 'the password changed in the other app no longer works here');
r = await post('/api/auth/login', { email: 'new@example.com', password: 'changed in metadata engine' });
ok(r.status === 200, 'the new password works here too (one account for all HRL apps)');
ok((await import('../src/auth.js')).verifyPassword((await db.select().from(schema.users).where(eq(schema.users.email, 'new@example.com')))[0].passwordHash, 'changed in metadata engine'), 'the local copy of the hash follows');
const ck2 = cookieOf(r);

// 3. exports
r = await post('/api/credits/export', { tracks: [track('song-A')] }, ck2);
j = await r.json();
ok(r.status === 200 && j.charged === 1 && j.credits === 2, 'first export of a track: 1 track (9 credits) charged, 2 tracks left');
r = await post('/api/credits/export', { tracks: [track('song-A')] }, ck2);
j = await r.json();
ok(j.charged === 0 && j.covered === 1 && j.credits === 2, 'the same track again inside its window is free');
const [a1, a2] = await Promise.all([post('/api/credits/export', { tracks: [track('song-B')] }, ck2), post('/api/credits/export', { tracks: [track('song-B')] }, ck2)]);
const bj = [await a1.json(), await a2.json()];
ok(fake.accounts.get('new@example.com').credits === 30 - 18 && bj.every((x) => x.credits === 1), 'a double click on the same export charges once');
r = await post('/api/credits/export', { tracks: [track('x1'), track('x2'), track('x3')] }, ck2);
j = await r.json();
ok(r.status === 402 && j.error === 'CREDITS_EXHAUSTED' && j.needed === 3 && j.credits === 1, 'an album needing 3 tracks with 1 left is refused in tracks (needed 3, have 1)…');
ok(fake.accounts.get('new@example.com').credits === 12, '…and nothing was charged');

// 4. checkout and history
r = await post('/api/billing/checkout', { pack_id: 'ten' }, ck2);
j = await r.json();
ok(r.status === 200 && j.checkout_url.startsWith('https://checkout.stripe.test/') && fake.checkouts[0].pack_id === 'ten' && fake.checkouts[0].account_id === fake.accounts.get('new@example.com').id, 'checkout is created by the wallet for the pack the user chose');
ok((await post('/api/billing/checkout', { pack_id: 'nope' }, ck2)).status === 400, 'an unknown pack is refused');
j = await (await get('/api/billing/history', ck2)).json();
ok(j.purchases[0].credits_added === 10 && j.purchases[0].amount_total === 4900, 'history shows the wallet purchase in tracks (10) with the real amount');

// 5. the same person in the second app
seed('both@example.com', PW, 12);
r = await post('/api/auth/register', { email: 'both@example.com', password: PW });
j = await r.json();
ok(r.status === 201 && j.user.credits === 1, 'an e-mail already in HRL Wallet is linked, not given a second start grant (12 credits = 1 track)');
seed('other@example.com', 'another password 1', 12);
r = await post('/api/auth/register', { email: 'other@example.com', password: PW });
ok(r.status === 409 && (await r.json()).error.includes('different password'), 'the same e-mail with another password is refused with an explanation');

// 6. the wallet is down: nothing is guessed
fake.down = true;
r = await post('/api/credits/export', { tracks: [track('song-Z')] }, ck2);
ok(r.status === 503, 'export while the wallet is down → 503, not a free export');
r = await post('/api/auth/login', { email: 'new@example.com', password: 'changed in metadata engine' });
ok(r.status === 503, 'sign-in while the wallet is down → 503');
j = await (await get('/api/auth/me', ck2)).json();
ok(j.user.credits_unavailable === true, '/me still answers and says the balance is unavailable');
fake.down = false;

// 7. operator accounts keep the old path
await db.insert(schema.users).values({ email: 'boss@example.com', passwordHash: await hashPassword(PW), plan: 'pro' });
r = await post('/api/auth/login', { email: 'boss@example.com', password: PW });
ok(r.status === 200 && (await r.json()).user.credits === 3, 'an operator account (not linked) signs in with the local hash and keeps local credits');
const bossCk = cookieOf(r);
r = await post('/api/credits/export', { tracks: [track('s')] }, bossCk);
ok(r.status === 200 && (await r.json()).charged === 0, 'an operator export is never charged');

// 8. flag off
config.wallet.enabled = false;
r = await post('/api/auth/register', { email: 'local@example.com', password: PW });
j = await r.json();
const [loc] = await db.select().from(schema.users).where(eq(schema.users.email, 'local@example.com'));
ok(r.status === 201 && j.user.credits === 3 && loc.walletAccountId === null, 'with the flag off a new account is the old local one (3 credits, no wallet)');
r = await post('/api/auth/login', { email: 'new@example.com', password: 'changed in metadata engine' });
ok(r.status === 200, 'with the flag off a wallet-era account still signs in (local copy of the hash)');

console.log(failed ? `\n${failed} FAILED` : '\nall wallet checks passed');
process.exit(failed ? 1 : 0);
