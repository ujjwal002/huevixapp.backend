-- Subscriber daily-cap: enforce the paid daily speaking limit atomically.
-- paidSpeakingCount is reserved per attempt (conditional UPDATE) and reset once
-- per day, so two concurrent requests can no longer both pass a count-based
-- check and exceed the cap (the same race already closed for trial/ad credits).
ALTER TABLE "User" ADD COLUMN "paidSpeakingDate" DATE;
ALTER TABLE "User" ADD COLUMN "paidSpeakingCount" INTEGER NOT NULL DEFAULT 0;

-- Backs the leaderboard query (ORDER BY "longestStreak" DESC, "currentStreak" DESC).
CREATE INDEX "User_longestStreak_currentStreak_idx" ON "User" ("longestStreak", "currentStreak");