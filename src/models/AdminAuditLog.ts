import mongoose, { Schema, Document } from "mongoose";

export interface IAdminAuditLog extends Document {
  actorId?: mongoose.Types.ObjectId;
  actorUsername?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const AdminAuditLogSchema: Schema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "PlatformUser" },
    actorUsername: { type: String },
    action: { type: String, required: true, index: true },
    targetType: { type: String },
    targetId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export default mongoose.model<IAdminAuditLog>("AdminAuditLog", AdminAuditLogSchema);
