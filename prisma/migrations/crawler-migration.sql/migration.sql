-- Gov-jobs crawler bookkeeping: page snapshots (change detection) and the
-- discovered-notification queue that feeds LLM extraction.

CREATE TYPE "CrawlItemStatus" AS ENUM ('NEW', 'EXTRACTED', 'FAILED', 'IGNORED');

-- One row per source: hash of the last-seen candidate-link set + crawl health.
CREATE TABLE "GovCrawlPage" (
  "sourceId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "lastCrawledAt" TIMESTAMP(3) NOT NULL,
  "lastChangedAt" TIMESTAMP(3),
  "lastError" TEXT,
  CONSTRAINT "GovCrawlPage_pkey" PRIMARY KEY ("sourceId")
);

-- One row per discovered notification link — the extraction queue.
CREATE TABLE "GovCrawlItem" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "title" TEXT,
  "status" "CrawlItemStatus" NOT NULL DEFAULT 'NEW',
  "jobId" TEXT,
  "error" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GovCrawlItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GovCrawlItem_sourceId_url_key" ON "GovCrawlItem" ("sourceId", "url");
CREATE INDEX "GovCrawlItem_status_firstSeenAt_idx" ON "GovCrawlItem" ("status", "firstSeenAt");