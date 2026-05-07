import mongoose, { Schema, Document } from "mongoose";

export interface IExchangeRate extends Document {
  tenantId: mongoose.Types.ObjectId;
  currency: string; // THB, USD, VND
  rate: number; // Rate against base currency (LAK). e.g., 1 THB = 750 LAK -> rate = 750
  isBase: boolean;
  updatedAt: Date;
}

const ExchangeRateSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    currency: { type: String, required: true, enum: ["THB", "USD", "VND", "CNY"] },
    rate: { type: Number, required: true },
    isBase: { type: Boolean, default: false },
  },
  { timestamps: true }
);
// Ensure one rate per currency per tenant
ExchangeRateSchema.index({ tenantId: 1, currency: 1 }, { unique: true });

export default mongoose.model<IExchangeRate>("ExchangeRate", ExchangeRateSchema);
