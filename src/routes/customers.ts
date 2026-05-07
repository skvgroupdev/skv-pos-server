import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import Customer from "../models/Customer";

import Order from "../models/Order";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);

// Get Customer Stats (Total Spend)
router.get("/:id/stats", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;

        const stats = await Order.aggregate([
            { 
                $match: { 
                    customerId: new (require('mongoose').Types.ObjectId)(id),
                    tenantId: new (require('mongoose').Types.ObjectId)(authReq.user!.tenantId),
                    status: { $ne: 'CANCELLED' }
                } 
            },
            {
                $group: {
                    _id: null,
                    totalSpend: { $sum: "$total" },
                    totalOrders: { $count: {} }
                }
            }
        ]);

        res.json(stats[0] || { totalSpend: 0, totalOrders: 0 });

    } catch (error) {
        console.error("Stats error:", error);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

// Get Customers (Optional search)
router.get("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const search = req.query.search as string;
    const query: any = { tenantId: authReq.user!.tenantId };

    if (search) {
        query.$or = [
            { name: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } }
        ];
    }

    const customers = await Customer.find(query).sort({ updatedAt: -1 }).limit(50);
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// Create Customer
router.post("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const { name, phone, address } = req.body;

    const customer = await Customer.create({
      tenantId: authReq.user!.tenantId,
      name,
      phone,
      address
    });
    
    res.status(201).json(customer);
  } catch (error: any) {
    if (error.code === 11000) {
        return res.status(400).json({ error: "Phone number already exists" });
    }
    res.status(400).json({ error: "Failed to create customer" });
  }
});

// Pay Debt
router.post("/:id/pay-debt", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { amount } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        const customer = await Customer.findOne({ _id: req.params.id, tenantId: authReq.user!.tenantId });
        if (!customer) {
            return res.status(404).json({ error: "Customer not found" });
        }

        customer.totalDebt = Math.max(0, customer.totalDebt - amount);
        customer.lastPaymentDate = new Date();
        await customer.save();

        // TODO: Log a DebtTransaction if we had that model, for now just update balance.

        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: "Failed to pay debt" });
    }
});

// Update Customer
router.put("/:id", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;
        const { name, phone, address } = req.body;

        const customer = await Customer.findOneAndUpdate(
            { _id: id, tenantId: authReq.user!.tenantId },
            { name, phone, address },
            { new: true }
        );

        if (!customer) return res.status(404).json({ error: "Customer not found" });
        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: "Failed to update customer" });
    }
});

// Delete Customer
router.delete("/:id", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { id } = req.params;

        // Check for existing orders or debt
        const hasOrders = await Order.exists({ customerId: id, tenantId: authReq.user!.tenantId });
        if (hasOrders) {
             return res.status(400).json({ error: "Cannot delete customer with existing orders" });
        }

        const customer = await Customer.findOneAndDelete({ _id: id, tenantId: authReq.user!.tenantId });

        if (!customer) return res.status(404).json({ error: "Customer not found" });
        res.json({ message: "Customer deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete customer" });
    }
});

export default router;
