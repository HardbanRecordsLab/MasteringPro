import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import {
  CREDIT_PACKS,
  getStripe,
  packPriceId,
  packToPublicDict,
  stripeConfigured,
} from '../services/stripeBilling.js';

export const billingRoutes = new Hono();

// Public catalog — no auth required, so the WordPress pricing page (or any
// future in-app pricing screen) can fetch it directly.
billingRoutes.get('/packs', (c) => {
  return c.json({
    packs: Object.values(CREDIT_PACKS).map(packToPublicDict),
    stripe_enabled: stripeConfigured(),
    currency: 'pln',
  });
});

billingRoutes.get('/history', requireUser, async (c) => {
  const user = c.get('user');
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.creditPurchases)
    .where(eq(schema.creditPurchases.userId, user.id))
    .orderBy(sql`${schema.creditPurchases.createdAt} desc`);
  return c.json({
    purchases: rows.map((p) => ({
      id: p.stripeSessionId,
      pack_id: p.packId,
      credits_added: p.creditsAdded,
      amount_total: p.amountTotal,
      currency: p.currency,
      created_at: p.createdAt,
    })),
  });
});

billingRoutes.post('/checkout', requireUser, async (c) => {
  if (!config.stripe.secretKey) {
    return c.json(
      { error: 'Payments are not configured. Add STRIPE_SECRET_KEY and pack Price IDs on the server.' },
      503,
    );
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const pack = CREDIT_PACKS[body?.pack_id];
  if (!pack) return c.json({ error: 'Unknown credit pack' }, 400);

  const priceId = packPriceId(pack);
  if (!priceId) {
    return c.json(
      { error: `Stripe price not configured for pack '${pack.id}'. Set ${pack.envPriceKey} on the server.` },
      503,
    );
  }

  const user = c.get('user');
  const successUrl =
    config.stripe.successUrl ||
    'https://masteringpro.hardbanrecordslab.online/?billing=success&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = config.stripe.cancelUrl || 'https://masteringpro.hardbanrecordslab.online/?billing=cancelled';

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { user_id: user.id, pack_id: pack.id, credits: String(pack.credits) },
    });
    return c.json({ checkout_url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[billing] Stripe checkout error:', e.message);
    return c.json({ error: 'Could not create checkout session' }, 502);
  }
});

// Stripe webhooks need the raw body for signature verification — Hono's
// c.req.text() gives the unparsed body, which is what we need here.
billingRoutes.post('/webhook/stripe', async (c) => {
  if (!config.stripe.webhookSecret) {
    return c.json({ error: 'Stripe webhook secret not configured' }, 503);
  }

  const payload = await c.req.text();
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'Missing Stripe-Signature header' }, 400);

  let event;
  try {
    event = getStripe().webhooks.constructEvent(payload, sig, config.stripe.webhookSecret);
  } catch (e) {
    return c.json({ error: 'Invalid signature: ' + e.message }, 400);
  }

  if (event.type !== 'checkout.session.completed') {
    return c.json({ status: 'ignored', type: event.type });
  }

  const session = event.data.object;
  if (session.payment_status !== 'paid') {
    return c.json({ status: 'ignored', reason: 'not paid' });
  }

  const db = getDb();
  const existing = await db
    .select()
    .from(schema.creditPurchases)
    .where(eq(schema.creditPurchases.stripeSessionId, session.id))
    .limit(1);
  if (existing.length) {
    return c.json({ status: 'already_processed', session_id: session.id });
  }

  const metadata = session.metadata || {};
  const userId = metadata.user_id || session.client_reference_id;
  const packId = metadata.pack_id || 'starter';
  let creditsToAdd = parseInt(metadata.credits, 10) || 0;
  if (creditsToAdd <= 0) creditsToAdd = CREDIT_PACKS[packId]?.credits || 0;

  if (!userId || creditsToAdd <= 0) {
    console.error('[billing] Webhook missing user_id or credits:', metadata);
    return c.json({ error: 'Invalid session metadata' }, 400);
  }

  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!userRows.length) {
    console.warn('[billing] Stripe webhook: user %s not found', userId);
    return c.json({ error: 'User not found' }, 404);
  }

  await db
    .update(schema.users)
    .set({ credits: sql`${schema.users.credits} + ${creditsToAdd}` })
    .where(eq(schema.users.id, userId));

  await db.insert(schema.creditPurchases).values({
    userId,
    stripeSessionId: session.id,
    packId,
    creditsAdded: creditsToAdd,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
  });

  console.log(`[billing] Stripe: added ${creditsToAdd} credits to user ${userId} (pack=${packId})`);
  return c.json({ status: 'success', credits_added: creditsToAdd, user_id: userId });
});
