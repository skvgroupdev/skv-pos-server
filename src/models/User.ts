import mongoose, { Schema, Document } from "mongoose";
import { v4 as uuidv4 } from 'uuid';

export interface IUser extends Document {
  tenantId: mongoose.Types.ObjectId;
  username: string;
  passwordHash: string;

  roles: string[];
  status: 'ACTIVE' | 'INACTIVE';
  employeeCode?: string;
  phone?: string;
  address?: string;
  userid: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    username: { type: String, required: true },
    passwordHash: { type: String, required: true },

    roles: {
      type: [String],
      enum: ['SUPER_ADMIN', 'SHOP_ADMIN', 'CASHIER', 'STOCK_KEEPER', 'SALES'],
      default: ["CASHIER"]
    },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    employeeCode: { type: String, default: "" },
    phone: { type: String, default: "" },
    address: { type: String, default: "" },
    userid: {
      type: String,
      default: () => uuidv4().replace(/-/g, '').substring(0, 5).toUpperCase(),
      unique: true
    }
  },
  { timestamps: true }
);

UserSchema.index({ tenantId: 1, username: 1 }, { unique: true });

export default mongoose.model<IUser>("User", UserSchema);
