import "../config/env";
import mongoose from "mongoose";
import DebtTransaction from "../models/DebtTransaction";
import Order from "../models/Order";
import PaymentTransaction from "../models/PaymentTransaction";

const run = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);

  let migratedOrders = 0;
  let migratedDebts = 0;
  let skippedDebts = 0;

  for await (const order of Order.find({ paidAmount: { $gt: 0 } }).cursor()) {
    const sourceRecordKey = `ORDER:${order._id.toString()}`;
    const existing = await PaymentTransaction.exists({ tenantId: order.tenantId, sourceRecordKey });
    if (existing) continue;

    const fallbackMethod: "CASH" | "TRANSFER" = order.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH";
    const payments = order.payments?.length
      ? order.payments.map((line: any) => ({
          method: fallbackMethod,
          currency: line.currency || "LAK",
          amount: line.amount,
          rate: line.rate || 1,
          amountInLAK: line.amountInLAK,
          reference: line.reference,
        }))
      : [{
          method: fallbackMethod,
          currency: "LAK",
          amount: order.paidAmount,
          rate: 1,
          amountInLAK: order.paidAmount,
        }];

    await PaymentTransaction.create({
      tenantId: order.tenantId,
      transactionId: `MIG-ORDER-${order.orderId}`,
      sourceType: "SALE",
      direction: "IN",
      order: order._id,
      customer: order.customerId,
      processedBy: order.cashierId,
      paymentMethod: fallbackMethod,
      payments,
      grossReceivedInLAK: order.paidAmount,
      appliedAmountInLAK: Math.max(0, order.paidAmount - order.change),
      changeInLAK: order.change,
      status: order.status === "CANCELLED" ? "REVERSED" : "POSTED",
      sourceRecordKey,
      migrationStatus: order.payments?.length ? "COMPLETE" : "INCOMPLETE",
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    });
    migratedOrders += 1;
  }

  for await (const debt of DebtTransaction.find({ type: "DEBIT", paymentMethod: { $ne: "ADJUSTMENT" } }).cursor()) {
    const sourceRecordKey = `DEBT:${debt._id.toString()}`;
    const existing = await PaymentTransaction.exists({ tenantId: debt.tenantId, sourceRecordKey });
    if (existing) continue;
    if (!debt.processedBy) {
      skippedDebts += 1;
      continue;
    }

    const fallbackMethod: "CASH" | "TRANSFER" = debt.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH";
    const payments = debt.paymentBreakdown?.length
      ? debt.paymentBreakdown
      : [{
          method: fallbackMethod,
          currency: "LAK",
          amount: debt.amount,
          rate: 1,
          amountInLAK: debt.amount,
          reference: debt.reference,
        }];
    await PaymentTransaction.create({
      tenantId: debt.tenantId,
      transactionId: `MIG-DEBT-${debt.receiptNumber || debt._id.toString()}`,
      sourceType: "DEBT_REPAYMENT",
      direction: "IN",
      order: debt.order,
      customer: debt.customer,
      processedBy: debt.processedBy,
      paymentMethod: debt.paymentMethod === "MIXED" ? "MIXED" : fallbackMethod,
      payments,
      grossReceivedInLAK: debt.amount,
      appliedAmountInLAK: debt.amount,
      changeInLAK: 0,
      note: debt.note,
      status: "POSTED",
      sourceRecordKey,
      migrationStatus: debt.paymentBreakdown?.length ? "COMPLETE" : "INCOMPLETE",
      createdAt: debt.createdAt,
      updatedAt: debt.updatedAt,
    });
    migratedDebts += 1;
  }

  console.log(JSON.stringify({ migratedOrders, migratedDebts, skippedDebts }, null, 2));
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
