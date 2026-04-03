-- CreateTable
CREATE TABLE "OutletProductPrice" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPriceNet" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutletProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutletProductPrice_outletId_productId_key" ON "OutletProductPrice"("outletId", "productId");

-- CreateIndex
CREATE INDEX "OutletProductPrice_productId_idx" ON "OutletProductPrice"("productId");

-- AddForeignKey
ALTER TABLE "OutletProductPrice" ADD CONSTRAINT "OutletProductPrice_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletProductPrice" ADD CONSTRAINT "OutletProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
