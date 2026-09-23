// Stripe credit packs (one-time payments, no subscriptions) — same shape as
// Metadata Engine's stripe_billing.py, same Stripe account/keys, so both
// products' payments and payouts land in one place. Prices are independent
// per product: mastering AI runs cost more per unit than a metadata job, so
// these do NOT mirror Metadata Engine's PLN/USD amounts, only its structure.
import Stripe from 'stripe';
import { config } from '../config.js';

export const CREDIT_PACKS = {
  starter: {
    id: 'starter',
    name: 'Starter Pack',
    credits: 5,
    priceGrosz: 7900, // 79.00 PLN
    description: 'Wypróbuj AI Mastering na kilku utworach.',
    popular: false,
    envPriceKey: 'STRIPE_PRICE_PACK_STARTER',
  },
  producer: {
    id: 'producer',
    name: 'Producer Pack',
    credits: 20,
    priceGrosz: 24900, // 249.00 PLN
    description: 'Dla producentów regularnie wydających utwory.',
    popular: true,
    envPriceKey: 'STRIPE_PRICE_PACK_PRODUCER',
  },
  label: {
    id: 'label',
    name: 'Label Pack',
    credits: 60,
    priceGrosz: 59900, // 599.00 PLN
    description: 'Pełny album lub EP z zapasem na poprawki.',
    popular: false,
    envPriceKey: 'STRIPE_PRICE_PACK_LABEL',
  },
  studio: {
    id: 'studio',
    name: 'Studio Pack',
    credits: 150,
    priceGrosz: 119900, // 1199.00 PLN
    description: 'Duży wolumen — labele i agencje.',
    popular: false,
    envPriceKey: 'STRIPE_PRICE_PACK_STUDIO',
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

export function packToPublicDict(pack) {
  return {
    id: pack.id,
    name: pack.name,
    credits: pack.credits,
    price_pln: pack.priceGrosz / 100,
    description: pack.description,
    popular: pack.popular,
    available: Boolean(packPriceId(pack)),
  };
}
