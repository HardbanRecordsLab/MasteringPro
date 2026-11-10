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
import { processStripeEvent } from '../services/stripeEvents.js';

export const billingRoutes = new Hono();

// Public catalog — no auth required, so the WordPress pricing page (or any
// future in-app pricing screen) can fetch it directly.
billingRoutes.get('/packs', async (c) => {
  return c.json({
    packs: await Promise.all(Object.values(CREDIT_PACKS).map(packToPublicDict)),
    stripe_enabled: stripeConfigured(),
    currency: 'usd',
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

// UI language shared across *.hardbanrecordslab.online (cookie hrl_lang), English by default.
const requestLang = (c) => (/(?:^|;\s*)hrl_lang=pl/.test(c.req.header('cookie') || '') ? 'pl' : 'en');

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

  const lang = requestLang(c);
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
      // same metadata on the payment itself, so a refund can be traced back to the user
      payment_intent_data: {
        description: lang === 'pl' ? `MasteringPro — ${pack.credits} utworów` : `MasteringPro — ${pack.credits} credits`,
        metadata: { user_id: user.id, pack_id: pack.id, credits: String(pack.credits) },
      },
      locale: lang,
      custom_text: {
        submit: {
          message:
            lang === 'pl'
              ? 'Kupując, wyraźnie zgadzasz się na natychmiastowe dostarczenie kredytów (treść cyfrowa) i przyjmujesz do wiadomości, że po ich wykorzystaniu tracisz prawo odstąpienia od umowy. Kredyty nie wygasają.'
              : 'By purchasing you expressly agree to immediate delivery of the credits (digital content) and acknowledge that once they are used you lose the right of withdrawal. Credits do not expire.',
        },
      },
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

  const result = await processStripeEvent(getDb(), event);
  return c.json(result.body, result.status ?? 200);
});
