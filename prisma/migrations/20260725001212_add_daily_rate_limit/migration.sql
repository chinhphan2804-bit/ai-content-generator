-- AlterTable
ALTER TABLE "ShopUsage" ADD COLUMN     "dailyCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dailyCountDate" TEXT;
