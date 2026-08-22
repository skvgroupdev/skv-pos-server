export type CashProfitInput = {
  orderTotal?: number;
  orderCost?: number;
  appliedAmount?: number;
};

const finiteMoney = (value: unknown) => {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
};

export const calculateRecognizedProfit = ({
  orderTotal,
  orderCost,
  appliedAmount,
}: CashProfitInput) => {
  const total = finiteMoney(orderTotal);
  if (total <= 0) return 0;

  const cost = finiteMoney(orderCost);
  const applied = Math.min(Math.max(0, finiteMoney(appliedAmount)), total);
  return ((total - cost) * applied) / total;
};

export const calculateReturnedItemProfitImpact = (
  items: Array<{ price?: number; cost?: number; quantity?: number }> = []
) =>
  items.reduce((sum, item) => {
    const quantity = finiteMoney(item.quantity);
    return sum + (finiteMoney(item.price) - finiteMoney(item.cost)) * quantity;
  }, 0);
