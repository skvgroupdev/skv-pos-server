import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import { UnitService } from "../services/UnitService";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);

// --- Units ---

router.get("/", requireRoles(["SHOP_ADMIN", "CASHIER", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;

    const result = await UnitService.getUnits(
      authReq.user!.tenantId,
      page,
      limit,
      search
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch units" });
  }
});

router.post("/", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const unit = await UnitService.createUnit(authReq.user!.tenantId, req.body);
    res.status(201).json(unit);
  } catch (error) {
    res.status(400).json({ error: "Failed to create unit" });
  }
});

router.post("/touch", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    const unit = await UnitService.touchUnit(authReq.user!.tenantId, name);
    res.json(unit);
  } catch (error) {
    res.status(400).json({ error: "Failed to touch unit" });
  }
});

router.put("/:id", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const unit = await UnitService.updateUnit(
      authReq.user!.tenantId,
      req.params.id as string,
      req.body
    );
    res.json(unit);
  } catch (error) {
    res.status(400).json({ error: "Failed to update unit" });
  }
});

router.delete("/:id", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    await UnitService.deleteUnit(authReq.user!.tenantId, req.params.id as string);
    res.json({ message: "Unit deleted" });
  } catch (error) {
    res.status(400).json({ error: "Failed to delete unit" });
  }
});

export default router;
