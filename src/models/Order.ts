import mongoose, { Schema, Document } from "mongoose";

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  quantity: number;
  price: number;
  cost: number;
  name: string; // Snapshot
}

export interface IOrder extends Document {
  tenantId: mongoose.Types.ObjectId;
  tenantSnapshot?: {
    shopName?: string;
    logo?: string;
    address?: string;
    phone?: string;
    bankName?: string;
    bankAccount?: string;
    bankQr?: string;
  };
  items: IOrderItem[];
  total: number;
  paymentMethod: "CASH" | "TRANSFER" | "DEBT";
  paidAmount: number;
  change: number;
  discount: number;
  customerId?: mongoose.Types.ObjectId;
  status: "COMPLETED" | "CANCELLED";
  orderId: string; // 10-digit short ID
  paymentStatus: "PAID" | "PARTIAL" | "UNPAID";
  remainingAmount: number; // For debt tracking
  exchangeRateSnapshots?: { currency: string; rate: number }[];
  payments: {
    currency: string;
    amount: number;
    rate: number;
    amountInLAK: number;
    paidAt?: Date;
    note?: string;
  }[];
  notes?: {
    text: string;
    createdBy: string;
    createdAt: Date;
  }[];
  cashierId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    tenantSnapshot: {
      shopName: { type: String },
      logo: { type: String },
      address: { type: String },
      phone: { type: String },
      bankName: { type: String },
      bankAccount: { type: String },
      bankQr: { type: String },
    },
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        cost: { type: Number, required: true },
        name: { type: String, required: true },
      },
    ],
    total: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ["CASH", "TRANSFER", "DEBT"],
      required: true,
    },
    paidAmount: { type: Number, required: true },
    change: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    status: { type: String, enum: ["COMPLETED", "CANCELLED"], default: "COMPLETED" },
    orderId: { type: String, required: true, unique: true },
    paymentStatus: { type: String, enum: ["PAID", "PARTIAL", "UNPAID"], default: "PAID" },
    remainingAmount: { type: Number, default: 0 },
    exchangeRateSnapshots: [
      {
        currency: { type: String, required: true },
        rate: { type: Number, required: true },
      },
    ],
    payments: [
      {
        currency: { type: String, required: true },
        amount: { type: Number, required: true },
        rate: { type: Number, required: true },
        amountInLAK: { type: Number, required: true },
        paidAt: { type: Date },
        note: { type: String },
      },
    ],
    notes: [
      {
        text: { type: String, required: true },
        createdBy: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Indexes for performance
OrderSchema.index({ tenantId: 1, createdAt: -1 });
OrderSchema.index({ customerId: 1, paymentStatus: 1 });

export default mongoose.model<IOrder>("Order", OrderSchema);
