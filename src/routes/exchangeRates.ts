import express, { Request, Response } from "express";
import ExchangeRate from "../models/ExchangeRate";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";

const router = express.Router();

// Get all exchange rates
router.get("/", authMiddleware as express.RequestHandler, requireRoles(["SHOP_ADMIN", "CASHIER"]), async (req: Request, res: Response) => {
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
router.post("/", authMiddleware as express.RequestHandler, requireRoles(["SHOP_ADMIN"]), async (req: Request, res: Response) => {
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
