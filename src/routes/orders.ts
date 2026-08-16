import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import Order, { IOrder } from "../models/Order";
import Product from "../models/Product";
import Customer from "../models/Customer";
import InventoryTransaction from "../models/InventoryTransaction";
import DebtTransaction from "../models/DebtTransaction";
import Cart from "../models/Cart";
import Tenant from "../models/Tenant"; // Ensure model is registered
import User from "../models/User"; // Ensure model is registered
import { randomBytes } from "crypto";
import PaymentTransaction from "../models/PaymentTransaction";
import OrderReturn from "../models/OrderReturn";
import mongoose from "mongoose";
import { createLedgerEntry, PaymentLineInput } from "../services/PaymentLedgerService";
import { checkout, CheckoutError } from "../services/CheckoutService";

const generateShortId = () => {
    // 10 chars base32-like (unambiguous chars)
    const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let result = "";
    const bytes = randomBytes(10);
    for (let i = 0; i < 10; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
};

const validPaymentMethods = ["CASH", "TRANSFER", "DEBT"];

const toMoneyAmount = (value: unknown) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : NaN;
};

const getScopedCashierId = (authReq: AuthRequest, requestedCashierId?: unknown) => {
    const isManager = authReq.user!.roles.includes("SHOP_ADMIN") || authReq.user!.roles.includes("SUPER_ADMIN");
    return isManager ? String(requestedCashierId || "") : authReq.user!.userId;
};

const restoreCanceledOrderStock = async (params: {
    tenantId: string;
    order: IOrder;
    processedBy: string;
    session: mongoose.ClientSession;
}) => {
    const itemMap = new Map<string, { productId: mongoose.Types.ObjectId; name: string; quantity: number; cost: number }>();
    for (const item of params.order.items) {
        const key = item.product.toString();
        const existing = itemMap.get(key);
        if (existing) {
            existing.quantity += item.quantity;
            continue;
        }
        itemMap.set(key, {
            productId: item.product,
            name: item.name,
            quantity: item.quantity,
            cost: item.cost,
        });
    }

    for (const item of itemMap.values()) {
        const product = await Product.findOne({
            _id: item.productId,
            tenantId: params.tenantId,
        }).session(params.session);
        if (!product) {
            throw Object.assign(new Error(`Product not found for canceled order item ${item.name}`), { statusCode: 404 });
        }

        product.stock += item.quantity;
        await product.save({ session: params.session });

        await InventoryTransaction.create([{
            tenantId: params.tenantId as any,
            productId: item.productId,
            type: "VOID_RETURN",
            quantity: item.quantity,
            cost: item.cost,
            referenceDoc: params.order.orderId,
            note: `Auto restock from canceled bill #${params.order.orderId}`,
            processedBy: params.processedBy as any,
            date: new Date(),
        }], { session: params.session });
    }
};

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);
router.use(requireRoles(["SHOP_ADMIN", "CASHIER"]));

// Create Order (Checkout)
router.post("/", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const order = await checkout({
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId,
            cartId: req.body.cartId,
            paymentMethod: req.body.paymentMethod,
            paidAmount: req.body.paidAmount,
            customerId: req.body.customerId,
            discount: req.body.discount,
            payments: req.body.payments,
            exchangeRates: req.body.exchangeRates,
            saleMode: req.body.saleMode,
            reference: req.body.reference,
            idempotencyKey: req.get("Idempotency-Key") || undefined,
        });
        return res.status(201).json(order);
    } catch (error) {
        console.error("Transactional checkout failed:", error);
        const statusCode = error instanceof CheckoutError ? error.statusCode : 500;
        return res.status(statusCode).json({
            error: statusCode === 500 ? "Failed to create order" : (error as Error).message,
        });
    }
});

