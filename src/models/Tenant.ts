import mongoose, { Schema, Document } from "mongoose";

export interface ITenant extends Document {
  name: string; // Internal name

  // Shop Display Info
  shopName?: string;
  logo?: string;
  address?: string;
  phone?: string;

  // Bank Info
  bankName?: string;
  bankAccount?: string;
  bankQr?: string;
  receiptNote?: string;

  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
  subscriptionPlan: 'BASIC' | 'PRO' | 'ENTERPRISE';
  expireAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const TenantSchema: Schema = new Schema(
  {
    name: { type: String, required: true },

    // Shop Display Info
    shopName: { type: String },
    logo: { type: String },
    address: { type: String },
    phone: { type: String },

    // Bank Info
    bankName: { type: String },
    bankAccount: { type: String },
    bankQr: { type: String },
    receiptNote: { type: String },

    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED', 'PENDING'],
      default: 'ACTIVE'
    },
    subscriptionPlan: {
      type: String,
      enum: ['BASIC', 'PRO', 'ENTERPRISE'],
      default: 'BASIC'
    },
    expireAt: { type: Date }, // Made optional for now or handle via logic
  },
  { timestamps: true }
);

export default mongoose.model<ITenant>("Tenant", TenantSchema);
