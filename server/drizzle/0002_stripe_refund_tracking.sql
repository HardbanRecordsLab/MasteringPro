ALTER TABLE "credit_purchases" ADD COLUMN "payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "credit_purchases" ADD COLUMN "refunded_at" timestamp with time zone;