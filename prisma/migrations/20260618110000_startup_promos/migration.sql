-- Paid "promote your startup" ads: owner, upfront payment, review, live window,
-- click counter, and per-viewer impression rows (unique logged-in viewers).

CREATE TYPE "PromoStatus" AS ENUM ('PENDING_PAYMENT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'EXPIRED');

CREATE TABLE "StartupPromo" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "startupName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaText" TEXT NOT NULL DEFAULT 'Visit',
    "ctaUrl" TEXT NOT NULL,
    "imageUrl" TEXT,
    "days" INTEGER NOT NULL DEFAULT 1,
    "amountPaise" INTEGER NOT NULL,
    "status" "PromoStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "refundId" TEXT,
    "rejectionReason" TEXT,
    "liveAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StartupPromo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PromoImpression" (
    "id" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromoImpression_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StartupPromo_status_expiresAt_idx" ON "StartupPromo"("status", "expiresAt");
CREATE INDEX "StartupPromo_ownerId_idx" ON "StartupPromo"("ownerId");
CREATE INDEX "PromoImpression_promoId_idx" ON "PromoImpression"("promoId");
CREATE UNIQUE INDEX "PromoImpression_promoId_userId_key" ON "PromoImpression"("promoId", "userId");

ALTER TABLE "StartupPromo" ADD CONSTRAINT "StartupPromo_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromoImpression" ADD CONSTRAINT "PromoImpression_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "StartupPromo"("id") ON DELETE CASCADE ON UPDATE CASCADE;