// Stripe billing — ONE paid level for everyone: a single one-time pack of tracks. No subscription, no auto-renewal,
// no card-on-file trial; credits never expire. The price lives in Stripe (the Price object is the single source of truth,
// so changing the price never needs a deploy); only the number of tracks per pack is configured here (PACK_CREDITS).
// Same Stripe account/keys as Metadata Engine, so payments and payouts land in one place.
import Stripe from 'stripe';
import { config } from '../config.js';

export const PACK_CREDITS = Math.max(1, parseInt(process.env.PACK_CREDITS || '', 10) || 20);

export const CREDIT_PACKS = {
  mastering: {
    id: 'mastering',
    name: 'Pakiet MasteringPro',
    credits: PACK_CREDITS,
    description: `${PACK_CREDITS} utworów do masteringu. Bez abonamentu, bez odnawiania, kredyty nie wygasają.`,
    popular: false,
    envPriceKey: 'STRIPE_PRICE_PACK',
  },
};

export function stripeConfigured() {
  return Boolean(config.stripe.secretKey && config.stripe.webhookSecret);
}

let stripeClient = null;
export function getStripe() {
  if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  if (!stripeClient) stripeClient = new Stripe(config.stripe.secretKey);
  return stripeClient;
}

export function packPriceId(pack) {
  return pack.envPriceKey ? process.env[pack.envPriceKey] || '' : '';
}

// Price object cache (10 min) — the amount shown in the app is always the amount Stripe will charge.
const priceCache = new Map();
async function stripePrice(priceId) {
  const hit = priceCache.get(priceId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.price;
  const p = await getStripe().prices.retrieve(priceId);
  const price = p && p.active && p.type === 'one_time' && p.unit_amount != null
    ? { amount: p.unit_amount, currency: p.currency }
    : null;
  priceCache.set(priceId, { at: Date.now(), price });
  return price;
}

export async function packToPublicDict(pack) {
  const priceId = packPriceId(pack);
  let price = null;
  if (priceId && config.stripe.secretKey) {
    try { price = await stripePrice(priceId); } catch (e) { console.error('[billing] price lookup failed:', e.message); }
  }
  return {
    id: pack.id,
    name: pack.name,
    credits: pack.credits,
    price_pln: price && price.currency === 'pln' ? price.amount / 100 : null,
    currency: price ? price.currency : 'pln',
    description: pack.description,
    popular: pack.popular,
    available: Boolean(price),
  };
}
