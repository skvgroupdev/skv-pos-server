import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import Tenant from "../models/Tenant";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);

const sanitizeSvg = (value?: string) => {
    if (!value || !value.trim().toLowerCase().includes("<svg")) return value || "";

    return value
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
        .replace(/\son\w+="[^"]*"/gi, "")
        .replace(/\son\w+='[^']*'/gi, "")
        .replace(/javascript:/gi, "");
};

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
router.put("/me", requireRoles(["SHOP_ADMIN"]), async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { shopName, logo, bankName, bankAccount, bankQr, phone, address, receiptNote } = req.body;

        const tenant = await Tenant.findByIdAndUpdate(
            authReq.user!.tenantId,
            {
                shopName,
                logo: sanitizeSvg(logo),
                bankName,
                bankAccount,
                bankQr: sanitizeSvg(bankQr),
                phone,
                address,
                receiptNote
            },
            { new: true }
        );

        res.json(tenant);
    } catch (error) {
        res.status(500).json({ error: "Failed to update tenant" });
    }
});

export default router;
