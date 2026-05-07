import express, { Request, Response, NextFunction } from "express";
import ExchangeRate from "../models/ExchangeRate";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";

const router = express.Router();

// Middleware to check roles
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    if (!authReq.user || (!authReq.user.roles.includes("SHOP_ADMIN") && !authReq.user.roles.includes("SUPER_ADMIN"))) {
        return res.status(403).json({ error: "Access Denied" });
    }
    next();
};

// Get all exchange rates
router.get("/", authMiddleware as express.RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user!.tenantId;
    const rates = await ExchangeRate.find({ tenantId });
    res.json({ data: rates });
  } catch (error) {
    res.status(500).json({ message: "Error fetching exchange rates", error });
  }
});

// Update or Create exchange rate
router.post("/", authMiddleware as express.RequestHandler, requireAdmin, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user!.tenantId;
    const { currency, rate } = req.body;


    if (!currency || !rate) {
      return res.status(400).json({ message: "Currency and Rate are required" });
    }

    const updatedRate = await ExchangeRate.findOneAndUpdate(
      { tenantId, currency },
      { rate },
      { new: true, upsert: true } // Upsert: create if not exists
    );

    res.json(updatedRate);
  } catch (error) {
    res.status(500).json({ message: "Error updating exchange rate", error });
  }
});

export default router;