router.post("/legacy-checkout-disabled", async (req: Request, res: Response) => {
    if (req.path === "/legacy-checkout-disabled") {
        return res.status(410).json({ error: "Legacy checkout is disabled" });
    }
    const customerId = req.body.customerId;
    const stockUpdates: { productId: any; quantity: number }[] = [];
    const createdInventoryTransactionIds: any[] = [];
    const createdDebtTransactionIds: any[] = [];
    let createdOrderId: any = null;
    let createdPaymentTransactionId: any = null;
    let customerDebtIncremented = 0;

    try {
        const authReq = req as AuthRequest;
        const { cartId, paymentMethod, paidAmount, discount, payments, exchangeRates, saleMode } = req.body;

        if (!cartId) return res.status(400).json({ error: "Cart ID is required" });
        if (!validPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({ error: "Invalid payment method" });
        }

        // 1. Fetch Cart
        const cart = await Cart.findOne({
            _id: cartId,
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        }).populate('items.product');

        if (!cart) return res.status(404).json({ error: "Cart not found" });
        if (cart.items.length === 0) return res.status(400).json({ error: "Cart is empty" });

        const tenant = await Tenant.findById(authReq.user!.tenantId).select("shopName address phone logo bankName bankAccount bankQr receiptNote").lean();
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });

        const tenantSnapshot = {
            shopName: tenant.shopName || "",
            address: tenant.address || "",
            phone: tenant.phone || "",
            logo: tenant.logo || "",
            bankName: tenant.bankName || "",
            bankAccount: tenant.bankAccount || "",
            bankQr: tenant.bankQr || "",
            receiptNote: tenant.receiptNote || "",
        };

        const items = cart.items;

        // Calculate total from server side
        let subtotal = items.reduce((sum, item: any) => sum + (item.price * item.quantity), 0);
        const finalDiscount = toMoneyAmount(discount || 0);

        // Validate discount
        if (!Number.isFinite(finalDiscount)) return res.status(400).json({ error: "Invalid discount" });
        if (finalDiscount < 0) return res.status(400).json({ error: "Discount cannot be negative" });
        if (finalDiscount > subtotal) return res.status(400).json({ error: "Discount cannot exceed order total" });

        const total = subtotal - finalDiscount;

        // Multi-currency payment calculation
        let totalPaidInLAK = 0;
        const paymentRecords = [];
        const paidAt = new Date();

        if (payments && Array.isArray(payments) && payments.length > 0) {
            for (const p of payments) {
                const amount = toMoneyAmount(p.amount);
                const rate = p.currency === "LAK" ? 1 : toMoneyAmount(p.rate);

                if (!p.currency || !Number.isFinite(amount) || amount <= 0) {
                    return res.status(400).json({ error: "Invalid payment amount" });
                }

                if (!Number.isFinite(rate) || rate <= 0) {
                    return res.status(400).json({ error: "Invalid payment exchange rate" });
                }

                const amountInLAK = p.currency === 'LAK' ? amount : Math.round(amount * rate);
                totalPaidInLAK += amountInLAK;
                paymentRecords.push({
                    currency: p.currency,
                    amount,
                    rate,
                    amountInLAK,
                    paidAt,
                    method: p.method,
                    reference: p.reference
                });
            }
        } else {
            // Fallback for single payment (backwards compatibility)
            const paid = toMoneyAmount(paidAmount || 0);
            if (!Number.isFinite(paid) || paid < 0) {
                return res.status(400).json({ error: "Invalid paid amount" });
            }
            totalPaidInLAK = paid;
            paymentRecords.push({
                currency: 'LAK',
                amount: paid,
                rate: 1,
                amountInLAK: paid,
                paidAt,
                method: paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
                reference: req.body.reference
            });
        }

        if (paymentMethod === "DEBT" && !customerId) {
            return res.status(400).json({ error: "Customer is required for debt payment" });
        }

        if (paymentMethod === "DEBT" && totalPaidInLAK >= total) {
            return res.status(400).json({ error: "ຕິດໜີ້ຕ້ອງມີຍອດຄ້າງ — ຖ້າຈ່າຍຄົບໃຫ້ໃຊ້ CASH ຫຼື TRANSFER" });
        }

        if (paymentMethod !== "DEBT" && totalPaidInLAK < total) {
            return res.status(400).json({ error: "Paid amount is less than order total" });
        }

        // Calculate Debt Status
        let remainingAmount = 0;
        let paymentStatus: IOrder["paymentStatus"] = "PAID";

        if (paymentMethod === "DEBT") {
            if (totalPaidInLAK < total) {
                remainingAmount = total - totalPaidInLAK;
                paymentStatus = totalPaidInLAK > 0 ? "PARTIAL" : "UNPAID";
            }
        }

        const orderId = generateShortId();

        // 2. Atomically consume the stock reserved by this cart before creating the order.
        for (const item of items) {
            const productVal = item.product as any; // Populated
            const stockResult = await Product.updateOne(
                {
                    _id: productVal._id,
                    tenantId: authReq.user!.tenantId,
                    stock: { $gte: item.quantity },
                    reservedStock: { $gte: item.quantity }
                },
                {
                    $inc: {
                        stock: -item.quantity,
                        reservedStock: -item.quantity,
                        soldCount: item.quantity
                    }
                }
            );

            if (stockResult.modifiedCount === 0) {
                const latestProduct = await Product.findOne({
                    _id: productVal._id,
                    tenantId: authReq.user!.tenantId
                });
                const available = latestProduct
                    ? latestProduct.stock - (latestProduct.reservedStock || 0)
                    : 0;

                const stockError = new Error(
                    `Stock not available for ${productVal.name}. Available: ${Math.max(0, available)}`
                ) as Error & { statusCode?: number };
                stockError.statusCode = 400;
                throw stockError;
            }

            stockUpdates.push({ productId: productVal._id, quantity: item.quantity });
        }

        // 3. Create Order
        const order = await Order.create({
            tenantId: authReq.user!.tenantId,
            tenantSnapshot,
            items: items.map((item: any) => ({
                product: item.product._id,
                quantity: item.quantity,
                price: item.price,
                cost: item.costPrice ?? item.product.costPrice ?? 0,
                name: item.product.name
            })),
            total,
            discount: finalDiscount,
            paymentMethod,
            paidAmount: totalPaidInLAK, // Store total paid in LAK
            payments: paymentRecords,
            exchangeRateSnapshots: exchangeRates || [],
            change: paymentMethod === 'DEBT' ? 0 : Math.max(0, totalPaidInLAK - total),
            customerId: customerId || null,
            cashierId: authReq.user!.userId,
            saleMode: saleMode === "wholesale" ? "wholesale" : "retail",
            status: "COMPLETED",
            orderId,
            paymentStatus,
            remainingAmount
        });
        createdOrderId = order._id;

        // 4. Log inventory transactions
        for (const item of items) {
            const productVal = item.product as any; // Populated

            // Log Transaction: OUT_SALE
            const inventoryTransaction = await InventoryTransaction.create({
                tenantId: authReq.user!.tenantId,
                productId: productVal._id,
                type: "OUT_SALE",
                quantity: -item.quantity,
                cost: productVal.costPrice,
                note: `Order #${order._id.toString().slice(-6)}`,
                referenceDoc: order.orderId,
                processedBy: authReq.user!.userId,
                date: new Date()
            });
            createdInventoryTransactionIds.push(inventoryTransaction._id);
        }

        if (totalPaidInLAK > 0) {
            const ledger = await createLedgerEntry({
                tenantId: authReq.user!.tenantId,
                sourceType: "SALE",
                direction: "IN",
                orderId: order._id as any,
                customerId: order.customerId as any,
                processedBy: authReq.user!.userId,
                paymentMethod: paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
                payments: paymentRecords.map((payment: any) => ({
                    method: payment.method || (paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH"),
                    currency: payment.currency,
                    amount: payment.amount,
                    rate: payment.rate,
                    amountInLAK: payment.amountInLAK,
                    reference: payment.reference,
                })),
                appliedAmountInLAK: Math.min(totalPaidInLAK, total),
                changeInLAK: paymentMethod === "DEBT" ? 0 : Math.max(0, totalPaidInLAK - total),
                idempotencyKey: req.get("Idempotency-Key") || undefined,
                sourceRecordKey: `ORDER:${order._id.toString()}`,
            });
            createdPaymentTransactionId = ledger._id;
        }

        // 5. Update Customer Debt if DEBT payment (or Partial)
        if (remainingAmount > 0 && customerId) {
            const customer = await Customer.findOne({
                _id: customerId,
                tenantId: authReq.user!.tenantId,
            });
            if (customer) {
                // Create Debt Transaction (Credit)
                const debtTransaction = await DebtTransaction.create({
                    tenantId: authReq.user!.tenantId,
                    customer: customerId,
                    order: order._id,
                    type: "CREDIT",
                    amount: remainingAmount,
                    balanceBefore: customer.totalDebt,
                    balanceAfter: customer.totalDebt + remainingAmount,
                    note: `ຕິດໜີ້ #${orderId}`
                });
                createdDebtTransactionIds.push(debtTransaction._id);

                // Update Customer Total Debt
                await Customer.updateOne(
                    { _id: customerId, tenantId: authReq.user!.tenantId },
                    {
                        $inc: { totalDebt: remainingAmount },
                        $set: { lastPaymentDate: new Date() }
                    }
                );
                customerDebtIncremented = remainingAmount;
            }
        }

        // 6. Delete the Cart (Order is placed)
        await Cart.deleteOne({ _id: cart._id });

        // Ensure at least one cart exists for the user (optional, but good UX)
        try {
            const remaining = await Cart.countDocuments({ tenantId: authReq.user!.tenantId, userId: authReq.user!.userId });
            if (remaining === 0) {
                await Cart.create({
                    tenantId: authReq.user!.tenantId,
                    userId: authReq.user!.userId,
                    name: "Sale 1",
                    items: []
                });
            }
        } catch (cartError) {
            console.error("Failed to create replacement cart:", cartError);
        }

        // 7. Return populated order for printing
        try {
            const populatedOrder = await Order.findById(order._id)
                .populate({
                    path: 'tenantId',
                    select: 'name shopName address phone logo bankName bankAccount bankQr',
                    model: Tenant
                })
                .populate({
                    path: 'customerId',
                    select: 'name phone address',
                    model: Customer
                })
                .populate({
                    path: 'cashierId',
                    select: 'name username',
                    model: User
                });

            res.status(201).json(populatedOrder);
        } catch (popError) {
            console.error("Population failed:", popError);
            res.status(201).json(order);
        }

    } catch (error) {
        console.error("Order creation failed:", error);
        if (createdOrderId) {
            await Order.deleteOne({ _id: createdOrderId }).catch((rollbackError) => {
                console.error("Order rollback failed:", rollbackError);
            });
        }

        if (createdPaymentTransactionId) {
            await PaymentTransaction.deleteOne({ _id: createdPaymentTransactionId }).catch((rollbackError) => {
                console.error("Payment ledger rollback failed:", rollbackError);
            });
        }

        if (createdDebtTransactionIds.length > 0) {
            await DebtTransaction.deleteMany({ _id: { $in: createdDebtTransactionIds } }).catch((rollbackError) => {
                console.error("Debt transaction rollback failed:", rollbackError);
            });
        }

        if (customerDebtIncremented > 0 && customerId) {
            await Customer.updateOne(
                { _id: customerId, tenantId: (req as AuthRequest).user!.tenantId },
                { $inc: { totalDebt: -customerDebtIncremented } }
            ).catch((rollbackError) => {
                console.error("Customer debt rollback failed:", rollbackError);
            });
        }

        if (createdInventoryTransactionIds.length > 0) {
            await InventoryTransaction.deleteMany({
                _id: { $in: createdInventoryTransactionIds }
            }).catch((rollbackError) => {
                console.error("Inventory transaction rollback failed:", rollbackError);
            });
        }

        for (const update of stockUpdates.reverse()) {
            await Product.updateOne(
                { _id: update.productId },
                {
                    $inc: {
                        stock: update.quantity,
                        reservedStock: update.quantity,
                        soldCount: -update.quantity
                    }
                }
            ).catch((rollbackError) => {
                console.error("Stock rollback failed:", rollbackError);
            });
        }

        const statusCode = (error as any)?.statusCode || 500;
        res.status(statusCode).json({ error: statusCode === 400 ? (error as Error).message : "Failed to create order" });
    }
});

