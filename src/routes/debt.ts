import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import Customer from "../models/Customer";
import Order from "../models/Order";
import DebtTransaction from "../models/DebtTransaction";
import mongoose from "mongoose";
import { createLedgerEntry, normalizePaymentLines, PaymentLineInput } from "../services/PaymentLedgerService";
import PaymentTransaction from "../models/PaymentTransaction";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);
router.use(requireRoles(["SHOP_ADMIN", "CASHIER"]));

router.get("/customers", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const search = String(req.query.search || "").trim();
        const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match: any = { tenantId, totalDebt: { $gt: 0 } };
        if (search) {
            match.$or = [
                { name: { $regex: search, $options: "i" } },
                { phone: { $regex: search, $options: "i" } },
            ];
        }

        const pipeline: any[] = [
            { $match: match },
            {
                $lookup: {
                    from: "orders",
                    let: { customerId: "$_id", tenantId: "$tenantId" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$customerId", "$$customerId"] },
                                        { $eq: ["$tenantId", "$$tenantId"] },
                                        { $ne: ["$status", "CANCELLED"] },
                                        { $gt: ["$remainingAmount", 0] },
                                    ],
                                },
                            },
                        },
                        { $sort: { createdAt: 1 } },
                        {
                            $group: {
                                _id: null,
                                unpaidOrders: { $sum: 1 },
                                oldestDebt: { $first: "$createdAt" },
                                orderDebt: { $sum: "$remainingAmount" },
                            },
                        },
                    ],
                    as: "debtStats",
                },
            },
            { $unwind: { path: "$debtStats", preserveNullAndEmptyArrays: true } },
            {
                $addFields: {
                    unpaidOrders: { $ifNull: ["$debtStats.unpaidOrders", 0] },
                    oldestDebt: "$debtStats.oldestDebt",
                    orderDebt: { $ifNull: ["$debtStats.orderDebt", 0] },
                },
            },
            { $project: { debtStats: 0 } },
            { $sort: { totalDebt: -1, updatedAt: -1 } },
            {
                $facet: {
                    data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
                    meta: [{ $count: "total" }],
                    summary: [{ $group: { _id: null, totalDebt: { $sum: "$totalDebt" }, customers: { $sum: 1 } } }],
                },
            },
        ];
        const result = (await Customer.aggregate(pipeline))[0];
        const total = result.meta[0]?.total || 0;
        res.json({
            data: result.data,
            total,
            page,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            summary: result.summary[0] || { totalDebt: 0, customers: 0 },
        });
    } catch (error) {
        console.error("Fetch debtors failed:", error);
        res.status(500).json({ error: "Failed to fetch debtors" });
    }
});

// Generate unique receipt number
const generateReceiptNumber = () => {
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `RPT${timestamp}${random}`;
};

