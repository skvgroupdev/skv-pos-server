import mongoose, { Document, Schema } from "mongoose";

export interface IQuotationItem {
    name: string;
    description?: string;
    quantity: number;
    unit?: string;
    unitPrice: number;
    discountAmount: number;
    subtotal: number;
}

export interface IQuotation extends Document {
    tenantId: mongoose.Types.ObjectId;
    quoteNumber: string;
    tenantSnapshot: {
        shopName?: string;
        logo?: string;
        address?: string;
        phone?: string;
        bankName?: string;
        bankAccount?: string;
    };
    customer: {
        name: string;
        company?: string;
        phone?: string;
        address?: string;
        email?: string;
    };
    items: IQuotationItem[];
    subtotal: number;
    discountAmount: number;
    taxRate: number;
    taxAmount: number;
    total: number;
    note?: string;
    terms?: string;
    validUntil?: Date;
    status: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";
    createdBy: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const QuotationItemSchema = new Schema<IQuotationItem>(
    {
        name:           { type: String, required: true },
        description:    { type: String },
        quantity:       { type: Number, required: true, min: 0 },
        unit:           { type: String },
        unitPrice:      { type: Number, required: true, min: 0 },
        discountAmount: { type: Number, default: 0, min: 0 },
        subtotal:       { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const QuotationSchema = new Schema<IQuotation>(
    {
        tenantId:   { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
        quoteNumber: { type: String, required: true },
        tenantSnapshot: {
            shopName:    { type: String },
            logo:        { type: String },
            address:     { type: String },
            phone:       { type: String },
            bankName:    { type: String },
            bankAccount: { type: String },
        },
        customer: {
            name:    { type: String, required: true },
            company: { type: String },
            phone:   { type: String },
            address: { type: String },
            email:   { type: String },
        },
        items:          { type: [QuotationItemSchema], default: [] },
        subtotal:       { type: Number, default: 0 },
        discountAmount: { type: Number, default: 0 },
        taxRate:        { type: Number, default: 0 },
        taxAmount:      { type: Number, default: 0 },
        total:          { type: Number, default: 0 },
        note:           { type: String },
        terms:          { type: String },
        validUntil:     { type: Date },
        status: {
            type: String,
            enum: ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"],
            default: "DRAFT",
        },
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

QuotationSchema.index({ tenantId: 1, createdAt: -1 });
QuotationSchema.index({ tenantId: 1, status: 1 });
QuotationSchema.index({ tenantId: 1, quoteNumber: 1 }, { unique: true });

export default mongoose.model<IQuotation>("Quotation", QuotationSchema);
