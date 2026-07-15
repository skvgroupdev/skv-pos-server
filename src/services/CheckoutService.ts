import { randomBytes } from "crypto";
import mongoose from "mongoose";
import Cart from "../models/Cart";
import Customer from "../models/Customer";
import DebtTransaction from "../models/DebtTransaction";
import InventoryTransaction from "../models/InventoryTransaction";
import Order, { IOrder } from "../models/Order";
import PaymentTransaction from "../models/PaymentTransaction";
import Product from "../models/Product";
import Tenant from "../models/Tenant";
import User from "../models/User";
import { createLedgerEntry, PaymentLineInput } from "./PaymentLedgerService";

export class CheckoutError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

interface CheckoutInput {
  tenantId: string;
  userId: string;
  cartId: string;
  paymentMethod: "CASH" | "TRANSFER" | "DEBT";
  paidAmount?: number;
  customerId?: string;
  discount?: number;
  payments?: PaymentLineInput[];
  exchangeRates?: Array<{ currency: string; rate: number }>;
  saleMode?: "retail" | "wholesale";
  reference?: string;
  idempotencyKey?: string;
}

const generateOrderId = () => {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = randomBytes(10);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
};

const populateOrder = (orderId: mongoose.Types.ObjectId) =>
  Order.findById(orderId)
    .populate({ path: "tenantId", select: "name shopName address phone logo bankName bankAccount bankQr", model: Tenant })
    .populate({ path: "customerId", select: "name phone address", model: Customer })
    .populate({ path: "cashierId", select: "name username", model: User });