// Repay Debt (Enhanced Professional Version)
router.post("/repay", async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { customerId, orderId, paymentMethod, reference, note } = req.body;

    try {
        if (!customerId || !paymentMethod || !["CASH", "TRANSFER", "MIXED"].includes(paymentMethod)) {
            return res.status(400).json({ error: "Customer and payment method are required" });
        }

        const rawPayments: PaymentLineInput[] = Array.isArray(req.body.payments) && req.body.payments.length > 0
            ? req.body.payments
            : [{
                method: paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
                currency: "LAK",
                amount: Number(req.body.amount),
                rate: 1,
                reference,
            }];
        const defaultMethod = paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH";
        const paymentLines = normalizePaymentLines(rawPayments, defaultMethod);
        const repayAmount = paymentLines.reduce((sum, line) => sum + line.amountInLAK, 0);

        if (paymentMethod === "MIXED" && new Set(paymentLines.map((line) => line.method)).size < 2) {
            return res.status(400).json({ error: "Mixed payment must include cash and transfer amounts" });
        }

        const requestKey = req.get("Idempotency-Key") || undefined;
        if (requestKey) {
            const existing = await PaymentTransaction.findOne({
                tenantId: authReq.user!.tenantId,
                idempotencyKey: requestKey,
            });
            if (existing) {
                const currentCustomer = await Customer.findOne({
                    _id: customerId,
                    tenantId: authReq.user!.tenantId,
                }).select("totalDebt");
                return res.json({
                    success: true,
                    duplicate: true,
                    newDebt: currentCustomer?.totalDebt || 0,
                    transactionId: existing.transactionId,
                    processedBy: existing.processedBy,
                });
            }
        }
        const session = await mongoose.startSession();
        let responseData: any;

        try {
            await session.withTransaction(async () => {
                const customer = await Customer.findOne({
                    _id: customerId,
                    tenantId: authReq.user!.tenantId,
                }).session(session);
                if (!customer) throw Object.assign(new Error("Customer not found"), { statusCode: 404 });
                if (repayAmount > customer.totalDebt) {
                    throw Object.assign(new Error(`Amount exceeds customer debt (${customer.totalDebt})`), { statusCode: 400 });
                }

                let remainingRepay = repayAmount;
                const receiptNumber = generateReceiptNumber();
                const processedBy = authReq.user!.userId;
                const paidOrders: string[] = [];
                let linkedOrder: any;

                if (orderId) {
                    linkedOrder = await Order.findOne({
                        orderId,
                        customerId,
                        tenantId: authReq.user!.tenantId,
                        status: { $ne: "CANCELLED" },
                    }).session(session);
                    if (!linkedOrder) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
                    if (linkedOrder.remainingAmount <= 0) {
                        throw Object.assign(new Error("Order is already paid"), { statusCode: 400 });
                    }
                    if (repayAmount > linkedOrder.remainingAmount) {
                        throw Object.assign(new Error(`Amount exceeds order debt (${linkedOrder.remainingAmount})`), { statusCode: 400 });
                    }

                    linkedOrder.paidAmount += repayAmount;
                    linkedOrder.remainingAmount -= repayAmount;
                    linkedOrder.paymentStatus = linkedOrder.remainingAmount <= 0 ? "PAID" : "PARTIAL";
                    if (linkedOrder.remainingAmount <= 0) linkedOrder.remainingAmount = 0;
                    await linkedOrder.save({ session });
                    paidOrders.push(linkedOrder.orderId);
                } else {
                    const unpaidOrders = await Order.find({
                        customerId,
                        tenantId: authReq.user!.tenantId,
                        status: { $ne: "CANCELLED" },
                        paymentStatus: { $in: ["UNPAID", "PARTIAL"] },
                    }).sort({ createdAt: 1 }).session(session);

                    for (const order of unpaidOrders) {
                        if (remainingRepay <= 0) break;
                        const deduction = Math.min(remainingRepay, order.remainingAmount);
                        order.paidAmount += deduction;
                        order.remainingAmount -= deduction;
                        remainingRepay -= deduction;
                        order.paymentStatus = order.remainingAmount <= 0 ? "PAID" : "PARTIAL";
                        if (order.remainingAmount <= 0) order.remainingAmount = 0;
                        await order.save({ session });
                        paidOrders.push(order.orderId);
                    }

                    if (remainingRepay > 0) {
                        throw Object.assign(new Error("Repayment could not be allocated to active debt orders"), { statusCode: 409 });
                    }
                }

                const debtDocs = await DebtTransaction.create([{
                    tenantId: authReq.user!.tenantId,
                    customer: customerId,
                    order: linkedOrder?._id,
                    type: "DEBIT",
                    amount: repayAmount,
                    balanceBefore: customer.totalDebt,
                    balanceAfter: customer.totalDebt - repayAmount,
                    processedBy,
                    paymentMethod,
                    paymentBreakdown: paymentLines,
                    receiptNumber,
                    reference: reference || paymentLines.find((line) => line.method === "TRANSFER")?.reference,
                    note: note || (linkedOrder ? `ຊຳລະບິນ #${linkedOrder.orderId}` : `ຊຳລະລວມ ${paidOrders.length} ບິນ`),
                }], { session });

                const ledger = await createLedgerEntry({
                    tenantId: authReq.user!.tenantId,
                    sourceType: "DEBT_REPAYMENT",
                    direction: "IN",
                    orderId: linkedOrder?._id,
                    customerId: customer._id as any,
                    processedBy,
                    paymentMethod,
                    payments: paymentLines,
                    appliedAmountInLAK: repayAmount,
                    note,
                    idempotencyKey: requestKey,
                    sourceRecordKey: `DEBT:${debtDocs[0]._id.toString()}`,
                    session,
                });

                customer.totalDebt -= repayAmount;
                customer.lastPaymentDate = new Date();
                await customer.save({ session });

                responseData = {
                    success: true,
                    newDebt: customer.totalDebt,
                    receiptNumber,
                    transactionId: ledger.transactionId,
                    processedBy,
                };
            });
        } finally {
            await session.endSession();
        }

        return res.json(responseData);
    } catch (error) {
        console.error("Repayment failed:", error);
        const statusCode = (error as any)?.statusCode || 500;
        return res.status(statusCode).json({
            error: statusCode === 500 ? "Repayment failed" : (error as Error).message,
        });
    }
});

