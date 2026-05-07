import mongoose, { Schema, Document } from "mongoose";

export interface IDebtTransaction extends Document {
  tenantId: mongoose.Types.ObjectId;
  customer: mongoose.Types.ObjectId;
  order?: mongoose.Types.ObjectId; // Optional: If linked to a specific order
  type: "CREDIT" | "DEBIT"; // CREDIT = New Debt (Buy on credit), DEBIT = Repayment (Pay debt)
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  note?: string;
  
  // Professional Debt Tracking
  processedBy?: mongoose.Types.ObjectId; // User/Cashier who processed this transaction
  paymentMethod?: "CASH" | "TRANSFER" | "MIXED" | "ADJUSTMENT"; // How debt was repaid
  receiptNumber?: string; // Unique receipt/transaction ID
  reference?: string; // External reference (bank transfer ID, etc.)
  
  createdAt: Date;
  updatedAt: Date;
}

const DebtTransactionSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    type: { type: String, enum: ["CREDIT", "DEBIT"], required: true },
    amount: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    note: { type: String },
    
    // Professional Debt Tracking
    processedBy: { type: Schema.Types.ObjectId, ref: "User" },
    paymentMethod: { type: String, enum: ["CASH", "TRANSFER", "MIXED", "ADJUSTMENT"] },
    receiptNumber: { type: String },
    reference: { type: String },
  },
  { timestamps: true }
);

// Index for faster queries
DebtTransactionSchema.index({ customer: 1, createdAt: -1 });
DebtTransactionSchema.index({ tenantId: 1, type: 1 });
DebtTransactionSchema.index({ receiptNumber: 1 }, { sparse: true });

export default mongoose.model<IDebtTransaction>("DebtTransaction", DebtTransactionSchema);
