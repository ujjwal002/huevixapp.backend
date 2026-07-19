-- Government Jobs vertical: eligibility profiles, source registry, job listings.
-- Rules (age relaxations, fee concessions) are JSONB evaluated by the pure
-- engine in src/services/eligibility.service.js.

CREATE TYPE "ReservationCategory" AS ENUM ('UR', 'EWS', 'OBC', 'EBC', 'SC', 'ST');
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');
CREATE TYPE "EducationLevel" AS ENUM (
  'BELOW_TENTH', 'TENTH', 'ITI', 'TWELFTH', 'DIPLOMA', 'GRADUATE', 'POST_GRADUATE', 'DOCTORATE'
);

-- One row per user: the 7-question profile that makes every job check instant.
CREATE TABLE "EligibilityProfile" (
  "userId" TEXT NOT NULL,
  "dob" DATE,
  "gender" "Gender",
  "category" "ReservationCategory",
  "domicileState" TEXT,
  "isPwd" BOOLEAN NOT NULL DEFAULT false,
  "isExServiceman" BOOLEAN NOT NULL DEFAULT false,
  "educationLevel" "EducationLevel",
  "educationSubjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "educationPercent" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EligibilityProfile_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "EligibilityProfile" ADD CONSTRAINT "EligibilityProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The 25 official recruitment bodies the crawler watches (SSC, BPSC, HSSC, …).
CREATE TABLE "GovJobSource" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "state" TEXT,
  "crawlEveryHours" INTEGER NOT NULL DEFAULT 6,
  "requiresCet" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GovJobSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GovJobSource_shortName_key" ON "GovJobSource" ("shortName");

CREATE TABLE "GovJob" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT,
  "title" TEXT NOT NULL,
  "organization" TEXT NOT NULL,
  "advtNo" TEXT,
  "state" TEXT,
  "totalVacancies" INTEGER,
  "applyStartDate" DATE,
  "applyEndDate" DATE,
  "examDate" DATE,
  "officialUrl" TEXT,
  "notificationPdfUrl" TEXT,
  "eligibility" JSONB NOT NULL,
  "feeRules" JSONB NOT NULL,
  "requiresCet" BOOLEAN NOT NULL DEFAULT false,
  "parentJobId" TEXT,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GovJob_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "GovJob" ADD CONSTRAINT "GovJob_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "GovJobSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Feed queries: "open jobs, soonest deadline first", optionally by state, and
-- the public list always filters verified = true.
CREATE INDEX "GovJob_applyEndDate_idx" ON "GovJob" ("applyEndDate");
CREATE INDEX "GovJob_state_applyEndDate_idx" ON "GovJob" ("state", "applyEndDate");
CREATE INDEX "GovJob_verified_applyEndDate_idx" ON "GovJob" ("verified", "applyEndDate");