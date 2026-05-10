import mongoose, { Schema, Document } from "mongoose";

export interface IProduct extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  costPrice: number;
  costCurrency?: string;
  sellPrice: number;
  wholesalePrice?: number;
  stock: number;
  reservedStock?: number; // Stock currently in active carts
  soldCount?: number;
  minStock?: number;
  unit: string;
  sku?: string;
  barcode?: string;
  supplier?: string;
  brand?: string;
  modelName?: string;
  category?: string;
  images?: string[];
  imageVariants?: {
    small: string;
    medium: string;
    original: string;
  }[];
  status: "active" | "inactive";
  catalog?: {
    No: string;
    code: string;
    page: string;
    number: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true },
    description: { type: String },
    costPrice: { type: Number, required: true, default: 0 },
    costCurrency: { type: String, default: "LAK", enum: ["LAK", "THB", "VND", "USD", "CNY"] }, // LAK, THB, VND, USD, CNY
    sellPrice: { type: Number, required: true, default: 0 },
    wholesalePrice: { type: Number, default: 0 },
    stock: { type: Number, required: true, default: 0 },
    minStock: { type: Number, default: 5 }, // Low stock alert threshold
    unit: { type: String, required: true },
    sku: { type: String },
    barcode: { type: String, index: true },
    supplier: { type: String },
    brand: { type: String, index: true },
    modelName: { type: String },
    category: { type: String, index: true },
    images: [{ type: String }],
    imageVariants: [
      {
        small: { type: String },
        medium: { type: String },
        original: { type: String },
      },
    ],
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    catalog: {
      No: { type: String, trim: true },
      code: { type: String, trim: true },
      page: { type: String, trim: true },
      number: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

ProductSchema.index({
  name: "text",
  brand: "text",
  modelName: "text",
  sku: "text",
  barcode: "text",
  supplier: "text",
});
ProductSchema.index({ tenantId: 1, sku: 1 });
ProductSchema.index({ tenantId: 1, barcode: 1 }, { unique: true });
ProductSchema.index({ tenantId: 1, "catalog.page": 1, "catalog.number": 1 });

export default mongoose.model<IProduct>("Product", ProductSchema);
