export type ReturnReportSummary = {
  count?: number;
  units?: number;
  value?: number;
  damagedCost?: number;
};

export const combineReturnReportSummaries = (
  itemReturns: ReturnReportSummary = {},
  cancelledOrderReturns: ReturnReportSummary = {}
) => ({
  count: Number(itemReturns.count || 0) + Number(cancelledOrderReturns.count || 0),
  units: Number(itemReturns.units || 0) + Number(cancelledOrderReturns.units || 0),
  value: Number(itemReturns.value || 0) + Number(cancelledOrderReturns.value || 0),
  damagedCost: Number(itemReturns.damagedCost || 0) + Number(cancelledOrderReturns.damagedCost || 0),
});
