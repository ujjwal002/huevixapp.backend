-- Google login + email verification + password reset + tutor marketplace

-- User: Google-only accounts have no password
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- Call: distinguish random practice calls from paid tutor calls
ALTER TABLE "Call" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'RANDOM';

-- Email OTP tokens
CREATE TYPE "EmailTokenType" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EmailTokenType" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailToken_userId_type_createdAt_idx" ON "EmailToken"("userId", "type", "createdAt");
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tutor marketplace
CREATE TYPE "TutorStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
CREATE TABLE "TutorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "languages" TEXT NOT NULL DEFAULT 'en',
    "experience" TEXT,
    "upiId" TEXT NOT NULL,
    "status" "TutorStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "ratePaisePerHour" INTEGER NOT NULL DEFAULT 15000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TutorProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TutorProfile_userId_key" ON "TutorProfile"("userId");
CREATE INDEX "TutorProfile_status_isOnline_idx" ON "TutorProfile"("status", "isOnline");
ALTER TABLE "TutorProfile" ADD CONSTRAINT "TutorProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TutorEarning" (
    "id" TEXT NOT NULL,
    "tutorUserId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TutorEarning_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TutorEarning_callId_key" ON "TutorEarning"("callId");
CREATE INDEX "TutorEarning_tutorUserId_createdAt_idx" ON "TutorEarning"("tutorUserId", "createdAt");
ALTER TABLE "TutorEarning" ADD CONSTRAINT "TutorEarning_tutorUserId_fkey"
  FOREIGN KEY ("tutorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TutorPayout" (
    "id" TEXT NOT NULL,
    "tutorUserId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "upiId" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TutorPayout_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TutorPayout_tutorUserId_createdAt_idx" ON "TutorPayout"("tutorUserId", "createdAt");
ALTER TABLE "TutorPayout" ADD CONSTRAINT "TutorPayout_tutorUserId_fkey"
  FOREIGN KEY ("tutorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;