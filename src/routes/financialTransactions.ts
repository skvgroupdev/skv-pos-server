import express, { Request, Response } from "express";
import { AuthRequest, authMiddleware, requireRoles } from "../middleware/authMiddleware";
import DebtTransaction from "../models/DebtTransaction";
import Order from "../models/Order";
import PaymentTransaction from "../models/PaymentTransaction";
import { debtRepaymentMatch } from "../utils/debtReporting";

const router = express.Router();
router.use(authMiddleware as express.RequestHandler);
router.use(requireRoles(["SHOP_ADMIN", "CASHIER"]));

const getScopedCashierId = (authReq: AuthRequest, requestedCashierId?: unknown) => {
  const isManager = authReq.user!.roles.includes("SHOP_ADMIN") || authReq.user!.roles.includes("SUPER_ADMIN");
  return isManager ? String(requestedCashierId || "") : authReq.user!.userId;
};

const isManagerRequest = (authReq: AuthRequest) =>
  authReq.user!.roles.includes("SHOP_ADMIN") || authReq.user!.roles.includes("SUPER_ADMIN");

const withoutCostFields = (activity: any) => {
  const order = activity.order
    ? {
        ...activity.order,
        items: (activity.order.items || []).map((item: any) => {
          const safeItem = { ...item };
          delete safeItem.cost;
          return safeItem;
        }),
      }
    : activity.order;
  const safeActivity = { ...activity };
  delete safeActivity.approvedBy;
  delete safeActivity.approvedAt;
  return { ...safeActivity, order };
};

const withoutProfitSummaryFields = (summary: any) => {
  const safeSummary = { ...summary };
  ["totalCost", "netProfit", "totalProfit"].forEach((field) => delete safeSummary[field]);
  return safeSummary;
};

const orderDetailFields = [
  "orderId",
  "total",
  "discount",
  "saleMode",
  "status",
  "paymentMethod",
  "paymentStatus",
  "paidAmount",
  "change",
  "remainingAmount",
  "items",
  "payments",
  "exchangeRateSnapshots",
  "notes",
  "tenantSnapshot",
  "customerId",
  "cashierId",
  "cancelReason",
  "cancelReasonCode",
  "cancelledAt",
  "cancelledBy",
  "createdAt",
  "updatedAt",
].join(" ");

const orderDetailPopulate = [
  { path: "customerId", select: "name phone address" },
  { path: "cashierId", select: "username roles employeeCode phone" },
  { path: "cancelledBy", select: "username roles employeeCode" },
];

