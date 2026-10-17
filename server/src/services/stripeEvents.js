// Stripe webhook event processing — separate from the route so it can be driven with a fake database in the self-test.
// Every branch is idempotent: Stripe delivers events at-least-once and may deliver the same event twice at once.
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { CREDIT_PACKS } from './stripeBilling.js';

/** @returns {Promise<{ status?: number, body: object }>} */
export async function processStripeEvent(db, event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      // Delayed methods (e.g. bank transfer): 'completed' arrives unpaid, credits are granted on async_payment_succeeded.
      if (session.payment_status !== 'paid') return { body: { status: 'waiting', reason: 'not paid yet' } };

      const metadata = session.metadata || {};
      const userId = metadata.user_id || session.client_reference_id;
      const packId = metadata.pack_id || 'ten';
      let creditsToAdd = parseInt(metadata.credits, 10) || 0;
      if (creditsToAdd <= 0) creditsToAdd = CREDIT_PACKS[packId]?.credits || 0;
      if (!userId || creditsToAdd <= 0) {
        console.error('[billing] Webhook missing user_id or credits:', metadata);
        return { status: 400, body: { error: 'Invalid session metadata' } };
      }
      const userRows = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (!userRows.length) {
        console.warn('[billing] Stripe webhook: user %s not found', userId);
        return { status: 404, body: { error: 'User not found' } };
      }

      // One transaction: the purchase row is the idempotency lock (unique session id). Two simultaneous deliveries of
      // the same event can never both add credits.
      const outcome = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.creditPurchases)
          .values({
            userId,
            stripeSessionId: session.id,
            packId,
            creditsAdded: creditsToAdd,
            amountTotal: session.amount_total ?? null,
            currency: session.currency ?? null,
            paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          })
          .onConflictDoNothing({ target: schema.creditPurchases.stripeSessionId })
          .returning({ id: schema.creditPurchases.id });
        if (!inserted.length) return 'already_processed';
        await tx
          .update(schema.users)
          .set({ credits: sql`${schema.users.credits} + ${creditsToAdd}` })
          .where(eq(schema.users.id, userId));
        return 'success';
      });
      if (outcome === 'already_processed') return { body: { status: 'already_processed', session_id: session.id } };
      console.log(`[billing] Stripe: added ${creditsToAdd} credits to user ${userId} (pack=${packId})`);
      return { body: { status: 'success', credits_added: creditsToAdd, user_id: userId } };
    }

    case 'checkout.session.async_payment_failed':
      console.warn('[billing] async payment failed for session', event.data.object.id);
      return { body: { status: 'ignored', reason: 'async payment failed' } };

    case 'charge.refunded': {
      // A FULL refund takes the credits back (never below 0). A partial refund is left for a human decision.
      const charge = event.data.object;
      const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (!pi) return { body: { status: 'ignored', reason: 'no payment_intent' } };
      if (charge.amount_refunded < charge.amount) {
        console.warn('[billing] PARTIAL refund on %s (%s of %s) — credits left untouched, review manually', pi, charge.amount_refunded, charge.amount);
        return { body: { status: 'ignored', reason: 'partial refund' } };
      }
      const rows = await db
        .select()
        .from(schema.creditPurchases)
        .where(and(eq(schema.creditPurchases.paymentIntentId, pi), isNull(schema.creditPurchases.refundedAt)))
        .limit(1);
      if (!rows.length) return { body: { status: 'ignored', reason: 'purchase not found or already refunded' } };
      const p = rows[0];
      await db.transaction(async (tx) => {
        const mark = await tx
          .update(schema.creditPurchases)
          .set({ refundedAt: new Date() })
          .where(and(eq(schema.creditPurchases.id, p.id), isNull(schema.creditPurchases.refundedAt)))
          .returning({ id: schema.creditPurchases.id });
        if (!mark.length) return;
        await tx
          .update(schema.users)
          .set({ credits: sql`greatest(0, ${schema.users.credits} - ${p.creditsAdded})` })
          .where(eq(schema.users.id, p.userId));
      });
      console.log(`[billing] Stripe: full refund — took back ${p.creditsAdded} credits from user ${p.userId}`);
      return { body: { status: 'refunded', user_id: p.userId } };
    }

    case 'charge.dispute.created':
      console.error('[billing] DISPUTE opened on charge %s — answer it in the Stripe Dashboard', event.data.object.charge);
      return { body: { status: 'logged' } };

    default:
      return { body: { status: 'ignored', type: event.type } };
  }
}
