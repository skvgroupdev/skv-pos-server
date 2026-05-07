import mongoose, { Schema, Document } from "mongoose";

export interface ICategory extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CategorySchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true },
    description: { type: String },
  },
  { timestamps: true }
);

// Ensure unique category names per tenant
CategorySchema.index({ tenantId: 1, name: 1 }, { unique: true });

export default mongoose.model<ICategory>("Category", CategorySchema);
