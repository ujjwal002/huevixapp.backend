-- Coin economy: purchased balance moves from seconds to coins.
-- 1 legacy purchased second = 4 coins (the normal-call burn rate), so every
-- user's existing paid balance keeps exactly its old value.
ALTER TABLE "User" ADD COLUMN "coinBalance" INTEGER NOT NULL DEFAULT 0;
UPDATE "User" SET "coinBalance" = "callSecondsBalance" * 4 WHERE "callSecondsBalance" > 0;
-- Freeze the legacy column so no code path can double-spend the same value.
UPDATE "User" SET "callSecondsBalance" = 0 WHERE "callSecondsBalance" <> 0;