// Get Orders (with optional filters)
router.get("/", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { customerId, cashierId, paymentMethod, paymentStatus, saleMode, startDate, endDate, search, page, limit } = req.query;
        const scopedCashierId = getScopedCashierId(authReq, cashierId);

        const query: any = { tenantId: authReq.user!.tenantId };

        // Search by Order ID (short ID used in FE is stored as orderId string)
        if (search) {
            // Basic regex search on orderId OR customer name (need aggregation for joined customer search, 
            // but simple approach: search orderId here, or rely on client for complex relation search if load is low.
            // Given User request: BE pagination implies BE search too for it to be useful.
            // Search `orderId` directly.
            query.orderId = { $regex: search, $options: 'i' };
        }

        if (customerId) query.customerId = customerId;
        if (scopedCashierId) query.cashierId = scopedCashierId;
        if (paymentMethod) query.paymentMethod = paymentMethod;
        if (saleMode === "retail") query.saleMode = { $in: ["retail", null] };
        if (saleMode === "wholesale") query.saleMode = "wholesale";
        if (paymentStatus) {
            if (paymentStatus === 'UNPAID_ALL') {
                query.paymentStatus = { $in: ['UNPAID', 'PARTIAL'] };
            } else {
                query.paymentStatus = paymentStatus;
            }
        }

        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate as string);
            if (endDate) query.createdAt.$lte = new Date(endDate as string);
        }

        // Pagination
        const pageNum = parseInt(page as string) || 1;
        const limitNum = parseInt(limit as string) || 20; // Default increased
        const skip = (pageNum - 1) * limitNum;

        // If 'UNPAID_ALL' is used (DebtManager), we typically want ALL list for client calculation, 
        // OR we just paginate if user wants. 
        // Existing FE behavior for DebtManager likely expects a list. 
        // If page/limit NOT provided, we might return all (legacy compat) or default paginated.
        // Let's support both: if pagination params present -> paginate. If not -> return all (or reasonable limit 500).

        const isPaginationRequested = !!page || !!limit;

        if (isPaginationRequested) {
            const activeQuery = { ...query, status: { $ne: "CANCELLED" } };
            const activeAggregateQuery: any = {
                ...activeQuery,
                tenantId: new mongoose.Types.ObjectId(authReq.user!.tenantId),
            };
            if (customerId) activeAggregateQuery.customerId = new mongoose.Types.ObjectId(String(customerId));
            if (scopedCashierId) activeAggregateQuery.cashierId = new mongoose.Types.ObjectId(String(scopedCashierId));
            const initialOrderReceiptExpression: any = {
                $max: [0, {
                    $subtract: [
                        {
                            $cond: [
                                { $gt: [{ $size: { $ifNull: ["$payments", []] } }, 0] },
                                { $sum: { $map: { input: "$payments", as: "payment", in: { $ifNull: ["$$payment.amountInLAK", 0] } } } },
                                { $cond: [{ $eq: ["$paymentMethod", "DEBT"] }, 0, { $ifNull: ["$paidAmount", 0] }] }
                            ]
                        },
                        { $ifNull: ["$change", 0] }
                    ]
                }]
            };
            const [total, orders, summaryRows] = await Promise.all([
                Order.countDocuments(query),
                Order.find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .populate({
                        path: 'tenantId',
                        select: 'name shopName address phone logo bankName bankAccount bankQr',
                        model: Tenant
                    })
                    .populate({
                        path: 'customerId',
                        select: 'name phone address',
                        model: Customer
                    })
                    .populate({
                        path: 'cashierId',
                        select: 'name username',
                        model: User
                    }),
                Order.aggregate([
                    { $match: activeAggregateQuery },
                    {
                        $group: {
                            _id: null,
                            totalSales: { $sum: "$total" },
                            totalOrders: { $sum: 1 },
                            totalDebt: { $sum: "$remainingAmount" },
                            totalPaid: { $sum: initialOrderReceiptExpression }
                        }
                    }
                ])
            ]);

            return res.json({
                data: orders,
                total,
                page: pageNum,
                totalPages: Math.ceil(total / limitNum),
                summary: summaryRows[0] || { totalSales: 0, totalOrders: 0, totalDebt: 0, totalPaid: 0 }
            });
        } else {
            // Legacy return (Array)
            const orders = await Order.find(query)
                .sort({ createdAt: -1 })
                .limit(500) // Safety cap
                .populate({
                    path: 'tenantId',
                    select: 'name shopName address phone logo bankName bankAccount bankQr',
                    model: Tenant
                })
                .populate({
                    path: 'customerId',
                    select: 'name phone address',
                    model: Customer
                })
                .populate({
                    path: 'cashierId',
                    select: 'name username',
                    model: User
                });
            return res.json(orders);
        }

    } catch (error) {
        console.error("Fetch orders failed:", error);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

// Dashboard Stats
router.get("/dashboard-stats", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenantId = authReq.user!.tenantId;

        // Define "Today" range
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        // Convert tenantId to ObjectId for aggregation if it's stored as ObjectId in DB
        // Assuming tenantId in user token is string.
        const mongoose = require('mongoose');
        const tenantObjectId = new mongoose.Types.ObjectId(tenantId as string);

        // 1. Summary Stats
        const summaryPipeline = [
            {
                $match: {
                    tenantId: tenantObjectId,
                    createdAt: { $gte: startOfDay, $lte: endOfDay },
                    status: { $ne: 'CANCELLED' }
                }
            },
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: "$total" },
                    totalOrders: { $count: {} },
                    cashSales: {
                        $sum: {
                            $cond: [{ $eq: ["$paymentMethod", "CASH"] }, "$total", 0]
                        }
                    },
                    transferSales: {
                        $sum: {
                            $cond: [{ $eq: ["$paymentMethod", "TRANSFER"] }, "$total", 0]
                        }
                    },
                    debtSales: {
                        $sum: {
                            $cond: [{ $eq: ["$paymentMethod", "DEBT"] }, "$total", 0]
                        }
                    }
                }
            }
        ];

        const summaryResult = await Order.aggregate(summaryPipeline);
        const stats = summaryResult[0] || {
            totalSales: 0,
            totalOrders: 0,
            cashSales: 0,
            transferSales: 0,
            debtSales: 0
        };

        // 2. Hourly Sales
        // Note: MongoDB dates are stored in UTC. We need to adjust timezone if we want local hour.
        // For simplicity, we'll fetch basic data and let FE handle timezone or use simplified aggregation.
        // Better: Use $hour with timezone if possible, or just simpler group by hour.
        // Assuming server time or UTC. Let's try to group by hour.

        const hourlyPipeline = [
            {
                $match: {
                    tenantId: tenantObjectId,
                    createdAt: { $gte: startOfDay, $lte: endOfDay },
                    status: { $ne: 'CANCELLED' }
                }
            },
            {
                $project: {
                    hour: { $hour: { date: "$createdAt", timezone: "+07:00" } }, // Hardcoded +7 for Lao/Thai for now
                    total: "$total"
                }
            },
            {
                $group: {
                    _id: "$hour",
                    sales: { $sum: "$total" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ];

        const hourlyResult = await Order.aggregate(hourlyPipeline as any);

        // Format hourly data (fill missing hours for FE?)
        // Let FE fill missing hours.

        res.json({
            summary: stats,
            hourly: hourlyResult
        });

    } catch (error) {
        console.error("Dashboard stats failed:", error);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

// Cancel Order
// Add Payment to Existing Order
router.post("/:id/add-payment-legacy-disabled", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;
        const { amount, currency = 'LAK', rate = 1, note } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid payment amount" });
        }

        const order = await Order.findOne({
            _id: id,
            tenantId: authReq.user!.tenantId
        });

        if (!order) return res.status(404).json({ error: "Order not found" });
        if (order.status === "CANCELLED") return res.status(400).json({ error: "Cannot add payment to cancelled order" });
        if (order.paymentStatus === "PAID") return res.status(400).json({ error: "Order is already fully paid" });

        const amountInLAK = currency === 'LAK' ? amount : Math.round(amount * rate);

        if (amountInLAK > order.remainingAmount) {
            return res.status(400).json({ error: `Payment exceeds remaining amount (${order.remainingAmount})` });
        }

        // Add payment record
        if (!order.payments) order.payments = [];
        order.payments.push({
            currency,
            amount,
            rate,
            amountInLAK,
            paidAt: new Date(),
            note: note || `Additional payment by ${authReq.user!.userId}`
        });

        // Update order amounts
        order.paidAmount += amountInLAK;
        order.remainingAmount -= amountInLAK;

        if (order.remainingAmount <= 0) {
            order.paymentStatus = "PAID";
            order.remainingAmount = 0;
        } else {
            order.paymentStatus = "PARTIAL";
        }

        await order.save();

        // Update customer debt if applicable
        if (order.customerId) {
            await Customer.updateOne(
                { _id: order.customerId },
                { $inc: { totalDebt: -amountInLAK } }
            );

            // Log debt transaction
            const customer = await Customer.findById(order.customerId);
            if (customer) {
                await DebtTransaction.create({
                    tenantId: authReq.user!.tenantId,
                    customer: order.customerId,
                    order: order._id,
                    type: "DEBIT",
                    amount: amountInLAK,
                    balanceBefore: customer.totalDebt + amountInLAK,
                    balanceAfter: customer.totalDebt,
                    note: note || `Payment for #${order.orderId}`
                });
            }
        }

        res.json({ message: "Payment added successfully", order });
    } catch (error) {
        console.error("Add payment failed:", error);
        res.status(500).json({ error: "Failed to add payment" });
    }
});

