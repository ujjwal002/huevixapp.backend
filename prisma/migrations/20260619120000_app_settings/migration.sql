-- App-wide settings singleton: master ad switch (adsEnabled) + feed ad cadence
-- (adEveryNCards). One row, flippable live from the admin. Paid promos are not
-- gated by this switch (they're governed by admin approval).
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "adsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "adEveryNCards" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);