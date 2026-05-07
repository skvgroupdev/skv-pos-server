import mongoose, { Schema, Document } from "mongoose";

export interface ICartItem {
    product: mongoose.Types.ObjectId;
    quantity: number;
    price: number;
    // Snapshot of cost for profit calculation later
    costPrice?: number;
    costCurrency?: string;
}

export interface ICart extends Document {
    tenantId: string;
    userId: string; // Cashier ID
    name: string; // Cart Name (e.g. "Cart 1")
    items: ICartItem[];
    customer?: mongoose.Types.ObjectId;
    updatedAt: Date;
}

const CartSchema: Schema = new Schema(
    {
        tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        name: { type: String, default: "Sale 1" },
        items: [
            {
                product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
                quantity: { type: Number, required: true, min: 1 },
                price: { type: Number, required: true },
                costPrice: { type: Number },
                costCurrency: { type: String }
            }
        ],
        customer: { type: Schema.Types.ObjectId, ref: "Customer" }
    },
    { timestamps: true }
);

// Index to quickly find a user's carts
CartSchema.index({ tenantId: 1, userId: 1 });

// Virtual for Total Price (LAK)
CartSchema.virtual('total').get(function(this: ICart) {
    if (!this.items) return 0;
    return this.items.reduce((sum: number, item: ICartItem) => sum + (item.price * item.quantity), 0);
});

// Ensure virtuals are included when converting to JSON
CartSchema.set('toJSON', { virtuals: true });
CartSchema.set('toObject', { virtuals: true });

export default mongoose.model<ICart>("Cart", CartSchema);
