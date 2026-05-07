import express, { Request, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import { CategoryService } from "../services/CategoryService";

const router = express.Router();

// Middleware: Allow ShopAdmin and StockKeeper
const requireAccess = (req: Request, res: Response, next: NextFunction) => {
  if (
    !(req as AuthRequest).user ||
    (!(req as AuthRequest).user!.roles.includes("SHOP_ADMIN") &&
      !(req as AuthRequest).user!.roles.includes("CASHIER") &&
      !(req as AuthRequest).user!.roles.includes("SUPER_ADMIN") &&
      !(req as AuthRequest).user!.roles.includes("STOCK_KEEPER"))
  ) {
    return res.status(403).json({ error: "Access Denied" });
  }
  next();
};

router.use(authMiddleware as express.RequestHandler);
router.use(requireAccess);

// --- Categories ---

router.get("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;

    const result = await CategoryService.getCategories(
      authReq.user!.tenantId,
      page,
      limit,
      search
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const category = await CategoryService.createCategory(
      authReq.user!.tenantId,
      req.body
    );
    res.status(201).json(category);
  } catch (error) {
    res.status(400).json({ error: "Failed to create category" });
  }
});

router.post("/touch", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    
    const category = await CategoryService.touchCategory(
      authReq.user!.tenantId,
      name
    );
    res.json(category);
  } catch (error) {
    res.status(400).json({ error: "Failed to touch category" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const category = await CategoryService.updateCategory(
      authReq.user!.tenantId,
      req.params.id,
      req.body
    );
    res.json(category);
  } catch (error) {
    res.status(400).json({ error: "Failed to update category" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    await CategoryService.deleteCategory(authReq.user!.tenantId, req.params.id);
    res.json({ message: "Category deleted" });
  } catch (error) {
    res.status(400).json({ error: "Failed to delete category" });
  }
});

export default router;
