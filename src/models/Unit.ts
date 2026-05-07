import mongoose, { Schema, Document } from "mongoose";

export interface IUnit extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  symbol?: string; // e.g. "kg", "pcs"
  createdAt: Date;
  updatedAt: Date;
}

const UnitSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true },
    symbol: { type: String },
  },
  { timestamps: true }
);

// Ensure unique unit names per tenant
UnitSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export default mongoose.model<IUnit>("Unit", UnitSchema);
