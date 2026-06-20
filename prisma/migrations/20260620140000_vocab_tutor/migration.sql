-- Cached English audio for vocab words (word + example), generated once.
ALTER TABLE "VocabWord" ADD COLUMN "audioUrl" TEXT;

-- Spaced-repetition memory state on each user's word progress.
ALTER TABLE "VocabProgress" ADD COLUMN "strength" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VocabProgress" ADD COLUMN "timesTested" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VocabProgress" ADD COLUMN "timesCorrect" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VocabProgress" ADD COLUMN "consecutiveHits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VocabProgress" ADD COLUMN "lastTestedAt" TIMESTAMP(3);
ALTER TABLE "VocabProgress" ADD COLUMN "dueAt" TIMESTAMP(3);
CREATE INDEX "VocabProgress_userId_dueAt_idx" ON "VocabProgress" ("userId", "dueAt");

-- Daily conversational tutor session (one per user per day).
CREATE TABLE "VocabTutorSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "state" JSONB NOT NULL,
  "taughtCount" INTEGER NOT NULL DEFAULT 0,
  "quizzedCount" INTEGER NOT NULL DEFAULT 0,
  "correctCount" INTEGER NOT NULL DEFAULT 0,
  "turns" INTEGER NOT NULL DEFAULT 0,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VocabTutorSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VocabTutorSession_userId_day_key" ON "VocabTutorSession" ("userId", "day");
CREATE INDEX "VocabTutorSession_userId_createdAt_idx" ON "VocabTutorSession" ("userId", "createdAt");
ALTER TABLE "VocabTutorSession" ADD CONSTRAINT "VocabTutorSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;