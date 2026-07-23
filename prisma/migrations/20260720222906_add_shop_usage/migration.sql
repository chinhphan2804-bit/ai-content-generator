-- CreateTable
CREATE TABLE "ShopUsage" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "generateCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
