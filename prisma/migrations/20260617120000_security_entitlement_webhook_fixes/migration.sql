-- Fix #8: a true daily ad-credit cap. `adCreditsRemaining` is a spendable
-- balance (decremented on use); this new column counts how many credits were
-- GRANTED today and is never decremented on spend, so the per-day cap can no
-- longer be bypassed by spending and re-earning.
ALTER TABLE "User" ADD COLUMN "adCreditsGrantedToday" INTEGER NOT NULL DEFAULT 0;

-- Fix #9: webhook idempotency. One row per provider event id we have handled,
-- so duplicate webhook deliveries are processed at most once.
CREATE TABLE "ProcessedWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("id")
);