// Stripe billing — one service level for everyone, sold as one-time packs of tracks. No subscription, no auto-renewal,
// no card-on-file trial; credits never expire. The price lives in Stripe (the Price object is the single source of truth,
// so changing a price never needs a deploy); the number of tracks per pack is defined here.
// Same Stripe account/keys as Metadata Engine, so payments and payouts land in one place.
import Stripe from 'stripe';
import { config } from '../config.js';

// 1 credit = 1 track exported as a master (3-day free re-export of the same track, see services/exportCredits.js).
// Three sizes of the SAME service — no feature tiers. The amount of each pack is the Price object in Stripe.
export const CREDIT_PACKS = {
  single: {
    id: 'single',
    name: '1 utwór',
    credits: 1,
    description: 'Jeden utwór zmasterowany i wyeksportowany. Bez abonamentu.',
    popular: false,
    envPriceKey: 'STRIPE_PRICE_PACK_SINGLE',
  },
  ten: {
    id: 'ten',
    name: '10 utworów',
    credits: 10,
    description: 'Dziesięć utworów — EP albo kilka singli. Kredyty nie wygasają.',
    popular: true,
    envPriceKey: 'STRIPE_PRICE_PACK_TEN',
  },
  album: {
    id: 'album',
    name: 'Cały album (do 16 utworów)',
    credits: 16,
    description: 'Cały album do 16 utworów, z trybem albumu. Kredyty nie wygasają.',
    popular: false,
    envPriceKey: 'STRIPE_PRICE_PACK_ALBUM',
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
