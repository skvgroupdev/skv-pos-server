import mongoose, { Document, Schema } from "mongoose";

export type PaymentSourceType = "SALE" | "DEBT_REPAYMENT" | "REFUND" | "REVERSAL";
export type PaymentMethod = "CASH" | "TRANSFER" | "MIXED";

export interface IPaymentLine {
  method: "CASH" | "TRANSFER";
  currency: string;
  amount: number;
  rate: number;
  amountInLAK: number;
  reference?: string;
}

export interface IPaymentTransaction extends Document {
  tenantId: mongoose.Types.ObjectId;
  transactionId: string;
  sourceType: PaymentSourceType;
  direction: "IN" | "OUT";
  order?: mongoose.Types.ObjectId;
  customer?: mongoose.Types.ObjectId;
  processedBy: mongoose.Types.ObjectId;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  paymentMethod: PaymentMethod;
  payments: IPaymentLine[];
  grossReceivedInLAK: number;
  appliedAmountInLAK: number;
  changeInLAK: number;
  reasonCode?: string;
  note?: string;
  status: "POSTED" | "REVERSED";
  reversalOf?: mongoose.Types.ObjectId;
  idempotencyKey?: string;
  sourceRecordKey?: string;
  migrationStatus: "COMPLETE" | "INCOMPLETE";
  createdAt: Date;
  updatedAt: Date;
}

const PaymentLineSchema = new Schema(
  {
    method: { type: String, enum: ["CASH", "TRANSFER"], required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amountInLAK: { type: Number, required: true, min: 0 },
    reference: { type: String, trim: true },
  },
  { _id: false }
);

const PaymentTransactionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    transactionId: { type: String, required: true },
    sourceType: {
      type: String,
      enum: ["SALE", "DEBT_REPAYMENT", "REFUND", "REVERSAL"],
      required: true,
    },
    direction: { type: String, enum: ["IN", "OUT"], required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    customer: { type: Schema.Types.ObjectId, ref: "Customer" },
    processedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    paymentMethod: {
      type: String,
      enum: ["CASH", "TRANSFER", "MIXED"],
      required: true,
    },
    payments: { type: [PaymentLineSchema], default: [] },
    grossReceivedInLAK: { type: Number, required: true, min: 0 },
    appliedAmountInLAK: { type: Number, required: true, min: 0 },
    changeInLAK: { type: Number, default: 0, min: 0 },
    reasonCode: { type: String, trim: true },
    note: { type: String, trim: true },
    status: { type: String, enum: ["POSTED", "REVERSED"], default: "POSTED" },
    reversalOf: { type: Schema.Types.ObjectId, ref: "PaymentTransaction" },
    idempotencyKey: { type: String, trim: true },
    sourceRecordKey: { type: String, trim: true },
    migrationStatus: {
      type: String,
      enum: ["COMPLETE", "INCOMPLETE"],
      default: "COMPLETE",
    },
  },
  { timestamps: true }
);

PaymentTransactionSchema.index({ tenantId: 1, transactionId: 1 }, { unique: true });
PaymentTransactionSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);
PaymentTransactionSchema.index(
  { tenantId: 1, sourceRecordKey: 1 },
  { unique: true, sparse: true }
);
PaymentTransactionSchema.index({ tenantId: 1, createdAt: -1 });
PaymentTransactionSchema.index({ tenantId: 1, processedBy: 1, createdAt: -1 });
PaymentTransactionSchema.index({ tenantId: 1, order: 1, createdAt: 1 });

export default mongoose.model<IPaymentTransaction>(
  "PaymentTransaction",
  PaymentTransactionSchema
);
