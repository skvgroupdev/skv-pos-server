import { randomBytes } from "crypto";
import mongoose, { ClientSession } from "mongoose";
import PaymentTransaction, {
  IPaymentLine,
  PaymentMethod,
  PaymentSourceType,
} from "../models/PaymentTransaction";

export interface PaymentLineInput {
  method?: "CASH" | "TRANSFER";
  currency?: string;
  amount: number;
  rate?: number;
  amountInLAK?: number;
  reference?: string;
}

interface CreateLedgerEntryInput {
  tenantId: string;
  sourceType: PaymentSourceType;
  direction: "IN" | "OUT";
  orderId?: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  processedBy: string;
  approvedBy?: string;
  paymentMethod: PaymentMethod;
  payments: PaymentLineInput[];
  appliedAmountInLAK: number;
  changeInLAK?: number;
  reasonCode?: string;
  note?: string;
  reversalOf?: mongoose.Types.ObjectId;
  idempotencyKey?: string;
  sourceRecordKey?: string;
  session?: ClientSession;
}

const createTransactionId = () =>
  `TX${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString("hex").toUpperCase()}`;

export const normalizePaymentLines = (
  payments: PaymentLineInput[],
  defaultMethod: Exclude<PaymentMethod, "MIXED">
): IPaymentLine[] => {
  return payments.map((payment) => {
    const currency = (payment.currency || "LAK").toUpperCase();
    const amount = Number(payment.amount);
    const rate = currency === "LAK" ? 1 : Number(payment.rate);
    const amountInLAK =
      payment.amountInLAK === undefined
        ? Math.round(amount * rate)
        : Number(payment.amountInLAK);
    const method = payment.method || defaultMethod;
    const reference = payment.reference?.trim();

    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid payment amount");
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid exchange rate");
    if (!Number.isFinite(amountInLAK) || amountInLAK <= 0) {
      throw new Error("Invalid LAK payment amount");
    }
    return { method, currency, amount, rate, amountInLAK, reference };
  });
};

export const createLedgerEntry = async (input: CreateLedgerEntryInput) => {
  if (input.idempotencyKey) {
    const existing = await PaymentTransaction.findOne({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
    }).session(input.session || null);
    if (existing) return existing;
  }

  const defaultMethod = input.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH";
  const paymentLines = normalizePaymentLines(input.payments, defaultMethod);
  const grossReceivedInLAK = paymentLines.reduce((sum, line) => sum + line.amountInLAK, 0);
  const changeInLAK = Number(input.changeInLAK || 0);
  const appliedAmountInLAK = Number(input.appliedAmountInLAK);

  if (!Number.isFinite(appliedAmountInLAK) || appliedAmountInLAK < 0) {
    throw new Error("Invalid applied payment amount");
  }
  if (Math.abs(grossReceivedInLAK - appliedAmountInLAK - changeInLAK) > 1) {
    throw new Error("Payment breakdown does not match applied amount and change");
  }

  const docs = await PaymentTransaction.create(
    [
      {
        tenantId: input.tenantId,
        transactionId: createTransactionId(),
        sourceType: input.sourceType,
        direction: input.direction,
        order: input.orderId,
        customer: input.customerId,
        processedBy: input.processedBy,
        approvedBy: input.approvedBy,
        approvedAt: input.approvedBy ? new Date() : undefined,
        paymentMethod: input.paymentMethod,
        payments: paymentLines,
        grossReceivedInLAK,
        appliedAmountInLAK,
        changeInLAK,
        reasonCode: input.reasonCode,
        note: input.note,
        reversalOf: input.reversalOf,
        idempotencyKey: input.idempotencyKey,
        sourceRecordKey: input.sourceRecordKey,
      },
    ],
    { session: input.session }
  );

  return docs[0];
};
