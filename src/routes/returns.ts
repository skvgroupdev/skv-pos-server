import { randomBytes } from "crypto";
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { AuthRequest, authMiddleware, requireRoles } from "../middleware/authMiddleware";
import InventoryTransaction from "../models/InventoryTransaction";
import Order from "../models/Order";
import OrderReturn from "../models/OrderReturn";
import Product from "../models/Product";
import { createLedgerEntry, normalizePaymentLines, PaymentLineInput } from "../services/PaymentLedgerService";

const router = express.Router();
router.use(authMiddleware as express.RequestHandler);

const getScopedCashierId = (authReq: AuthRequest, requestedCashierId?: unknown) => {
  const isManager = authReq.user!.roles.includes("SHOP_ADMIN") || authReq.user!.roles.includes("SUPER_ADMIN");
  return isManager ? String(requestedCashierId || "") : authReq.user!.userId;
};

const createReturnId = () =>
  `RT${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;

router.get("/", requireRoles(["SHOP_ADMIN", "CASHIER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const scopedCashierId = getScopedCashierId(authReq, req.query.cashierId);
    const isManager = authReq.user!.roles.includes("SHOP_ADMIN") || authReq.user!.roles.includes("SUPER_ADMIN");
    const filter: any = { tenantId: authReq.user!.tenantId };
    if (req.query.orderId) {
      const order = await Order.findOne({
        tenantId: authReq.user!.tenantId,
        orderId: req.query.orderId,
        ...(scopedCashierId ? { cashierId: scopedCashierId } : {}),
      }).select("_id");
      if (!order) return res.json({ data: [], total: 0, page, totalPages: 1 });
      filter.order = order._id;
    } else if (scopedCashierId) {
      const orderIds = await Order.find({
        tenantId: authReq.user!.tenantId,
        cashierId: scopedCashierId,
      }).distinct("_id");
      filter.order = { $in: orderIds };
    }

    const [data, total] = await Promise.all([
      OrderReturn.find(filter)
        .select(isManager ? "" : "-items.cost -refundPaymentTransaction")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("order", "orderId total")
        .populate("customer", "name phone")
        .populate("requestedBy", "username")
        .populate("approvedBy", "username"),
      OrderReturn.countDocuments(filter),
    ]);
    res.json({ data, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) {
    console.error("Fetch returns failed:", error);
    res.status(500).json({ error: "Failed to fetch returns" });
  }
});

router.post("/", requireRoles(["SHOP_ADMIN"]), async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { orderId, items, reasonCode, note, refundAmount = 0, refundPaymentMethod = "CASH" } = req.body;

  try {
    if (!orderId || !reasonCode?.trim() || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Order, items and reason are required" });
    }
    const requestKey = req.get("Idempotency-Key") || undefined;
    if (requestKey) {
      const existing = await OrderReturn.findOne({
        tenantId: authReq.user!.tenantId,
        idempotencyKey: requestKey,
      });
      if (existing) return res.json(existing);
    }

    const session = await mongoose.startSession();
    let createdReturn: any;
    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({
          _id: orderId,
          tenantId: authReq.user!.tenantId,
          status: "COMPLETED",
        }).session(session);
        if (!order) throw Object.assign(new Error("Active order not found"), { statusCode: 404 });

        const previousReturns = await OrderReturn.find({
          tenantId: authReq.user!.tenantId,
          order: order._id,
        }).session(session);
        const returnedByProduct = new Map<string, number>();
        for (const previous of previousReturns) {
          for (const item of previous.items) {
            const key = item.product.toString();
            returnedByProduct.set(key, (returnedByProduct.get(key) || 0) + item.quantity);
          }
        }

        const normalizedItems = items.map((input: any) => {
          const orderItem = order.items.find((item) => item.product.toString() === String(input.productId));
          if (!orderItem) throw Object.assign(new Error("Returned product is not in the order"), { statusCode: 400 });
          const quantity = Number(input.quantity);
          const alreadyReturned = returnedByProduct.get(orderItem.product.toString()) || 0;
          if (!Number.isInteger(quantity) || quantity <= 0 || alreadyReturned + quantity > orderItem.quantity) {
            throw Object.assign(new Error(`Invalid return quantity for ${orderItem.name}`), { statusCode: 400 });
          }
          const condition = (input.condition || "INCOMPLETE") as "SELLABLE" | "DAMAGED" | "DEFECTIVE" | "INCOMPLETE";
          if (!["SELLABLE", "DAMAGED", "DEFECTIVE", "INCOMPLETE"].includes(condition)) {
            throw Object.assign(new Error("Invalid item condition"), { statusCode: 400 });
          }
          return {
            product: orderItem.product,
            name: orderItem.name,
            soldQuantity: orderItem.quantity,
            quantity,
            price: orderItem.price,
            cost: orderItem.cost,
            condition,
            disposition: (condition === "SELLABLE" ? "NO_RESTOCK" : "WRITE_OFF") as "NO_RESTOCK" | "WRITE_OFF",
          };
        });

        const maxRefund = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const refund = Number(refundAmount);
        if (!Number.isFinite(refund) || refund < 0 || refund > maxRefund) {
          throw Object.assign(new Error(`Refund cannot exceed ${maxRefund}`), { statusCode: 400 });
        }

        const returnDocs = await OrderReturn.create([{
          tenantId: authReq.user!.tenantId,
          returnId: createReturnId(),
          order: order._id,
          customer: order.customerId,
          items: normalizedItems,
          refundAmount: refund,
          reasonCode: reasonCode.trim(),
          note: note?.trim(),
          requestedBy: authReq.user!.userId,
          approvedBy: authReq.user!.userId,
          exchangeGroupId: req.body.exchangeGroupId,
          idempotencyKey: requestKey,
        }], { session });
        createdReturn = returnDocs[0];

        if (refund > 0) {
          const rawPayments: PaymentLineInput[] = Array.isArray(req.body.refundPayments) && req.body.refundPayments.length > 0
            ? req.body.refundPayments
            : [{ method: refundPaymentMethod === "TRANSFER" ? "TRANSFER" : "CASH", currency: "LAK", amount: refund, rate: 1, reference: req.body.reference }];
          const defaultMethod = refundPaymentMethod === "TRANSFER" ? "TRANSFER" : "CASH";
          const paymentLines = normalizePaymentLines(rawPayments, defaultMethod);
          const refundTotal = paymentLines.reduce((sum, line) => sum + line.amountInLAK, 0);
          if (Math.abs(refundTotal - refund) > 1) {
            throw Object.assign(new Error("Refund payment breakdown does not match refund amount"), { statusCode: 400 });
          }
          const ledger = await createLedgerEntry({
            tenantId: authReq.user!.tenantId,
            sourceType: "REFUND",
            direction: "OUT",
            orderId: order._id as any,
            customerId: order.customerId as any,
            processedBy: authReq.user!.userId,
            approvedBy: authReq.user!.userId,
            paymentMethod: refundPaymentMethod,
            payments: paymentLines,
            appliedAmountInLAK: refund,
            reasonCode: reasonCode.trim(),
            note,
            idempotencyKey: requestKey ? `REFUND:${requestKey}` : undefined,
            sourceRecordKey: `RETURN:${createdReturn._id.toString()}`,
            session,
          });
          createdReturn.refundPaymentTransaction = ledger._id;
          await createdReturn.save({ session });
        }
      });
    } finally {
      await session.endSession();
    }

    res.status(201).json(createdReturn);
  } catch (error) {
    console.error("Create return failed:", error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({ error: statusCode === 500 ? "Failed to create return" : (error as Error).message });
  }
});

router.post("/:returnId/items/:productId/restock", requireRoles(["SHOP_ADMIN"]), async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const session = await mongoose.startSession();
  try {
    let result: any;
    await session.withTransaction(async () => {
      const orderReturn = await OrderReturn.findOne({
        tenantId: authReq.user!.tenantId,
        returnId: req.params.returnId,
      }).session(session);
      if (!orderReturn) throw Object.assign(new Error("Return not found"), { statusCode: 404 });
      const item = orderReturn.items.find((entry) => entry.product.toString() === req.params.productId);
      if (!item) throw Object.assign(new Error("Return item not found"), { statusCode: 404 });
      if (item.condition !== "SELLABLE") {
        throw Object.assign(new Error("Only sellable returned items can be restocked"), { statusCode: 400 });
      }
      if (item.disposition === "RESTOCK_APPROVED") {
        throw Object.assign(new Error("Item was already restocked"), { statusCode: 409 });
      }

      const product = await Product.findOneAndUpdate(
        { _id: item.product, tenantId: authReq.user!.tenantId },
        { $inc: { stock: item.quantity } },
        { new: true, session }
      );
      if (!product) throw Object.assign(new Error("Product not found"), { statusCode: 404 });

      await InventoryTransaction.create([{
        tenantId: authReq.user!.tenantId,
        productId: item.product,
        type: "IN_RETURN",
        quantity: item.quantity,
        cost: item.cost,
        referenceDoc: orderReturn.returnId,
        note: req.body.note || `Approved return ${orderReturn.returnId}`,
        processedBy: authReq.user!.userId,
        date: new Date(),
      }], { session });

      item.disposition = "RESTOCK_APPROVED";
      item.restockedAt = new Date();
      item.restockedBy = new mongoose.Types.ObjectId(authReq.user!.userId);
      await orderReturn.save({ session });
      result = { orderReturn, product };
    });
    res.json(result);
  } catch (error) {
    console.error("Restock return failed:", error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({ error: statusCode === 500 ? "Failed to restock return" : (error as Error).message });
  } finally {
    await session.endSession();
  }
});

export default router;
