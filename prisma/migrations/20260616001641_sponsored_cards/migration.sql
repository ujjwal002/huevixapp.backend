-- CreateTable
CREATE TABLE "SponsoredCard" (
    "id" TEXT NOT NULL,
    "advertiser" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaText" TEXT NOT NULL DEFAULT 'Learn more',
    "ctaUrl" TEXT NOT NULL,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsoredCard_pkey" PRIMARY KEY ("id")
);
