import express, { Request, Response } from "express";
import { PlatformAuthService } from "../services/PlatformAuthService";
import {
  AuthRequest,
  platformAuthMiddleware,
  requirePlatformRoles,
} from "../middleware/authMiddleware";
import PlatformUser from "../models/PlatformUser";
import Tenant from "../models/Tenant";

const router = express.Router();

router.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { username, identifier, password } = req.body;
    const result = await PlatformAuthService.login(identifier || username, password);
    res.json(result);
  } catch (error: any) {
    res.status(401).json({ error: error.message });
  }
});

router.use(platformAuthMiddleware as express.RequestHandler);

router.get("/auth/me", async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const user = await PlatformUser.findById(authReq.user!.userId).select("-passwordHash");
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    ...user.toObject(),
    id: user._id.toString(),
    scope: "PLATFORM",
  });
});

router.get(
  "/dashboard",
  requirePlatformRoles(["SUPER_ADMIN", "BILLING_ADMIN", "SUPPORT_ADMIN"]),
  async (_req: Request, res: Response) => {
    const [totalTenants, groceryTenants, restaurantTenants, activeTenants] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ businessType: "GROCERY" }),
      Tenant.countDocuments({ businessType: "RESTAURANT" }),
      Tenant.countDocuments({ status: "ACTIVE" }),
    ]);

    res.json({
      totalTenants,
      groceryTenants,
      restaurantTenants,
      activeTenants,
    });
  }
);

export default router;
