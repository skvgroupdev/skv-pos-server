import mongoose, { Schema, Document } from "mongoose";

export interface IInventoryTransaction extends Document {
  tenantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  type: "IN_PURCHASE" | "IN_RETURN" | "OUT_SALE" | "OUT_DAMAGE" | "ADJUST" | "VOID_RETURN";
  quantity: number;
  cost: number;
  referenceDoc?: string;
  note?: string;
  date: Date;
  createdAt: Date;
  updatedAt: Date;
}

const InventoryTransactionSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    type: {
      type: String,
      enum: ["IN_PURCHASE", "IN_RETURN", "OUT_SALE", "OUT_DAMAGE", "ADJUST", "VOID_RETURN"],
      required: true,
    },
    quantity: { type: Number, required: true },
    cost: { type: Number, required: true },
    referenceDoc: { type: String },
    note: { type: String },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

InventoryTransactionSchema.index({ tenantId: 1, productId: 1 });
InventoryTransactionSchema.index({ tenantId: 1, date: -1 });

export default mongoose.model<IInventoryTransaction>(
  "InventoryTransaction",
  InventoryTransactionSchema
);