// Get Debt History (Enhanced with Cashier Info)
router.get("/history/:customerId", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { customerId } = req.params;

        const transactions = await DebtTransaction.find({
            customer: customerId,
            tenantId: authReq.user!.tenantId
        })
        .sort({ createdAt: -1 })
        .populate('order', 'orderId total saleMode paymentMethod')
        .populate('processedBy', 'username role')
        .populate('customer', 'name phone');

        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// Get Debt Transaction History for a specific Order
router.get("/order-history/:orderId", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const order = await Order.findOne({
            orderId: req.params.orderId,
            tenantId: authReq.user!.tenantId
        }).select("_id");

        if (!order) return res.json([]);

        const transactions = await DebtTransaction.find({
            order: order._id,
            tenantId: authReq.user!.tenantId
        })
            .sort({ createdAt: 1 })
            .populate('processedBy', 'username');

        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch order debt history" });
    }
});

// Get All Debt Transactions (For Shop Owner Analytics)
router.get("/transactions", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { startDate, endDate, cashierId, paymentMethod } = req.query;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

        const filter: any = { tenantId: authReq.user!.tenantId, type: "DEBIT" };

        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate as string);
            if (endDate) filter.createdAt.$lte = new Date(endDate as string);
        }

        if (cashierId) filter.processedBy = cashierId;
        if (paymentMethod) filter.paymentMethod = paymentMethod;

        const [transactions, transactionCount] = await Promise.all([
          DebtTransaction.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('customer', 'name phone')
            .populate('order', 'orderId total saleMode')
            .populate('processedBy', 'username roles'),
          DebtTransaction.countDocuments(filter),
        ]);

        // Analytics
        const total = await DebtTransaction.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: "$amount" },
                    count: { $sum: 1 }
                }
            }
        ]);

        const byMethod = await DebtTransaction.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$paymentMethod",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 }
                }
            }
        ]);

        const byCashier = await DebtTransaction.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$processedBy",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "_id",
                    foreignField: "_id",
                    as: "cashier"
                }
            },
            { $unwind: { path: "$cashier", preserveNullAndEmptyArrays: true } }
        ]);

        res.json({
            transactions,
            total: transactionCount,
            page,
            totalPages: Math.max(1, Math.ceil(transactionCount / limit)),
            analytics: {
                total: total[0] || { totalAmount: 0, count: 0 },
                byMethod,
                byCashier
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch transactions" });
    }
});

// Get Cashier's Debt Collection Summary
router.get("/cashier-summary", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { startDate, endDate } = req.query;

        const filter: any = {
            tenantId: authReq.user!.tenantId,
            processedBy: authReq.user!.userId,
            type: "DEBIT"
        };

        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate as string);
            if (endDate) filter.createdAt.$lte = new Date(endDate as string);
        }

        const summary = await DebtTransaction.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$paymentMethod",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 }
                }
            }
        ]);

        const recentTransactions = await DebtTransaction.find(filter)
            .sort({ createdAt: -1 })
            .limit(10)
            .populate('customer', 'name phone')
            .populate('order', 'orderId saleMode');

        res.json({
            summary,
            recentTransactions
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch cashier summary" });
    }
});

export default router;