// Get one order for bill detail views.
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;
        const scopedCashierId = getScopedCashierId(authReq, req.query.cashierId);
        const identityQuery = mongoose.Types.ObjectId.isValid(id)
            ? { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { orderId: id }] }
            : { orderId: id };

        const order = await Order.findOne({
            tenantId: authReq.user!.tenantId,
            ...identityQuery,
            ...(scopedCashierId ? { cashierId: scopedCashierId } : {}),
        })
            .select("-items.cost")
            .populate("customerId", "name phone address")
            .populate("cashierId", "name username phone employeeCode")
            .populate("cancelledBy", "name username");

        if (!order) return res.status(404).json({ error: "Order not found" });
        return res.json(order);
    } catch (error) {
        console.error("Get order detail failed:", error);
        return res.status(500).json({ error: "Failed to retrieve order" });
    }
});

// Get Payment History for Order
router.get("/:id/payments", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;
        const scopedCashierId = getScopedCashierId(authReq, req.query.cashierId);

        const order = await Order.findOne({
            _id: id,
            tenantId: authReq.user!.tenantId,
            ...(scopedCashierId ? { cashierId: scopedCashierId } : {}),
        }).populate('customerId', 'name phone');

        if (!order) return res.status(404).json({ error: "Order not found" });

        res.json({
            orderId: order.orderId,
            total: order.total,
            paidAmount: order.paidAmount,
            remainingAmount: order.remainingAmount,
            paymentStatus: order.paymentStatus,
            payments: order.payments || [],
            customer: order.customerId
        });
    } catch (error) {
        console.error("Get payment history failed:", error);
        res.status(500).json({ error: "Failed to retrieve payment history" });
    }
});

