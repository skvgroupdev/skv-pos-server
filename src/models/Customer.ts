import mongoose, { Schema, Document } from "mongoose";

export interface ICustomer extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  phone: string;
  address?: string;
  totalDebt: number;
  lastPaymentDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CustomerSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String },
    totalDebt: { type: Number, default: 0 },
    lastPaymentDate: { type: Date },
  },
  { timestamps: true }
);

// Compound index to ensure unique phone per tenant
CustomerSchema.index({ tenantId: 1, phone: 1 }, { unique: true });

export default mongoose.model<ICustomer>("Customer", CustomerSchema);
