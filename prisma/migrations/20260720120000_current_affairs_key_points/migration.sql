-- Current-affairs pivot: cards carry 3-5 short exam pointers ("keyPoints"),
-- stored newline-separated. Nullable so every existing card stays valid.
ALTER TABLE "Card" ADD COLUMN "keyPoints" TEXT;
