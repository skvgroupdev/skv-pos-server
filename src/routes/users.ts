import express, { Request, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import { UserService } from "../services/UserService";

const router = express.Router();

const requireShopAdmin = (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthRequest;
  if (
    !authReq.user ||
    (!authReq.user.roles.includes("SHOP_ADMIN") &&
      !authReq.user.roles.includes("SUPER_ADMIN"))
  ) {
    return res
      .status(403)
      .json({ error: "Access Denied. Requires ShopAdmin role." });
  }
  next();
};

router.use(authMiddleware as express.RequestHandler);
router.use(requireShopAdmin);

router.get("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const result = await UserService.getEmployees(
      authReq.user!.tenantId,
      page,
      limit
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const user = await UserService.createEmployee(
      authReq.user!.tenantId,
      req.body
    );
    res.status(201).json(user);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: "Failed to create employee" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const user = await UserService.updateEmployee(
      authReq.user!.tenantId,
      req.params.id,
      req.body
    );
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: "Failed to update employee" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    await UserService.deleteEmployee(authReq.user!.tenantId, req.params.id, authReq.user!.userId);
    res.json({ message: "Employee deleted" });
  } catch (error) {
    res.status(400).json({ error: "Failed to delete employee" });
  }
});

export default router;
