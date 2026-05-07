import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import Tenant from "../models/Tenant";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);

// Get My Tenant Info
router.get("/me", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenant = await Tenant.findById(authReq.user!.tenantId);
        if (!tenant) return res.status(404).json({ error: "Tenant not found" });
        res.json(tenant);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch tenant" });
    }
});

// Update Shop Info
router.put("/me", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { shopName, logo, bankName, bankAccount, bankQr, phone, address } = req.body;
        
        const tenant = await Tenant.findByIdAndUpdate(
            authReq.user!.tenantId,
            { 
                shopName, 
                logo, 
                bankName, 
                bankAccount, 
                bankQr,
                phone,
                address
            },
            { new: true }
        );

        res.json(tenant);
    } catch (error) {
        res.status(500).json({ error: "Failed to update tenant" });
    }
});

export default router;