const matchesSearch = (activity: any, search: string) => {
  const haystack = [
    activity.transactionId,
    activity.order?.orderId,
    activity.customer?.name,
    activity.customer?.phone,
    activity.processedBy?.username,
    activity.note,
    ...(activity.payments || []).map((line: any) => line.reference),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
};

const orderMigrationStatus = (order: any) =>
  Array.isArray(order?.items) && order.items.length > 0 ? "COMPLETE" : "INCOMPLETE";

const debtMigrationStatus = (debt: any) =>
  debt?.amount > 0 && (debt?.paymentBreakdown?.length || debt?.paymentMethod) ? "COMPLETE" : "INCOMPLETE";

const recordId = (value: any) => value?._id?.toString?.() || value?.toString?.() || "";

router.get("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const sourceType = String(req.query.sourceType || "ALL");
    const paymentMethod = String(req.query.paymentMethod || "ALL");
    const currency = String(req.query.currency || "ALL");
    const saleMode = String(req.query.saleMode || "ALL");
    const cashierId = getScopedCashierId(authReq, req.query.cashierId);
    const search = String(req.query.search || "").trim();
    const dateFilter: any = {};
    if (req.query.startDate) dateFilter.$gte = new Date(String(req.query.startDate));
    if (req.query.endDate) dateFilter.$lte = new Date(String(req.query.endDate));

    const ledgerFilter: any = { tenantId: authReq.user!.tenantId };
    const scopedSaleModeFilter = saleMode === "retail"
      ? { $in: ["retail", null] }
      : saleMode === "wholesale" ? "wholesale" : undefined;
    const scopedOrderIds = scopedSaleModeFilter
      ? await Order.find({ tenantId: authReq.user!.tenantId, saleMode: scopedSaleModeFilter }).distinct("_id")
      : undefined;
    if (Object.keys(dateFilter).length) ledgerFilter.createdAt = dateFilter;
    if (sourceType !== "ALL") ledgerFilter.sourceType = sourceType;
    if (paymentMethod !== "ALL") ledgerFilter.paymentMethod = paymentMethod;
    if (currency !== "ALL") ledgerFilter["payments.currency"] = currency;
    if (cashierId) ledgerFilter.processedBy = cashierId;
    if (scopedOrderIds) ledgerFilter.order = { $in: scopedOrderIds };

    const ledgerRows = await PaymentTransaction.find(ledgerFilter)
      .sort({ createdAt: -1 })
      .limit(2000)
      .populate({ path: "order", select: orderDetailFields, populate: orderDetailPopulate })
      .populate("customer", "name phone address")
      .populate("processedBy", "username roles employeeCode phone")
      .populate("approvedBy", "username roles")
      .lean();

    const sourceKeys = new Set(ledgerRows.map((row) => row.sourceRecordKey).filter(Boolean));
    const legacyRows: any[] = [];

    if (sourceType === "ALL" || sourceType === "SALE") {
      const orderFilter: any = { tenantId: authReq.user!.tenantId };
      if (Object.keys(dateFilter).length) orderFilter.createdAt = dateFilter;
      if (cashierId) orderFilter.cashierId = cashierId;
      if (paymentMethod !== "ALL") orderFilter.paymentMethod = paymentMethod;
      if (scopedSaleModeFilter) orderFilter.saleMode = scopedSaleModeFilter;
      const orders = await Order.find(orderFilter)
        .sort({ createdAt: -1 })
        .limit(2000)
        .populate("customerId", "name phone address")
        .populate("cashierId", "username roles employeeCode phone")
        .populate("cancelledBy", "username roles employeeCode")
        .lean();

      for (const order of orders) {
        const orderObjectId = order._id.toString();
        if (sourceKeys.has(`ORDER:${orderObjectId}`)) continue;
        if (ledgerRows.some((row: any) => row.order?._id?.toString?.() === orderObjectId && row.sourceType === "SALE")) continue;
        const payments = (order.payments || []).map((line: any) => ({
          method: order.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
          currency: line.currency,
          amount: line.amount,
          rate: line.rate,
          amountInLAK: line.amountInLAK,
          reference: line.reference,
        }));
        if (currency !== "ALL" && !payments.some((line: any) => line.currency === currency)) continue;
        // `paidAmount` is cumulative and increases again when debt is repaid.  A
        // legacy SALE row must use only the immutable payment snapshot captured
        // at checkout, otherwise the later DEBT_REPAYMENT is counted twice.
        const snapshotGross = payments.reduce((sum: number, line: any) => sum + (Number(line.amountInLAK) || 0), 0);
        const initialGross = payments.length > 0
          ? snapshotGross
          : order.paymentMethod === "DEBT" ? 0 : Number(order.paidAmount || 0);
        const initialApplied = Math.max(0, initialGross - Number(order.change || 0));
        legacyRows.push({
          _id: `legacy-order-${orderObjectId}`,
          transactionId: order.orderId,
          sourceType: "SALE",
          direction: "IN",
          order,
          customer: order.customerId,
          processedBy: order.cashierId,
          paymentMethod: order.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
          payments,
          grossReceivedInLAK: initialGross,
          appliedAmountInLAK: initialApplied,
          changeInLAK: order.change || 0,
          status: order.status === "CANCELLED" ? "REVERSED" : "POSTED",
          migrationStatus: orderMigrationStatus(order),
          createdAt: order.createdAt,
        });
      }
    }

    if (sourceType === "ALL" || sourceType === "DEBT_REPAYMENT") {
      const debtFilter: any = {
        tenantId: authReq.user!.tenantId,
        ...debtRepaymentMatch(),
      };
      if (Object.keys(dateFilter).length) debtFilter.createdAt = dateFilter;
      if (cashierId) debtFilter.processedBy = cashierId;
      if (paymentMethod !== "ALL") debtFilter.paymentMethod = paymentMethod;
      if (scopedOrderIds) debtFilter.order = { $in: scopedOrderIds };
      const debts = await DebtTransaction.find(debtFilter)
        .sort({ createdAt: -1 })
        .limit(2000)
        .populate("customer", "name phone address")
        .populate({ path: "order", select: orderDetailFields, populate: orderDetailPopulate })
        .populate("processedBy", "username roles employeeCode phone")
        .lean();

      for (const debt of debts) {
        const debtObjectId = debt._id.toString();
        const debtOrderId = recordId(debt.order);
        if (sourceKeys.has(`DEBT:${debtObjectId}`)) continue;
        if (ledgerRows.some((row: any) => recordId(row.order) === debtOrderId && row.sourceType === "DEBT_REPAYMENT" && row.appliedAmountInLAK === debt.amount)) continue;
        const fallbackMethod = debt.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH";
        const payments = debt.paymentBreakdown?.length ? debt.paymentBreakdown : [{
          method: fallbackMethod,
          currency: "LAK",
          amount: debt.amount,
          rate: 1,
          amountInLAK: debt.amount,
          reference: debt.reference,
        }];
        if (currency !== "ALL" && !payments.some((line: any) => line.currency === currency)) continue;
        legacyRows.push({
          _id: `legacy-debt-${debtObjectId}`,
          transactionId: debt.receiptNumber || debt._id.toString(),
          sourceType: "DEBT_REPAYMENT",
          direction: "IN",
          order: debt.order,
          customer: debt.customer,
          processedBy: debt.processedBy,
          paymentMethod: debt.paymentMethod || fallbackMethod,
          payments,
          grossReceivedInLAK: debt.amount,
          appliedAmountInLAK: debt.amount,
          changeInLAK: 0,
          note: debt.note,
          status: "POSTED",
          migrationStatus: debtMigrationStatus(debt),
          createdAt: debt.createdAt,
        });
      }
    }

    if (sourceType === "ALL" || sourceType === "REVERSAL") {
      const cancellationFilter: any = {
        tenantId: authReq.user!.tenantId,
        status: "CANCELLED",
      };
      if (cashierId) cancellationFilter.cashierId = cashierId;
      if (scopedSaleModeFilter) cancellationFilter.saleMode = scopedSaleModeFilter;
      if (Object.keys(dateFilter).length) {
        cancellationFilter.$or = [
          { cancelledAt: dateFilter },
          { cancelledAt: { $exists: false }, updatedAt: dateFilter },
        ];
      }
      const cancelledOrders = await Order.find(cancellationFilter)
        .sort({ cancelledAt: -1 })
        .limit(2000)
        .populate("customerId", "name phone address")
        .populate("cashierId", "username roles employeeCode phone")
        .populate("cancelledBy", "username roles employeeCode")
        .lean();

      for (const order of cancelledOrders) {
        const orderObjectId = order._id.toString();
        if (ledgerRows.some((row: any) => row.order?._id?.toString?.() === orderObjectId && row.sourceType === "REVERSAL" && row.status === "POSTED")) continue;
        const payments = (order.payments || []).map((line: any) => ({
          method: line.method || (order.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH"),
          currency: line.currency,
          amount: line.amount,
          rate: line.rate,
          amountInLAK: line.amountInLAK,
          reference: line.reference,
        }));
        const snapshotGross = payments.reduce((sum: number, line: any) => sum + (Number(line.amountInLAK) || 0), 0);
        const initialGross = payments.length > 0
          ? snapshotGross
          : order.paymentMethod === "DEBT" ? 0 : Number(order.paidAmount || 0);
        const reversedAmount = Math.max(0, initialGross - Number(order.change || 0));
        if (reversedAmount <= 0) continue;
        if (paymentMethod !== "ALL" && paymentMethod !== (order.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH")) continue;
        if (currency !== "ALL" && !payments.some((line: any) => line.currency === currency)) continue;
        legacyRows.push({
          _id: `legacy-cancel-${orderObjectId}`,
          transactionId: `CANCEL-${order.orderId}`,
          sourceType: "REVERSAL",
          direction: "OUT",
          order,
          customer: order.customerId,
          processedBy: order.cancelledBy || order.cashierId,
          paymentMethod: order.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
          payments,
          grossReceivedInLAK: initialGross,
          appliedAmountInLAK: reversedAmount,
          changeInLAK: 0,
          note: order.cancelReason,
          reasonCode: order.cancelReasonCode,
          status: "POSTED",
          migrationStatus: orderMigrationStatus(order),
          createdAt: order.cancelledAt || order.updatedAt,
        });
      }
    }

    let activities = [...ledgerRows, ...legacyRows].sort(
      (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (search) activities = activities.filter((activity) => matchesSearch(activity, search));

    const seenSaleOrders = new Set<string>();
    const summary = activities.reduce(
      (acc, row: any) => {
        const orderPaymentSnapshot = (row.order?.payments || []).reduce(
          (sum: number, line: any) => sum + (Number(line.amountInLAK) || 0),
          0
        );
        const reportAppliedAmount =
          row.sourceType === "SALE" && row.order?.paymentMethod === "DEBT"
            ? Math.max(0, orderPaymentSnapshot - Number(row.order?.change || 0))
            : Number(row.appliedAmountInLAK || 0);
        if (row.direction === "OUT") acc.moneyOut += reportAppliedAmount;
        else acc.moneyIn += reportAppliedAmount;
        if (row.sourceType === "SALE" && row.order && row.order.status !== "CANCELLED") {
          const orderKey = row.order._id?.toString?.() || row.order.orderId || row._id;
          if (!seenSaleOrders.has(orderKey)) {
            seenSaleOrders.add(orderKey);
            acc.totalSales += row.order.total || 0;
            acc.totalDiscount += row.order.discount || 0;
            acc.totalCost += (row.order.items || []).reduce(
              (sum: number, item: any) =>
                sum + (Number(item.cost) || 0) * (Number(item.quantity) || 0),
              0
            );
            acc.totalOrders += 1;
            acc.totalDebt += row.order.remainingAmount || 0;
            acc.actualReceivedFromOrders += reportAppliedAmount;
          }
        }
        if (row.sourceType === "DEBT_REPAYMENT" && row.direction !== "OUT") {
          acc.debtRepaymentIncome += reportAppliedAmount;
          acc.debtRepaymentCount += 1;
        }
        acc.change += row.changeInLAK || 0;
        acc.count += 1;
        return acc;
      },
      {
        moneyIn: 0,
        moneyOut: 0,
        change: 0,
        count: 0,
        totalSales: 0,
        totalDiscount: 0,
        totalCost: 0,
        actualReceivedFromOrders: 0,
        totalOrders: 0,
        totalDebt: 0,
        debtRepaymentIncome: 0,
        debtRepaymentCount: 0,
      }
    );
    const total = activities.length;
    const data = activities.slice((page - 1) * limit, page * limit);
    const grossSales = summary.totalSales + summary.totalDiscount;
    const netProfit = summary.totalSales - summary.totalCost;
    const totalIncomeToday = summary.actualReceivedFromOrders + summary.debtRepaymentIncome;
    const netCashReceived = totalIncomeToday - summary.moneyOut;

    const fullSummary = {
      ...summary,
      grossSales,
      grossBillSales: grossSales,
      netSales: summary.totalSales,
      netBillSales: summary.totalSales,
      discountAmount: summary.totalDiscount,
      netProfit,
      // Compatibility alias for report consumers that still read totalProfit.
      totalProfit: netProfit,
      cashInFromNewBills: summary.actualReceivedFromOrders,
      totalIncomeToday,
      netCashReceived,
      netCashFlow: netCashReceived,
      net: netCashReceived,
    };
    const managerRequest = isManagerRequest(authReq);

    return res.json({
      data: managerRequest ? data : data.map(withoutCostFields),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: managerRequest ? fullSummary : withoutProfitSummaryFields(fullSummary),
    });
  } catch (error) {
    console.error("Financial transactions failed:", error);
    res.status(500).json({ error: "Failed to fetch financial transactions" });
  }
});

export default router;
