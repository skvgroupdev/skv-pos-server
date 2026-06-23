import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import Customer from "../models/Customer";
import Order from "../models/Order";
import DebtTransaction from "../models/DebtTransaction";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);
router.use(requireRoles(["SHOP_ADMIN", "CASHIER"]));

// Generate unique receipt number
const generateReceiptNumber = () => {
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `RPT${timestamp}${random}`;
};

// Repay Debt (Enhanced Professional Version)
router.post("/repay", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { customerId, amount, orderId, paymentMethod, reference, note } = req.body;

        if (!customerId || !amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid repayment data" });
        }

        if (!paymentMethod || !["CASH", "TRANSFER", "MIXED"].includes(paymentMethod)) {
            return res.status(400).json({ error: "Payment method required (CASH, TRANSFER, or MIXED)" });
        }

        const customer = await Customer.findOne({ 
            _id: customerId, 
            tenantId: authReq.user!.tenantId 
        });

        if (!customer) return res.status(404).json({ error: "Customer not found" });

        const repayAmount = Number(amount);
        if (!Number.isFinite(repayAmount) || repayAmount <= 0) {
            return res.status(400).json({ error: "Invalid repayment amount" });
        }

        if (repayAmount > customer.totalDebt) {
            return res.status(400).json({ error: `Amount exceeds customer debt (${customer.totalDebt})` });
        }

        let remainingRepay = repayAmount;
        const receiptNumber = generateReceiptNumber();
        const processedBy = authReq.user!.userId;

        // If paying specific order
        if (orderId) {
            const order = await Order.findOne({
                orderId: orderId,
                customerId: customerId,
                tenantId: authReq.user!.tenantId
            });

            if (!order) return res.status(404).json({ error: "Order not found" });
            if (order.remainingAmount <= 0) return res.status(400).json({ error: "Order is already paid" });
            
            if (repayAmount > order.remainingAmount) {
                return res.status(400).json({ error: `Amount exceeds order debt (${order.remainingAmount})` });
            }

            // Update Order
            order.paidAmount += repayAmount;
            order.remainingAmount -= repayAmount;
            if (order.remainingAmount <= 0) {
                order.paymentStatus = "PAID";
                order.remainingAmount = 0;
            } else {
                order.paymentStatus = "PARTIAL";
            }
            await order.save();

            // Create Professional Transaction Record
            await DebtTransaction.create({
                tenantId: authReq.user!.tenantId,
                customer: customerId,
                order: order._id,
                type: "DEBIT",
                amount: repayAmount,
                balanceBefore: customer.totalDebt,
                balanceAfter: customer.totalDebt - repayAmount,
                processedBy: processedBy,
                paymentMethod: paymentMethod,
                receiptNumber: receiptNumber,
                reference: reference || undefined,
                note: note || `ຊຳລະບິນ #${order.orderId}`
            });

        } else {
            // General Repayment (FIFO)
            const unpaidOrders = await Order.find({
                customerId: customerId,
                tenantId: authReq.user!.tenantId,
                paymentStatus: { $in: ["UNPAID", "PARTIAL"] }
            }).sort({ createdAt: 1 });

            const paidOrders: string[] = [];

            for (const order of unpaidOrders) {
                if (remainingRepay <= 0) break;

                const deduction = Math.min(remainingRepay, order.remainingAmount);
                
                order.paidAmount += deduction;
                order.remainingAmount -= deduction;
                remainingRepay -= deduction;

                if (order.remainingAmount <= 0) {
                    order.paymentStatus = "PAID";
                    order.remainingAmount = 0;
                } else {
                    order.paymentStatus = "PARTIAL";
                }
                await order.save();
                paidOrders.push(order.orderId);
            }
            
            // Professional Transaction Log
            await DebtTransaction.create({
                tenantId: authReq.user!.tenantId,
                customer: customerId,
                type: "DEBIT",
                amount: repayAmount,
                balanceBefore: customer.totalDebt,
                balanceAfter: Math.max(0, customer.totalDebt - repayAmount),
                processedBy: processedBy,
                paymentMethod: paymentMethod,
                receiptNumber: receiptNumber,
                reference: reference || undefined,
                note: note || (remainingRepay > 0 
                      ? `ຊຳລະລວມ (ເກີນ: ${remainingRepay.toLocaleString()}₭)` 
                      : `ຊຳລະລວມ ${paidOrders.length} ບິນ`)
            });
        }

        // Update Customer Total Debt
        const newTotalDebt = Math.max(0, customer.totalDebt - repayAmount);
        await Customer.updateOne(
            { _id: customerId },
            { 
                $set: { 
                    totalDebt: newTotalDebt,
                    lastPaymentDate: new Date()
                }
            }
        );

        res.json({ 
            success: true, 
            newDebt: newTotalDebt,
            receiptNumber: receiptNumber,
            processedBy: authReq.user!.userId
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Repayment failed" });
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
        .populate('order', 'orderId total paymentMethod')
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

        const filter: any = { tenantId: authReq.user!.tenantId, type: "DEBIT" };

        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate as string);
            if (endDate) filter.createdAt.$lte = new Date(endDate as string);
        }

        if (cashierId) filter.processedBy = cashierId;
        if (paymentMethod) filter.paymentMethod = paymentMethod;

        const transactions = await DebtTransaction.find(filter)
            .sort({ createdAt: -1 })
            .populate('customer', 'name phone')
            .populate('order', 'orderId total')
            .populate('processedBy', 'username role')
            .limit(500);

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
            .populate('order', 'orderId');

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
