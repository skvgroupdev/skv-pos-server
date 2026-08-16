import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import mongoose from "mongoose";
import "../config/env";
import Customer from "../models/Customer";
import DebtTransaction from "../models/DebtTransaction";
import Order from "../models/Order";
import Product from "../models/Product";
import Tenant from "../models/Tenant";
import User from "../models/User";

const TENANT_ID = process.env.LATDASHOP_TENANT_ID || "6a80799d1d450463a75f3f01";
const CASHIER_ID = process.env.LATDASHOP_CASHIER_ID || "6a8079e71d450463a75f3f04";
const JSON_PATH =
  process.env.LATDASHOP_JSON_PATH ||
  path.resolve(__dirname, "../../../report/zyzgbpsz_latdashop (1).json");
const SOURCE_PREFIX = process.env.LATDASHOP_SOURCE_PREFIX || "LATDA_MYSQL";
const APPLY = process.argv.includes("--apply");

type ExportEntry = {
  type?: string;
  name?: string;
  data?: Record<string, string | null>[];
};

type InvoiceRow = {
  id: string;
  cashier_id: string;
  member_id: string;
  total_lak: string;
  total_thb: string;
  total_checkout_lak: string;
  total_checkout_thb: string;
  rate: string;
  pay_type: string;
  pay_currency: string;
  date_create: string;
  date_payment: string | null;
  status: string;
};

type InvoiceDetailRow = {
  invoice_id: string;
  barcode: string;
  title: string;
  cost_thb: string;
  cost_lak: string;
  qty: string;
  total_lak: string;
  total_thb: string;
};

const text = (value: unknown) => String(value ?? "").trim();

