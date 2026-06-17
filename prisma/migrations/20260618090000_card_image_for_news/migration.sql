-- News/article feature: article cards can carry a hero image + source link.
ALTER TABLE "Card" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "Card" ADD COLUMN "sourceUrl" TEXT;