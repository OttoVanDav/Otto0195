export const BAR_SALES_VAT_RATE = 0.1;
const BAR_SALES_VAT_FACTOR = 1 + BAR_SALES_VAT_RATE;

export function grossToNetSaleAmount(amountGross: number) {
  if (!Number.isFinite(amountGross)) return 0;
  return amountGross / BAR_SALES_VAT_FACTOR;
}

export function grossToNetSaleUnitPrice(unitPriceGross: number) {
  return grossToNetSaleAmount(unitPriceGross);
}
