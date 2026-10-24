import mongoose, { Schema, Document } from "mongoose";

export type PlatformRole = "SUPER_ADMIN" | "BILLING_ADMIN" | "SUPPORT_ADMIN";

export interface IPlatformUser extends Document {
  username: string;
  loginPhone?: string;
  passwordHash: string;
  roles: PlatformRole[];
  status: "ACTIVE" | "INACTIVE";
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformUserSchema: Schema = new Schema(
  {
    username: { type: String, required: true, trim: true, unique: true },
    loginPhone: { type: String, trim: true, unique: true, sparse: true },
    passwordHash: { type: String, required: true },
    roles: {
      type: [String],
      enum: ["SUPER_ADMIN", "BILLING_ADMIN", "SUPPORT_ADMIN"],
      default: ["SUPER_ADMIN"],
    },
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model<IPlatformUser>("PlatformUser", PlatformUserSchema);
