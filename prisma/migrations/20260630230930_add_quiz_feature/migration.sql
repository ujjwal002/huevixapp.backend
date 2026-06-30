-- AlterTable
ALTER TABLE "User" ADD COLUMN     "quizCurrentStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quizLastPlayedDate" TIMESTAMP(3),
ADD COLUMN     "quizLongestStreak" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DailyQuiz" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "targetLanguage" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyQuiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizQuestion" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctIndex" INTEGER NOT NULL,
    "explanation" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizDailyPlay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "pointsEarned" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuizDailyPlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAnswer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "chosenIndex" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "pointsAwarded" INTEGER NOT NULL DEFAULT 0,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizMonthlyScore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "lastEarnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuizMonthlyScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyQuiz_date_idx" ON "DailyQuiz"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyQuiz_date_targetLanguage_key" ON "DailyQuiz"("date", "targetLanguage");

-- CreateIndex
CREATE INDEX "QuizQuestion_quizId_idx" ON "QuizQuestion"("quizId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizQuestion_quizId_order_key" ON "QuizQuestion"("quizId", "order");

-- CreateIndex
CREATE INDEX "QuizDailyPlay_userId_idx" ON "QuizDailyPlay"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizDailyPlay_userId_quizId_key" ON "QuizDailyPlay"("userId", "quizId");

-- CreateIndex
CREATE INDEX "QuizAnswer_userId_answeredAt_idx" ON "QuizAnswer"("userId", "answeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuizAnswer_userId_questionId_key" ON "QuizAnswer"("userId", "questionId");

-- CreateIndex
CREATE INDEX "QuizMonthlyScore_period_totalPoints_idx" ON "QuizMonthlyScore"("period", "totalPoints");

-- CreateIndex
CREATE UNIQUE INDEX "QuizMonthlyScore_userId_period_key" ON "QuizMonthlyScore"("userId", "period");

-- AddForeignKey
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "DailyQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizDailyPlay" ADD CONSTRAINT "QuizDailyPlay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizDailyPlay" ADD CONSTRAINT "QuizDailyPlay_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "DailyQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAnswer" ADD CONSTRAINT "QuizAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAnswer" ADD CONSTRAINT "QuizAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizMonthlyScore" ADD CONSTRAINT "QuizMonthlyScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
