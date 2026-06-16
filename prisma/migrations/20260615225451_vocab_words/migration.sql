-- CreateTable
CREATE TABLE "VocabWord" (
    "id" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "ladder" INTEGER NOT NULL,
    "partOfSpeech" TEXT,
    "meaning" TEXT NOT NULL,
    "translation" TEXT,
    "example" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VocabWord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "learnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VocabProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VocabWord_word_key" ON "VocabWord"("word");

-- CreateIndex
CREATE INDEX "VocabWord_ladder_idx" ON "VocabWord"("ladder");

-- CreateIndex
CREATE UNIQUE INDEX "VocabProgress_userId_wordId_key" ON "VocabProgress"("userId", "wordId");

-- AddForeignKey
ALTER TABLE "VocabProgress" ADD CONSTRAINT "VocabProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VocabProgress" ADD CONSTRAINT "VocabProgress_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "VocabWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
