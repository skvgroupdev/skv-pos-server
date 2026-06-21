import express from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import Quotation from "../models/Quotation";
import Tenant from "../models/Tenant";

const router = express.Router();
router.use(authMiddleware as express.RequestHandler);

// ── helpers ────────────────────────────────────────────────────────────────────
function calcTotals(
    items: { quantity: number; unitPrice: number; discountAmount: number }[],
    discountAmount: number,
    taxRate: number
) {
    const subtotal = items.reduce(
        (s, i) => s + i.quantity * i.unitPrice - i.discountAmount,
        0
    );
    const afterDiscount = Math.max(0, subtotal - discountAmount);
    const taxAmount = afterDiscount * (taxRate / 100);
    const total = afterDiscount + taxAmount;
    return { subtotal, taxAmount, total };
}

async function nextQuoteNumber(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const count = await Quotation.countDocuments({ tenantId });
    return `QUO-${year}-${String(count + 1).padStart(4, "0")}`;
}

// ── GET /quotations  (list) ────────────────────────────────────────────────────
router.get("/", async (req, res) => {
    try {
        const { tenantId } = (req as AuthRequest).user!;
        const { status, search, page = 1, limit = 20 } = req.query;

        const filter: Record<string, unknown> = { tenantId };
        if (status && status !== "ALL") filter.status = status;
        if (search) {
            filter.$or = [
                { quoteNumber: { $regex: search, $options: "i" } },
                { "customer.name": { $regex: search, $options: "i" } },
                { "customer.company": { $regex: search, $options: "i" } },
            ];
        }

        const skip = (Number(page) - 1) * Number(limit);
        const [items, total] = await Promise.all([
            Quotation.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            Quotation.countDocuments(filter),
        ]);

        res.json({ items, total, page: Number(page), limit: Number(limit) });
    } catch {
        res.status(500).json({ error: "Failed to fetch quotations" });
    }
});

// ── POST /quotations  (create) ─────────────────────────────────────────────────
router.post("/", async (req, res) => {
    try {
        const { tenantId, userId } = (req as AuthRequest).user!;

        const {
            customer,
            items = [],
            discountAmount = 0,
            taxRate = 0,
            note,
            terms,
            validUntil,
            status = "DRAFT",
        } = req.body;

        if (!customer?.name) {
            return res.status(400).json({ error: "Customer name is required" });
        }

        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        const tenantSnapshot = {
            shopName:    tenant.shopName,
            logo:        tenant.logo,
            address:     tenant.address,
            phone:       tenant.phone,
            bankName:    tenant.bankName,
            bankAccount: tenant.bankAccount,
        };

        const processedItems = (items as any[]).map((i) => ({
            name:           String(i.name),
            description:    i.description,
            quantity:       Number(i.quantity) || 0,
            unit:           i.unit,
            unitPrice:      Number(i.unitPrice) || 0,
            discountAmount: Number(i.discountAmount) || 0,
            subtotal:       (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0) - (Number(i.discountAmount) || 0),
        }));

        const { subtotal, taxAmount, total } = calcTotals(
            processedItems,
            Number(discountAmount),
            Number(taxRate)
        );

        const quoteNumber = await nextQuoteNumber(String(tenantId));

        const quotation = await Quotation.create({
            tenantId,
            quoteNumber,
            tenantSnapshot,
            customer,
            items:          processedItems,
            subtotal,
            discountAmount: Number(discountAmount),
            taxRate:        Number(taxRate),
            taxAmount,
            total,
            note,
            terms,
            validUntil:     validUntil ? new Date(validUntil) : undefined,
            status:         ["DRAFT", "SENT"].includes(status) ? status : "DRAFT",
            createdBy:      userId,
        });

        res.status(201).json(quotation);
    } catch (err) {
        res.status(500).json({ error: "Failed to create quotation" });
    }
});

// ── GET /quotations/:id ────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
    try {
        const { tenantId } = (req as AuthRequest).user!;
        const quotation = await Quotation.findOne({ _id: req.params.id, tenantId });
        if (!quotation) return res.status(404).json({ error: "Not found" });
        res.json(quotation);
    } catch {
        res.status(500).json({ error: "Failed to fetch quotation" });
    }
});

// ── PUT /quotations/:id ────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
    try {
        const { tenantId } = (req as AuthRequest).user!;

        const quotation = await Quotation.findOne({ _id: req.params.id, tenantId });
        if (!quotation) return res.status(404).json({ error: "Not found" });

        const {
            customer,
            items,
            discountAmount,
            taxRate,
            note,
            terms,
            validUntil,
            status,
        } = req.body;

        if (customer) quotation.customer = customer;
        if (note     !== undefined) quotation.note     = note;
        if (terms    !== undefined) quotation.terms    = terms;
        if (validUntil !== undefined) {
            quotation.validUntil = validUntil ? new Date(validUntil) : undefined;
        }
        if (status && ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"].includes(status)) {
            quotation.status = status;
        }

        if (items) {
            const processed = (items as any[]).map((i) => ({
                name:           String(i.name),
                description:    i.description,
                quantity:       Number(i.quantity) || 0,
                unit:           i.unit,
                unitPrice:      Number(i.unitPrice) || 0,
                discountAmount: Number(i.discountAmount) || 0,
                subtotal:       (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0) - (Number(i.discountAmount) || 0),
            }));
            quotation.items = processed as any;

            const d = discountAmount !== undefined ? Number(discountAmount) : quotation.discountAmount;
            const t = taxRate !== undefined ? Number(taxRate) : quotation.taxRate;
            const totals = calcTotals(processed, d, t);

            quotation.subtotal       = totals.subtotal;
            quotation.discountAmount = d;
            quotation.taxRate        = t;
            quotation.taxAmount      = totals.taxAmount;
            quotation.total          = totals.total;
        }

        await quotation.save();
        res.json(quotation);
    } catch {
        res.status(500).json({ error: "Failed to update quotation" });
    }
});

// ── PATCH /quotations/:id/status ──────────────────────────────────────────────
router.patch("/:id/status", async (req, res) => {
    try {
        const { tenantId } = (req as AuthRequest).user!;
        const { status } = req.body;

        if (!["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"].includes(status)) {
            return res.status(400).json({ error: "Invalid status" });
        }

        const quotation = await Quotation.findOneAndUpdate(
            { _id: req.params.id, tenantId },
            { status },
            { new: true }
        );
        if (!quotation) return res.status(404).json({ error: "Not found" });
        res.json(quotation);
    } catch {
        res.status(500).json({ error: "Failed to update status" });
    }
});

// ── DELETE /quotations/:id ─────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
    try {
        const { tenantId } = (req as AuthRequest).user!;
        const quotation = await Quotation.findOneAndDelete({ _id: req.params.id, tenantId });
        if (!quotation) return res.status(404).json({ error: "Not found" });
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: "Failed to delete quotation" });
    }
});

export default router;