export const checkout = async (input: CheckoutInput) => {
  if (!input.cartId) throw new CheckoutError("Cart ID is required");
  if (!["CASH", "TRANSFER", "DEBT"].includes(input.paymentMethod)) {
    throw new CheckoutError("Invalid payment method");
  }

  if (input.idempotencyKey) {
    const existing = await PaymentTransaction.findOne({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      sourceType: "SALE",
    }).select("order");
    if (existing?.order) return populateOrder(existing.order);
  }

  const session = await mongoose.startSession();
  let createdOrderId: mongoose.Types.ObjectId | undefined;
  try {
    await session.withTransaction(async () => {
      const cart = await Cart.findOne({
        _id: input.cartId,
        tenantId: input.tenantId,
        userId: input.userId,
      }).populate("items.product").session(session);
      if (!cart) throw new CheckoutError("Cart not found", 404);
      if (cart.items.length === 0) throw new CheckoutError("Cart is empty");

      const tenant = await Tenant.findById(input.tenantId)
        .select("shopName address phone logo bankName bankAccount bankQr receiptNote")
        .session(session)
        .lean();
      if (!tenant) throw new CheckoutError("Tenant not found", 404);

      const subtotal = cart.items.reduce((sum, item: any) => sum + item.price * item.quantity, 0);
      const discount = Number(input.discount || 0);
      if (!Number.isFinite(discount) || discount < 0 || discount > subtotal) {
        throw new CheckoutError("Invalid discount");
      }
      const total = subtotal - discount;

      const rawPayments: PaymentLineInput[] = input.payments?.length
        ? input.payments
        : Number(input.paidAmount || 0) > 0
          ? [{
              method: input.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
              currency: "LAK",
              amount: Number(input.paidAmount),
              rate: 1,
              reference: input.reference,
            }]
          : [];
      const paymentRecords = rawPayments.map((payment) => {
        const amount = Number(payment.amount);
        const currency = (payment.currency || "LAK").toUpperCase();
        const rate = currency === "LAK" ? 1 : Number(payment.rate);
        const amountInLAK = payment.amountInLAK === undefined ? Math.round(amount * rate) : Number(payment.amountInLAK);
        if (!Number.isFinite(amount) || amount <= 0) throw new CheckoutError("Invalid payment amount");
        if (!Number.isFinite(rate) || rate <= 0) throw new CheckoutError("Invalid payment exchange rate");
        return { ...payment, currency, amount, rate, amountInLAK, paidAt: new Date() };
      });
      const totalPaidInLAK = paymentRecords.reduce((sum, payment) => sum + payment.amountInLAK, 0);

      if (input.paymentMethod === "DEBT" && !input.customerId) {
        throw new CheckoutError("Customer is required for debt payment");
      }
      if (input.paymentMethod === "DEBT" && totalPaidInLAK >= total) {
        throw new CheckoutError("ຕິດໜີ້ຕ້ອງມີຍອດຄ້າງ — ຖ້າຈ່າຍຄົບໃຫ້ໃຊ້ CASH ຫຼື TRANSFER");
      }
      if (input.paymentMethod !== "DEBT" && totalPaidInLAK < total) {
        throw new CheckoutError("Paid amount is less than order total");
      }

      const remainingAmount = input.paymentMethod === "DEBT" ? total - totalPaidInLAK : 0;
      const paymentStatus: IOrder["paymentStatus"] = remainingAmount <= 0
        ? "PAID"
        : totalPaidInLAK > 0 ? "PARTIAL" : "UNPAID";
      const orderId = generateOrderId();

      for (const item of cart.items) {
        const product = item.product as any;
        const stockResult = await Product.updateOne(
          {
            _id: product._id,
            tenantId: input.tenantId,
            stock: { $gte: item.quantity },
            reservedStock: { $gte: item.quantity },
          },
          { $inc: { stock: -item.quantity, reservedStock: -item.quantity, soldCount: item.quantity } },
          { session }
        );
        if (stockResult.modifiedCount === 0) {
          throw new CheckoutError(`Stock not available for ${product.name}`);
        }
      }

      const order = new Order({
        tenantId: input.tenantId,
        tenantSnapshot: {
          shopName: tenant.shopName || "",
          logo: tenant.logo || "",
          address: tenant.address || "",
          phone: tenant.phone || "",
          bankName: tenant.bankName || "",
          bankAccount: tenant.bankAccount || "",
          bankQr: tenant.bankQr || "",
          receiptNote: tenant.receiptNote || "",
        },
        items: cart.items.map((item: any) => ({
          product: item.product._id,
          quantity: item.quantity,
          price: item.price,
          cost: item.costPrice ?? item.product.costPrice ?? 0,
          name: item.product.name,
        })),
        total,
        discount,
        paymentMethod: input.paymentMethod,
        paidAmount: totalPaidInLAK,
        payments: paymentRecords,
        exchangeRateSnapshots: input.exchangeRates || [],
        change: input.paymentMethod === "DEBT" ? 0 : Math.max(0, totalPaidInLAK - total),
        customerId: input.customerId || null,
        cashierId: input.userId,
        saleMode: input.saleMode === "wholesale" ? "wholesale" : "retail",
        status: "COMPLETED",
        orderId,
        paymentStatus,
        remainingAmount,
      });
      await order.save({ session });
      createdOrderId = order._id as mongoose.Types.ObjectId;

      await InventoryTransaction.create(
        cart.items.map((item: any) => ({
          tenantId: input.tenantId,
          productId: item.product._id,
          type: "OUT_SALE",
          quantity: -item.quantity,
          cost: item.product.costPrice || 0,
          referenceDoc: order.orderId,
          note: `Order #${order.orderId}`,
          processedBy: input.userId,
          date: new Date(),
        })),
        // Mongoose requires ordered inserts when create() receives multiple
        // documents together with a transaction session. Without this option,
        // checkout only works for carts containing a single line item.
        { session, ordered: true }
      );

      if (totalPaidInLAK > 0) {
        await createLedgerEntry({
          tenantId: input.tenantId,
          sourceType: "SALE",
          direction: "IN",
          orderId: order._id as mongoose.Types.ObjectId,
          customerId: order.customerId as mongoose.Types.ObjectId | undefined,
          processedBy: input.userId,
          paymentMethod: input.paymentMethod === "TRANSFER" ? "TRANSFER" : "CASH",
          payments: paymentRecords,
          appliedAmountInLAK: Math.min(totalPaidInLAK, total),
          changeInLAK: order.change,
          idempotencyKey: input.idempotencyKey,
          sourceRecordKey: `ORDER:${order._id.toString()}`,
          session,
        });
      }

      if (remainingAmount > 0 && input.customerId) {
        const customer = await Customer.findOne({ _id: input.customerId, tenantId: input.tenantId }).session(session);
        if (!customer) throw new CheckoutError("Customer not found", 404);
        await DebtTransaction.create([{
          tenantId: input.tenantId,
          customer: customer._id,
          order: order._id,
          type: "CREDIT",
          amount: remainingAmount,
          balanceBefore: customer.totalDebt,
          balanceAfter: customer.totalDebt + remainingAmount,
          processedBy: input.userId,
          note: `ຕິດໜີ້ #${order.orderId}`,
        }], { session });
        customer.totalDebt += remainingAmount;
        await customer.save({ session });
      }

      await Cart.deleteOne({ _id: cart._id }, { session });
      const remainingCarts = await Cart.countDocuments({ tenantId: input.tenantId, userId: input.userId }).session(session);
      if (remainingCarts === 0) {
        await Cart.create([{ tenantId: input.tenantId, userId: input.userId, name: "Sale 1", items: [] }], { session });
      }
    });

    if (!createdOrderId) throw new CheckoutError("Order was not created", 500);
    return populateOrder(createdOrderId);
  } finally {
    await session.endSession();
  }
};
