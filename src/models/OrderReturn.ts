import mongoose, { Document, Schema } from "mongoose";

export interface IOrderReturn extends Document {
  tenantId: mongoose.Types.ObjectId;
  returnId: string;
  order: mongoose.Types.ObjectId;
  customer?: mongoose.Types.ObjectId;
  items: Array<{
    product: mongoose.Types.ObjectId;
    name: string;
    soldQuantity: number;
    quantity: number;
    price: number;
    cost: number;
    condition: "SELLABLE" | "DAMAGED" | "DEFECTIVE" | "INCOMPLETE";
    disposition: "NO_RESTOCK" | "RESTOCK_APPROVED" | "WRITE_OFF";
    restockedAt?: Date;
    restockedBy?: mongoose.Types.ObjectId;
  }>;
  refundAmount: number;
  refundPaymentTransaction?: mongoose.Types.ObjectId;
  reasonCode: string;
  note?: string;
  requestedBy: mongoose.Types.ObjectId;
  approvedBy: mongoose.Types.ObjectId;
  exchangeGroupId?: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderReturnSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    returnId: { type: String, required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer" },
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        soldQuantity: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true, min: 0 },
        cost: { type: Number, required: true, min: 0 },
        condition: {
          type: String,
          enum: ["SELLABLE", "DAMAGED", "DEFECTIVE", "INCOMPLETE"],
          required: true,
        },
        disposition: {
          type: String,
          enum: ["NO_RESTOCK", "RESTOCK_APPROVED", "WRITE_OFF"],
          default: "NO_RESTOCK",
        },
        restockedAt: { type: Date },
        restockedBy: { type: Schema.Types.ObjectId, ref: "User" },
      },
    ],
    refundAmount: { type: Number, default: 0, min: 0 },
    refundPaymentTransaction: { type: Schema.Types.ObjectId, ref: "PaymentTransaction" },
    reasonCode: { type: String, required: true, trim: true },
    note: { type: String, trim: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    exchangeGroupId: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
  },
  { timestamps: true }
);

OrderReturnSchema.index({ tenantId: 1, returnId: 1 }, { unique: true });
OrderReturnSchema.index({ tenantId: 1, order: 1, createdAt: -1 });
OrderReturnSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

export default mongoose.model<IOrderReturn>("OrderReturn", OrderReturnSchema);