// Add Note to Order
router.post("/:id/note", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;
        const { note } = req.body;
        const scopedCashierId = getScopedCashierId(authReq, req.body.cashierId);

        if (!note || note.trim() === '') {
            return res.status(400).json({ error: "Note cannot be empty" });
        }

        const order = await Order.findOne({
            _id: id,
            tenantId: authReq.user!.tenantId,
            ...(scopedCashierId ? { cashierId: scopedCashierId } : {}),
        });

        if (!order) return res.status(404).json({ error: "Order not found" });

        if (!order.notes) order.notes = [];
        order.notes.push({
            text: note,
            createdBy: authReq.user!.userId,
            createdAt: new Date()
        });

        await order.save();

        res.json({ message: "Note added successfully", order });
    } catch (error) {
        console.error("Add note failed:", error);
        res.status(500).json({ error: "Failed to add note" });
    }
});

router.post("/:id/cancel", requireRoles(["SHOP_ADMIN"]), async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { id } = req.params;
    const { cancelReason, cancelReasonCode = "OTHER", refundPaymentMethod = "CASH", restoreStock = false } = req.body;

    if (!cancelReason?.trim()) {
        return res.status(400).json({ error: "ກະລຸນາໃສ່ເຫດຜົນການຍົກເລີກ" });
    }
    if (!["CASH", "TRANSFER", "MIXED"].includes(refundPaymentMethod)) {
        return res.status(400).json({ error: "Invalid refund payment method" });
    }

    const session = await mongoose.startSession();
    try {
        let result: any;
        await session.withTransaction(async () => {
            const order = await Order.findOne({
                _id: id,
                tenantId: authReq.user!.tenantId,
            }).session(session);
            if (!order) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
            if (order.status === "CANCELLED") {
                throw Object.assign(new Error("Order is already cancelled"), { statusCode: 409 });
            }

            const hasReturns = await OrderReturn.exists({
                tenantId: authReq.user!.tenantId,
                order: order._id,
            }).session(session);
            if (hasReturns) {
                throw Object.assign(new Error("An order with item returns cannot be fully cancelled"), { statusCode: 409 });
            }

            if (restoreStock) {
                await restoreCanceledOrderStock({
                    tenantId: authReq.user!.tenantId,
                    order,
                    processedBy: authReq.user!.userId,
                    session,
                });
            }

            const appliedPaid = Math.max(0, order.total - order.remainingAmount);
            let reversal: any;
            if (appliedPaid > 0) {
                if (!Array.isArray(req.body.refundPayments) || req.body.refundPayments.length === 0) {
                    throw Object.assign(new Error(`Refund payment details are required for ${appliedPaid}`), { statusCode: 400 });
                }
                const rawPayments: PaymentLineInput[] = req.body.refundPayments;
                const originalSale = await PaymentTransaction.findOne({
                    tenantId: authReq.user!.tenantId,
                    order: order._id,
                    sourceType: "SALE",
                    status: "POSTED",
                }).session(session);

                reversal = await createLedgerEntry({
                    tenantId: authReq.user!.tenantId,
                    sourceType: "REVERSAL",
                    direction: "OUT",
                    orderId: order._id as any,
                    customerId: order.customerId as any,
                    processedBy: authReq.user!.userId,
                    approvedBy: authReq.user!.userId,
                    paymentMethod: refundPaymentMethod,
                    payments: rawPayments,
                    appliedAmountInLAK: appliedPaid,
                    reasonCode: cancelReasonCode,
                    note: cancelReason.trim(),
                    reversalOf: originalSale?._id as any,
                    idempotencyKey: req.get("Idempotency-Key") || undefined,
                    sourceRecordKey: `CANCEL:${order._id.toString()}`,
                    session,
                });
                if (originalSale) {
                    originalSale.status = "REVERSED";
                    await originalSale.save({ session });
                }
            }

            if (order.remainingAmount > 0 && order.customerId) {
                const customer = await Customer.findOne({
                    _id: order.customerId,
                    tenantId: authReq.user!.tenantId,
                }).session(session);
                if (!customer) throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
                const nextDebt = Math.max(0, customer.totalDebt - order.remainingAmount);
                await DebtTransaction.create([{
                    tenantId: authReq.user!.tenantId,
                    customer: customer._id,
                    order: order._id,
                    type: "DEBIT",
                    amount: order.remainingAmount,
                    balanceBefore: customer.totalDebt,
                    balanceAfter: nextDebt,
                    processedBy: authReq.user!.userId,
                    paymentMethod: "ADJUSTMENT",
                    reference: `CANCEL:${order.orderId}`,
                    note: `ຍົກເລີກ #${order.orderId}: ${cancelReason.trim()}`,
                }], { session });
                customer.totalDebt = nextDebt;
                await customer.save({ session });
            }

            order.status = "CANCELLED";
            order.cancelReason = cancelReason.trim();
            order.cancelReasonCode = cancelReasonCode;
            order.cancelledAt = new Date();
            order.cancelledBy = new mongoose.Types.ObjectId(authReq.user!.userId);
            order.remainingAmount = 0;
            order.paymentStatus = "PAID";
            await order.save({ session });

            result = { message: "Order cancelled successfully", order, reversal };
        });
        return res.json(result);
    } catch (error) {
        console.error("Cancel order failed:", error);
        const statusCode = (error as any)?.statusCode || 500;
        return res.status(statusCode).json({
            error: statusCode === 500 ? "Failed to cancel order" : (error as Error).message,
        });
    } finally {
        await session.endSession();
    }
});

export default router;
