-- Google Play hardening
--
-- 1) A purchase token may back exactly ONE subscription row. Without this, a
--    single real purchase token could be replayed across many accounts, each
--    call to /subscription/google/verify activating another free premium.
--
-- Pre-flight (run manually if the index creation fails): find duplicates first.
--   SELECT "providerRefId", COUNT(*) FROM "Subscription"
--   WHERE "providerRefId" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX "Subscription_providerRefId_key" ON "Subscription"("providerRefId");

-- 2) New subscriptions default to google_play (existing rows keep their value).
ALTER TABLE "Subscription" ALTER COLUMN "provider" SET DEFAULT 'google_play';