const numberValue = (value: unknown) => {
  const parsed = Number(text(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const lakAmount = (lakValue: unknown, thbValue: unknown, rateValue: unknown) =>
  Math.round(numberValue(lakValue) + numberValue(thbValue) * numberValue(rateValue));

const parseVientianeDate = (value: string) =>
  new Date(`${text(value).replace(" ", "T")}+07:00`);

const sourceOrderId = (invoiceId: string) =>
  `LDOLD${invoiceId.padStart(5, "0").slice(-5)}`;

const repaymentReceipt = (invoiceId: string) =>
  `LDOLDPAY${invoiceId.padStart(5, "0").slice(-5)}`;

const customerPhoneFor = (name: string) => {
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 16);
  return `LEGACY-LATDA-${hash}`;
};

const customerNameFor = (invoice: InvoiceRow) =>
  text(invoice.member_id) || `Legacy customer ${invoice.id}`;

const loadTables = () => {
  const exported = JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as ExportEntry[];
  const byName = new Map(
    exported
      .filter((entry) => entry.type === "table" && entry.name && Array.isArray(entry.data))
      .map((entry) => [entry.name!, entry.data!])
  );
  const invoices = (byName.get("invoice") || []) as unknown as InvoiceRow[];
  const details = (byName.get("invoicedetail") || []) as unknown as InvoiceDetailRow[];
  if (!invoices.length || !details.length) {
    throw new Error(`Missing invoice/invoicedetail data in ${JSON_PATH}`);
  }
  return { invoices, details };
};

const recomputeCustomerBalances = async (
  tenantId: mongoose.Types.ObjectId,
  customerIds: mongoose.Types.ObjectId[]
) => {
  for (const customerId of customerIds) {
    const transactions = await DebtTransaction.find({ tenantId, customer: customerId })
      .sort({ createdAt: 1, _id: 1 });
    let runningBalance = 0;
    let lastPaymentDate: Date | undefined;

    for (const transaction of transactions) {
      const balanceBefore = runningBalance;
      runningBalance += transaction.type === "CREDIT" ? transaction.amount : -transaction.amount;
      if (runningBalance < -0.5) {
        throw new Error(
          `Debt history becomes negative for customer ${customerId.toString()} at transaction ${transaction._id.toString()}`
        );
      }
      runningBalance = Math.max(0, runningBalance);
      transaction.balanceBefore = balanceBefore;
      transaction.balanceAfter = runningBalance;
      if (transaction.type === "DEBIT") lastPaymentDate = transaction.createdAt;
      await transaction.save();
    }

    const unpaid = await Order.aggregate([
      {
        $match: {
          tenantId,
          customerId,
          status: { $ne: "CANCELLED" },
          remainingAmount: { $gt: 0 },
        },
      },
      { $group: { _id: null, totalDebt: { $sum: "$remainingAmount" } } },
    ]);
    const totalDebt = unpaid[0]?.totalDebt || 0;
    if (Math.abs(runningBalance - totalDebt) > 0.5) {
      throw new Error(
        `Debt history/order mismatch for customer ${customerId.toString()}: history=${runningBalance}, orders=${totalDebt}`
      );
    }

    await Customer.updateOne(
      { _id: customerId, tenantId },
      {
        $set: {
          totalDebt,
          ...(lastPaymentDate ? { lastPaymentDate } : {}),
        },
      }
    );
  }
};

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (!mongoose.Types.ObjectId.isValid(TENANT_ID)) throw new Error(`Invalid tenant id: ${TENANT_ID}`);
  if (!mongoose.Types.ObjectId.isValid(CASHIER_ID)) throw new Error(`Invalid cashier id: ${CASHIER_ID}`);

  const tenantId = new mongoose.Types.ObjectId(TENANT_ID);
  const cashierId = new mongoose.Types.ObjectId(CASHIER_ID);
  const { invoices, details } = loadTables();
  const paidDebtInvoices = invoices.filter(
    (invoice) => invoice.pay_type === "debt" && invoice.status === "completed" && invoice.date_payment
  );
  const pendingDebtInvoices = invoices.filter(
    (invoice) => invoice.pay_type === "debt" && invoice.status === "padding" && !invoice.date_payment
  );

  if (paidDebtInvoices.length !== 234 || pendingDebtInvoices.length !== 1) {
    throw new Error(
      `Unexpected source debt shape: completed=${paidDebtInvoices.length}, pending=${pendingDebtInvoices.length}`
    );
  }

  const detailsByInvoice = new Map<string, InvoiceDetailRow[]>();
  for (const detail of details) {
    if (!detailsByInvoice.has(detail.invoice_id)) detailsByInvoice.set(detail.invoice_id, []);
    detailsByInvoice.get(detail.invoice_id)!.push(detail);
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  try {
    const [tenant, cashier] = await Promise.all([
      Tenant.findById(tenantId).lean(),
      User.findOne({ _id: cashierId, tenantId }).lean(),
    ]);
    if (!tenant) throw new Error(`Tenant not found: ${TENANT_ID}`);
    if (!cashier) throw new Error(`Cashier ${CASHIER_ID} is not linked to tenant ${TENANT_ID}`);

    const paidOrderIds = paidDebtInvoices.map((invoice) => sourceOrderId(invoice.id));
    const paidOrders = await Order.find({ tenantId, orderId: { $in: paidOrderIds } }).lean();
    const orderByOrderId = new Map(paidOrders.map((order) => [order.orderId, order]));
    const missingPaidOrders = paidOrderIds.filter((orderId) => !orderByOrderId.has(orderId));
    if (missingPaidOrders.length) {
      throw new Error(`Missing migrated debt orders: ${missingPaidOrders.slice(0, 10).join(", ")}`);
    }

    for (const invoice of paidDebtInvoices) {
      const order = orderByOrderId.get(sourceOrderId(invoice.id))!;
      const sourceTotal = lakAmount(
        invoice.total_checkout_lak,
        invoice.total_checkout_thb,
        invoice.rate
      );
      if (sourceTotal !== order.total) {
        throw new Error(`Invoice ${invoice.id} total mismatch: source=${sourceTotal}, order=${order.total}`);
      }
    }

    const paidOrderObjectIds = paidOrders.map((order) => order._id);
    const [creditCount, existingRepayments, unrelatedRepayments] = await Promise.all([
      DebtTransaction.countDocuments({ tenantId, order: { $in: paidOrderObjectIds }, type: "CREDIT" }),
      DebtTransaction.find({
        tenantId,
        order: { $in: paidOrderObjectIds },
        type: "DEBIT",
        receiptNumber: { $in: paidDebtInvoices.map((invoice) => repaymentReceipt(invoice.id)) },
      }).select("order receiptNumber amount"),
      DebtTransaction.find({
        tenantId,
        order: { $in: paidOrderObjectIds },
        type: "DEBIT",
        receiptNumber: { $nin: paidDebtInvoices.map((invoice) => repaymentReceipt(invoice.id)) },
      }).select("order receiptNumber amount"),
    ]);
    if (creditCount !== paidDebtInvoices.length) {
      throw new Error(`Expected ${paidDebtInvoices.length} legacy CREDIT rows, found ${creditCount}`);
    }
    if (unrelatedRepayments.length) {
      throw new Error(
        `Found ${unrelatedRepayments.length} non-migration repayments on legacy orders; manual review required`
      );
    }

    const existingRepaymentOrderIds = new Set(
      existingRepayments.map((transaction) => transaction.order?.toString())
    );
    const repaymentsToCreate = paidDebtInvoices.filter((invoice) => {
      const order = orderByOrderId.get(sourceOrderId(invoice.id))!;
      return !existingRepaymentOrderIds.has(order._id.toString());
    });
    const paidOrdersToReconcile = paidOrders.filter(
      (order) => order.paymentStatus !== "PAID" || order.remainingAmount !== 0 || order.paidAmount !== order.total
    );

    const pendingOrderIds = pendingDebtInvoices.map((invoice) => sourceOrderId(invoice.id));
    const existingPendingOrders = await Order.find({ tenantId, orderId: { $in: pendingOrderIds } }).lean();
    const existingPendingOrderIds = new Set(existingPendingOrders.map((order) => order.orderId));
    const pendingOrdersToCreate = pendingDebtInvoices.filter(
      (invoice) => !existingPendingOrderIds.has(sourceOrderId(invoice.id))
    );

    const sourcePaidTotal = paidDebtInvoices.reduce(
      (sum, invoice) => sum + lakAmount(invoice.total_checkout_lak, invoice.total_checkout_thb, invoice.rate),
      0
    );
    const sourcePendingTotal = pendingDebtInvoices.reduce(
      (sum, invoice) => sum + lakAmount(invoice.total_checkout_lak, invoice.total_checkout_thb, invoice.rate),
      0
    );

    console.log(JSON.stringify({
      mode: APPLY ? "APPLY" : "DRY_RUN",
      tenantId: TENANT_ID,
      cashierId: CASHIER_ID,
      source: {
        paidDebtInvoices: paidDebtInvoices.length,
        paidDebtTotal: sourcePaidTotal,
        pendingDebtInvoices: pendingDebtInvoices.length,
        pendingDebtTotal: sourcePendingTotal,
      },
      existing: {
        paidDebtOrders: paidOrders.length,
        creditTransactions: creditCount,
        repaymentTransactions: existingRepayments.length,
        pendingDebtOrders: existingPendingOrders.length,
      },
      toApply: {
        repaymentTransactions: repaymentsToCreate.length,
        paidOrdersToReconcile: paidOrdersToReconcile.length,
        pendingDebtOrders: pendingOrdersToCreate.length,
      },
    }, null, 2));

    if (!APPLY) return;

    const affectedCustomerIds = new Set<string>();

    for (const invoice of pendingOrdersToCreate) {
      const customerName = customerNameFor(invoice);
      const customerPhone = customerPhoneFor(customerName);
      const customer = await Customer.findOneAndUpdate(
        { tenantId, phone: customerPhone },
        { $setOnInsert: { tenantId, name: customerName, phone: customerPhone, totalDebt: 0 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      affectedCustomerIds.add(customer._id.toString());

      const invoiceDetails = detailsByInvoice.get(invoice.id) || [];
      if (!invoiceDetails.length) throw new Error(`Pending invoice ${invoice.id} has no detail rows`);
      const products = await Product.find({
        tenantId,
        barcode: { $in: invoiceDetails.map((detail) => text(detail.barcode)) },
      }).select("_id barcode name");
      const productByBarcode = new Map(products.map((product) => [text(product.barcode), product]));
      const missingBarcodes = invoiceDetails
        .map((detail) => text(detail.barcode))
        .filter((barcode) => !productByBarcode.has(barcode));
      if (missingBarcodes.length) {
        throw new Error(`Missing products for pending invoice ${invoice.id}: ${missingBarcodes.join(", ")}`);
      }

      const createdAt = parseVientianeDate(invoice.date_create);
      const total = lakAmount(invoice.total_checkout_lak, invoice.total_checkout_thb, invoice.rate);
      const gross = lakAmount(invoice.total_lak, invoice.total_thb, invoice.rate);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const createdOrders = await Order.create([{
            tenantId,
            tenantSnapshot: {
              shopName: tenant.shopName || "",
              logo: tenant.logo || "",
              address: tenant.address || "",
              phone: tenant.phone || "",
              bankName: tenant.bankName || "",
              bankAccount: tenant.bankAccount || "",
              bankQr: tenant.bankQr || "",
              receiptNote: tenant.receiptNote || "",
            },
            items: invoiceDetails.map((detail) => {
              const product = productByBarcode.get(text(detail.barcode))!;
              const quantity = numberValue(detail.qty);
              const lineTotal = lakAmount(detail.total_lak, detail.total_thb, invoice.rate);
              const unitCost = numberValue(detail.cost_thb) > 0
                ? Math.round(numberValue(detail.cost_thb) * numberValue(invoice.rate))
                : Math.round(numberValue(detail.cost_lak));
              return {
                product: product._id,
                quantity,
                price: quantity > 0 ? Math.round(lineTotal / quantity) : lineTotal,
                cost: unitCost,
                name: text(detail.title) || product.name,
              };
            }),
            total,
            paymentMethod: "DEBT",
            paidAmount: 0,
            change: 0,
            discount: Math.max(0, gross - total),
            customerId: customer._id,
            status: "COMPLETED",
            orderId: sourceOrderId(invoice.id),
            paymentStatus: "UNPAID",
            remainingAmount: total,
            exchangeRateSnapshots: [{ currency: "THB", rate: numberValue(invoice.rate) || 1 }],
            payments: [],
            notes: [{
              text: `${SOURCE_PREFIX} pending debt invoice ${invoice.id}; old cashier ${invoice.cashier_id || "-"}`,
              createdBy: CASHIER_ID,
              createdAt,
            }],
            cashierId,
            saleMode: "retail",
            createdAt,
            updatedAt: createdAt,
          }], { session });

          await DebtTransaction.create([{
            tenantId,
            customer: customer._id,
            order: createdOrders[0]._id,
            type: "CREDIT",
            amount: total,
            balanceBefore: 0,
            balanceAfter: 0,
            processedBy: cashierId,
            note: `${SOURCE_PREFIX} debt invoice ${invoice.id}`,
            createdAt,
            updatedAt: createdAt,
          }], { session });
        });
      } finally {
        await session.endSession();
      }
    }

    for (const invoice of paidDebtInvoices) {
      const order = await Order.findOne({ tenantId, orderId: sourceOrderId(invoice.id) });
      if (!order || !order.customerId) throw new Error(`Order/customer missing for invoice ${invoice.id}`);
      affectedCustomerIds.add(order.customerId.toString());
      const paidAt = parseVientianeDate(invoice.date_payment!);
      const receiptNumber = repaymentReceipt(invoice.id);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const existingRepayment = await DebtTransaction.exists({
            tenantId,
            order: order._id,
            type: "DEBIT",
            receiptNumber,
          }).session(session);
          if (!existingRepayment) {
            await DebtTransaction.create([{
              tenantId,
              customer: order.customerId,
              order: order._id,
              type: "DEBIT",
              amount: order.total,
              balanceBefore: 0,
              balanceAfter: 0,
              processedBy: cashierId,
              paymentMethod: "ADJUSTMENT",
              receiptNumber,
              reference: `${SOURCE_PREFIX}:INVOICE:${invoice.id}`,
              note: `${SOURCE_PREFIX} imported debt repayment invoice ${invoice.id}; payment method unavailable`,
              createdAt: paidAt,
              updatedAt: paidAt,
            }], { session });
          }

          await Order.updateOne(
            { _id: order._id, tenantId },
            {
              $set: {
                paidAmount: order.total,
                remainingAmount: 0,
                paymentStatus: "PAID",
                updatedAt: paidAt,
              },
            },
            { session, timestamps: false }
          );
        });
      } finally {
        await session.endSession();
      }
    }

    const pendingOrders = await Order.find({ tenantId, orderId: { $in: pendingOrderIds } })
      .select("customerId");
    for (const order of pendingOrders) {
      if (order.customerId) affectedCustomerIds.add(order.customerId.toString());
    }

    await recomputeCustomerBalances(
      tenantId,
      Array.from(affectedCustomerIds).map((id) => new mongoose.Types.ObjectId(id))
    );

    console.log(JSON.stringify({
      applied: true,
      repaymentsCreated: repaymentsToCreate.length,
      paidOrdersReconciled: paidOrdersToReconcile.length,
      pendingOrdersCreated: pendingOrdersToCreate.length,
      customersRecomputed: affectedCustomerIds.size,
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
};

main().catch(async (error) => {
  console.error("Latdashop debt history reconciliation failed:", error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
