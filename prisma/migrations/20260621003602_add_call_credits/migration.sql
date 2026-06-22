-- AlterTable
ALTER TABLE "User" ADD COLUMN     "callSecondsBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "callSecondsDate" DATE,
ADD COLUMN     "callSecondsUsedToday" INTEGER NOT NULL DEFAULT 0;
