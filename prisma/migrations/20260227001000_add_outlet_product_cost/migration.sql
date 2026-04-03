-- CreateTable
CREATE TABLE "OutletProductCost" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitCostNet" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutletProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutletProductCost_outletId_productId_key" ON "OutletProductCost"("outletId", "productId");

-- CreateIndex
CREATE INDEX "OutletProductCost_productId_idx" ON "OutletProductCost"("productId");

-- AddForeignKey
ALTER TABLE "OutletProductCost" ADD CONSTRAINT "OutletProductCost_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletProductCost" ADD CONSTRAINT "OutletProductCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
