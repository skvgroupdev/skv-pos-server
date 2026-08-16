import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import mongoose from "mongoose";
import "../config/env";
import Customer from "../models/Customer";
import DebtTransaction from "../models/DebtTransaction";
import Order from "../models/Order";
import PaymentTransaction from "../models/PaymentTransaction";
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
const INCLUDE_DEBT = process.argv.includes("--include-debt");
const START_DATE = process.env.LATDASHOP_START_DATE || "";
const END_DATE = process.env.LATDASHOP_END_DATE || "";

type ExportEntry = {
  type?: string;
  name?: string;
  data?: Record<string, string>[];
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
  m_discount_lak: string;
  m_discount_thb: string;
  pay_type: "cash" | "transfer" | "debt" | string;
  pay_currency: string;
  date_create: string;
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

type ProductRow = {
  barcode: string;
  title: string;
  use_for: string;
  unit: string;
  category: string;
  cost_thb: string;
  cost_lak: string;
  wholesale_thb: string;
  wholesale_lak: string;
  retail_thb: string;
  retail_lak: string;
  qty_alert: string;
  supplier: string;
  brand: string;
  status: string;
  code?: string;
  page?: string;
  No?: string;
  size?: string;
};

type Tables = {
  invoice: InvoiceRow[];
  invoicedetail: InvoiceDetailRow[];
  products: ProductRow[];
};

const text = (value: unknown) => String(value ?? "").trim();

const numberValue = (value: unknown) => {
  const parsed = Number(text(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const lakAmount = (lakValue: unknown, thbValue: unknown, rateValue: unknown) => {
  const rate = numberValue(rateValue);
  return Math.round(numberValue(lakValue) + numberValue(thbValue) * rate);
};

const sourceOrderId = (mysqlInvoiceId: string) =>
  `LDOLD${mysqlInvoiceId.padStart(5, "0").slice(-5)}`;

const parseVientianeDate = (value: string) => {
  const normalized = text(value).replace(" ", "T");
  return new Date(`${normalized}+07:00`);
};

const inDateRange = (invoice: InvoiceRow) => {
  const day = text(invoice.date_create).slice(0, 10);
  if (START_DATE && day < START_DATE) return false;
  if (END_DATE && day > END_DATE) return false;
  return true;
};

const paymentMethodFor = (payType: string) => {
  if (payType === "transfer") return "TRANSFER" as const;
  if (payType === "debt") return "DEBT" as const;
  return "CASH" as const;
};

const productLakPrice = (thbValue: unknown, lakValue: unknown, fallbackRate = 700) => {
  const thb = numberValue(thbValue);
  if (thb > 0) return Math.round(thb * fallbackRate);
  return Math.round(numberValue(lakValue));
};

const resolveCashier = async (
  cashierIdentifier: string,
  tenantObjectId: mongoose.Types.ObjectId
) => {
  const scopedOrConditions: Record<string, unknown>[] = [{ userid: cashierIdentifier }];
  if (mongoose.Types.ObjectId.isValid(cashierIdentifier)) {
    scopedOrConditions.unshift({ _id: new mongoose.Types.ObjectId(cashierIdentifier) });
  }

  const cashier = await User.findOne({
    tenantId: tenantObjectId,
    $or: scopedOrConditions,
  }).lean();
  if (cashier) return cashier;

  if (mongoose.Types.ObjectId.isValid(cashierIdentifier)) {
    const exactUser = await User.findById(cashierIdentifier).lean();
    const exactUserTenantId = exactUser?.tenantId?.toString();
    if (exactUser && !exactUserTenantId) {
      console.warn(
        `Warning: using cashier ${cashierIdentifier} even though the user document has no tenantId.`
      );
      return exactUser;
    }
    if (exactUser && exactUserTenantId !== tenantObjectId.toString()) {
      throw new Error(
        `Cashier ${cashierIdentifier} belongs to tenant ${exactUserTenantId}, not ${tenantObjectId.toString()}`
      );
    }
  }

  const availableUsers = await User.find({ tenantId: tenantObjectId })
    .select("_id userid username roles status")
    .lean();
  throw new Error(
    `Cashier not found in tenant: ${cashierIdentifier}. Available tenant users: ${JSON.stringify(
      availableUsers.map((user) => ({
        _id: user._id?.toString(),
        userid: user.userid,
        username: user.username,
        roles: user.roles,
        status: user.status,
      }))
    )}`
  );
};

const loadTables = (): Tables => {
  const exported = JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as ExportEntry[];
  const byName = new Map(
    exported
      .filter((entry) => entry.type === "table" && entry.name && Array.isArray(entry.data))
      .map((entry) => [entry.name!, entry.data!])
  );
  const invoice = (byName.get("invoice") || []) as InvoiceRow[];
  const invoicedetail = (byName.get("invoicedetail") || []) as InvoiceDetailRow[];
  const products = (byName.get("products") || []) as ProductRow[];
  if (!invoice.length || !invoicedetail.length) {
    throw new Error(`Missing invoice/invoicedetail data in ${JSON_PATH}`);
  }
  return { invoice, invoicedetail, products };
};

const customerPhoneFor = (name: string) => {
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 16);
  return `LEGACY-LATDA-${hash}`;
};

const summarizeRows = (rows: InvoiceRow[], detailsByInvoice: Map<string, InvoiceDetailRow[]>) => {
  return rows.reduce(
    (acc, invoice) => {
      const total = lakAmount(invoice.total_checkout_lak, invoice.total_checkout_thb, invoice.rate);
      const gross = lakAmount(invoice.total_lak, invoice.total_thb, invoice.rate);
      const cost = (detailsByInvoice.get(invoice.id) || []).reduce((sum, detail) => {
        const unitCost = numberValue(detail.cost_thb) > 0
          ? numberValue(detail.cost_thb) * numberValue(invoice.rate)
          : numberValue(detail.cost_lak);
        return sum + unitCost * numberValue(detail.qty);
      }, 0);
      acc.count += 1;
      acc.grossSales += gross;
      acc.netSales += total;
      acc.discount += gross - total;
      acc.cost += cost;
      acc.profit += total - cost;
      if (invoice.pay_type === "debt") acc.debt += total;
      else acc.received += total;
      return acc;
    },
    { count: 0, grossSales: 0, netSales: 0, discount: 0, cost: 0, profit: 0, received: 0, debt: 0 }
  );
};

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (!mongoose.Types.ObjectId.isValid(TENANT_ID)) throw new Error(`Invalid tenant id: ${TENANT_ID}`);

  const tenantObjectId = new mongoose.Types.ObjectId(TENANT_ID);
  const tables = loadTables();
  const detailsByInvoice = new Map<string, InvoiceDetailRow[]>();
  for (const detail of tables.invoicedetail) {
    if (!detailsByInvoice.has(detail.invoice_id)) detailsByInvoice.set(detail.invoice_id, []);
    detailsByInvoice.get(detail.invoice_id)!.push(detail);
  }

  const completedInvoices = tables.invoice
    .filter((invoice) => invoice.status === "completed")
    .filter((invoice) => ["cash", "transfer", "debt"].includes(invoice.pay_type))
    .filter(inDateRange)
    .filter((invoice) => INCLUDE_DEBT || invoice.pay_type !== "debt");

  const sourceProductByBarcode = new Map(tables.products.map((product) => [text(product.barcode), product]));

  await mongoose.connect(process.env.MONGO_URI);

  const [tenant, cashier] = await Promise.all([
    Tenant.findById(tenantObjectId).lean(),
    resolveCashier(CASHIER_ID, tenantObjectId),
  ]);
  if (!tenant) throw new Error(`Tenant not found: ${TENANT_ID}`);
  if (!cashier) throw new Error(`Cashier not found in tenant: ${CASHIER_ID}`);
  const cashierObjectId = cashier._id as mongoose.Types.ObjectId;

  const sourceOrderIds = completedInvoices.map((invoice) => sourceOrderId(invoice.id));
  const existingOrders = new Set(
    (await Order.find({ tenantId: tenantObjectId, orderId: { $in: sourceOrderIds } }).select("orderId").lean())
      .map((order) => order.orderId)
  );

  const barcodes = Array.from(new Set(tables.invoicedetail.map((detail) => text(detail.barcode)).filter(Boolean)));
  const existingProducts = await Product.find({ tenantId: tenantObjectId, barcode: { $in: barcodes } })
    .select("_id barcode name category")
    .lean();
  const productByBarcode = new Map(existingProducts.map((product) => [text(product.barcode), product]));
  const missingBarcodes = barcodes.filter((barcode) => !productByBarcode.has(barcode));

  const activeInvoices = completedInvoices.filter((invoice) => !existingOrders.has(sourceOrderId(invoice.id)));
  const debtInvoices = completedInvoices.filter((invoice) => invoice.pay_type === "debt");
  const customerNames = Array.from(
    new Set(debtInvoices.map((invoice) => text(invoice.member_id) || `Legacy customer ${invoice.id}`))
  );
  const existingCustomers = await Customer.find({
    tenantId: tenantObjectId,
    phone: { $in: customerNames.map(customerPhoneFor) },
  }).select("_id name phone totalDebt").lean();
  const customerByPhone = new Map(existingCustomers.map((customer) => [customer.phone, customer]));
  const existingMigratedDebtTransactions = await DebtTransaction.countDocuments({
    tenantId: tenantObjectId,
    note: /^LATDA_MYSQL debt invoice/,
  });

  const summary = summarizeRows(completedInvoices, detailsByInvoice);
  const activeSummary = summarizeRows(activeInvoices, detailsByInvoice);
  const julySummary = summarizeRows(
    completedInvoices.filter((invoice) => text(invoice.date_create).slice(0, 7) === "2026-07"),
    detailsByInvoice
  );

  const dryRunReport = {
    mode: APPLY ? "APPLY" : "DRY_RUN",
    tenantId: TENANT_ID,
    cashierId: CASHIER_ID,
    jsonPath: JSON_PATH,
    includeDebt: INCLUDE_DEBT,
    dateFilter: { startDate: START_DATE || null, endDate: END_DATE || null },
    source: {
      completedInvoices: completedInvoices.length,
      invoiceDetails: tables.invoicedetail.length,
      sourceProducts: tables.products.length,
    },
    existing: {
      matchingOrdersAlreadyImported: existingOrders.size,
      matchingProducts: productByBarcode.size,
      missingProductsToCreate: missingBarcodes.length,
      existingDebtCustomers: existingCustomers.length,
    },
    toCreate: {
      orders: activeInvoices.length,
      saleLedgers: activeInvoices.filter((invoice) => invoice.pay_type !== "debt").length,
      customers: customerNames.filter((name) => !customerByPhone.has(customerPhoneFor(name))).length,
      debtTransactions: Math.max(0, debtInvoices.length - existingMigratedDebtTransactions),
    },
    totals: summary,
    totalsPendingCreate: activeSummary,
    july2026: julySummary,
    topMissingProductBarcodes: missingBarcodes.slice(0, 20),
  };

  console.log(JSON.stringify(dryRunReport, null, 2));
  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  let createdProducts = 0;
  let createdCustomers = 0;
  let createdOrders = 0;
  let createdLedgers = 0;
  let createdDebtTransactions = 0;

  try {
    if (missingBarcodes.length > 0) {
      const productResult = await Product.bulkWrite(
        missingBarcodes.map((barcode) => {
          const source = sourceProductByBarcode.get(barcode);
          return {
            updateOne: {
              filter: { tenantId: tenantObjectId, barcode },
              update: {
                $setOnInsert: {
                  tenantId: tenantObjectId,
                  name: text(source?.title) || barcode,
                  description: text(source?.use_for),
                  costPrice: productLakPrice(source?.cost_thb, source?.cost_lak),
                  costCurrency: "LAK",
                  sellPrice: productLakPrice(source?.retail_thb, source?.retail_lak),
                  wholesalePrice: productLakPrice(source?.wholesale_thb, source?.wholesale_lak),
                  stock: 0,
                  reservedStock: 0,
                  minStock: numberValue(source?.qty_alert),
                  unit: text(source?.unit) || "ອັນ",
                  sku: text(source?.code),
                  barcode,
                  supplier: text(source?.supplier),
                  brand: text(source?.brand),
                  modelName: text(source?.use_for),
                  category: text(source?.category).replace(/\s+/g, " ").toUpperCase() || "GENERAL",
                  images: [],
                  imageVariants: [],
                  status: text(source?.status) === "inactive" ? "inactive" : "active",
                  catalog: {
                    No: text(source?.No),
                    code: text(source?.code),
                    page: text(source?.page),
                    number: text(source?.size),
                  },
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false }
      );
      createdProducts = productResult.upsertedCount;
    }

    const refreshedProducts = await Product.find({ tenantId: tenantObjectId, barcode: { $in: barcodes } })
      .select("_id barcode name category")
      .lean();
    productByBarcode.clear();
    for (const product of refreshedProducts) {
      productByBarcode.set(text(product.barcode), product);
    }

    const newCustomerNames = customerNames.filter((name) => !customerByPhone.has(customerPhoneFor(name)));
    if (newCustomerNames.length > 0) {
      const customerResult = await Customer.bulkWrite(
        newCustomerNames.map((name) => ({
          updateOne: {
            filter: { tenantId: tenantObjectId, phone: customerPhoneFor(name) },
            update: { $setOnInsert: { tenantId: tenantObjectId, name, phone: customerPhoneFor(name), totalDebt: 0 } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      createdCustomers = customerResult.upsertedCount;
    }

    const refreshedCustomers = await Customer.find({
      tenantId: tenantObjectId,
      phone: { $in: customerNames.map(customerPhoneFor) },
    }).select("_id name phone totalDebt").lean();
    customerByPhone.clear();
    for (const customer of refreshedCustomers) {
      customerByPhone.set(customer.phone, customer);
    }

    for (let invoiceIndex = 0; invoiceIndex < completedInvoices.length; invoiceIndex += 1) {
      const invoice = completedInvoices[invoiceIndex];
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
        const orderId = sourceOrderId(invoice.id);

        const createdAt = parseVientianeDate(invoice.date_create);
        const details = detailsByInvoice.get(invoice.id) || [];
        if (!details.length) throw new Error(`Invoice ${invoice.id} has no detail rows`);

        const total = lakAmount(invoice.total_checkout_lak, invoice.total_checkout_thb, invoice.rate);
        const gross = lakAmount(invoice.total_lak, invoice.total_thb, invoice.rate);
        const discount = Math.max(0, gross - total);
        const paymentMethod = paymentMethodFor(invoice.pay_type);
        const paymentLine = paymentMethod === "DEBT"
          ? []
          : [{
              currency: text(invoice.pay_currency) || "LAK",
              amount: text(invoice.pay_currency).toUpperCase() === "THB"
                ? numberValue(invoice.total_checkout_thb)
                : total,
              rate: text(invoice.pay_currency).toUpperCase() === "THB" ? numberValue(invoice.rate) : 1,
              amountInLAK: total,
              paidAt: createdAt,
              note: `${SOURCE_PREFIX} invoice ${invoice.id}`,
            }];

        const customerName = text(invoice.member_id) || `Legacy customer ${invoice.id}`;
        const customer = paymentMethod === "DEBT"
          ? await Customer.findOne({ tenantId: tenantObjectId, phone: customerPhoneFor(customerName) }).session(session)
          : null;

        let order = await Order.findOne({ tenantId: tenantObjectId, orderId }).session(session);
        if (!order) {
          const createdOrder = await Order.create(
            [{
              tenantId: tenantObjectId,
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
              items: details.map((detail) => {
                const product = productByBarcode.get(text(detail.barcode));
                if (!product) throw new Error(`Missing product ${detail.barcode} for invoice ${invoice.id}`);
                const qty = numberValue(detail.qty);
                const lineTotal = lakAmount(detail.total_lak, detail.total_thb, invoice.rate);
                const unitPrice = qty > 0 ? Math.round(lineTotal / qty) : lineTotal;
                const unitCost = numberValue(detail.cost_thb) > 0
                  ? Math.round(numberValue(detail.cost_thb) * numberValue(invoice.rate))
                  : Math.round(numberValue(detail.cost_lak));
                return {
                  product: product._id,
                  quantity: qty,
                  price: unitPrice,
                  cost: unitCost,
                  name: text(detail.title) || product.name,
                };
              }),
              total,
              paymentMethod,
              paidAmount: paymentMethod === "DEBT" ? 0 : total,
              change: 0,
              discount,
              customerId: customer?._id,
              status: "COMPLETED",
              orderId,
              paymentStatus: paymentMethod === "DEBT" ? "UNPAID" : "PAID",
              remainingAmount: paymentMethod === "DEBT" ? total : 0,
              exchangeRateSnapshots: [{ currency: "THB", rate: numberValue(invoice.rate) || 1 }],
              payments: paymentLine,
              notes: [{
                text: `${SOURCE_PREFIX} invoice ${invoice.id}; old cashier ${invoice.cashier_id || "-"}`,
                createdBy: CASHIER_ID,
                createdAt,
              }],
              cashierId: cashierObjectId,
              saleMode: "retail",
              createdAt,
              updatedAt: createdAt,
            }],
            { session }
          );
          order = createdOrder[0];
          createdOrders += 1;
        }

        if (paymentMethod !== "DEBT") {
          const existingLedger = await PaymentTransaction.exists({
            tenantId: tenantObjectId,
            sourceRecordKey: `${SOURCE_PREFIX}:ORDER:${invoice.id}`,
          }).session(session);
          if (!existingLedger) {
            await PaymentTransaction.create(
              [{
                tenantId: tenantObjectId,
                transactionId: `MIG-LATDA-${orderId}`,
                sourceType: "SALE",
                direction: "IN",
                order: order._id,
                processedBy: cashierObjectId,
                paymentMethod: paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
                payments: paymentLine.map((line) => ({
                  method: paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
                  currency: line.currency,
                  amount: line.amount,
                  rate: line.rate,
                  amountInLAK: line.amountInLAK,
                })),
                grossReceivedInLAK: total,
                appliedAmountInLAK: total,
                changeInLAK: 0,
                note: `${SOURCE_PREFIX} invoice ${invoice.id}`,
                status: "POSTED",
                idempotencyKey: `${SOURCE_PREFIX}:ORDER:${invoice.id}`,
                sourceRecordKey: `${SOURCE_PREFIX}:ORDER:${invoice.id}`,
                migrationStatus: "COMPLETE",
                createdAt,
                updatedAt: createdAt,
              }],
              { session }
            );
            createdLedgers += 1;
          }
        } else if (customer) {
          if (order.customerId?.toString() !== customer._id.toString()) {
            order.customerId = customer._id;
            await order.save({ session });
          }

          const existingDebtTransaction = await DebtTransaction.findOne({
            tenantId: tenantObjectId,
            order: order._id,
            type: "CREDIT",
          }).session(session);
          if (!existingDebtTransaction) {
            const beforeDebt = numberValue(customer.totalDebt);
            await DebtTransaction.create(
              [{
                tenantId: tenantObjectId,
                customer: customer._id,
                order: order._id,
                type: "CREDIT",
                amount: total,
                balanceBefore: beforeDebt,
                balanceAfter: beforeDebt + total,
                processedBy: cashierObjectId,
                note: `${SOURCE_PREFIX} debt invoice ${invoice.id}`,
                createdAt,
                updatedAt: createdAt,
              }],
              { session }
            );
            await Customer.updateOne(
              { _id: customer._id, tenantId: tenantObjectId },
              { $inc: { totalDebt: total }, $set: { updatedAt: createdAt } },
              { session }
            );
            createdDebtTransactions += 1;
          } else if (existingDebtTransaction.customer.toString() !== customer._id.toString()) {
            existingDebtTransaction.customer = customer._id;
            await existingDebtTransaction.save({ session });
          }
        }
        });
      } finally {
        await session.endSession();
      }
      if ((invoiceIndex + 1) % 100 === 0 || invoiceIndex + 1 === completedInvoices.length) {
        console.log(`Processed ${invoiceIndex + 1}/${completedInvoices.length} invoices`);
      }
    }

    await Customer.updateMany(
      { tenantId: tenantObjectId, phone: /^LEGACY-LATDA-/ },
      { $set: { totalDebt: 0 } }
    );
    const debtTotalsByCustomer = await Order.aggregate([
      {
        $match: {
          tenantId: tenantObjectId,
          orderId: /^LDOLD/,
          status: { $ne: "CANCELLED" },
          remainingAmount: { $gt: 0 },
          customerId: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: "$customerId", totalDebt: { $sum: "$remainingAmount" } } },
    ]);
    for (const row of debtTotalsByCustomer) {
      await Customer.updateOne(
        { _id: row._id, tenantId: tenantObjectId },
        { $set: { totalDebt: row.totalDebt } }
      );
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log(JSON.stringify({
    applied: true,
    createdProducts,
    createdCustomers,
    createdOrders,
    createdLedgers,
    createdDebtTransactions,
  }, null, 2));
};

main().catch(async (error) => {
  console.error("Latdashop sales migration failed:", error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
