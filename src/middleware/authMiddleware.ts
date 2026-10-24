import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import Tenant from "../models/Tenant";

export type TokenScope = "TENANT" | "PLATFORM";

export interface AuthUser {
  userId: string;
  tenantId: string;
  roles: string[];
  scope?: TokenScope;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

const isTenantActive = (status: string | undefined): boolean =>
  status?.toUpperCase() === "ACTIVE";

const verifyBearerToken = (req: Request, res: Response): AuthUser | null => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: "Authentication token missing" });
    return null;
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "Authentication token missing" });
    return null;
  }

  try {
    return jwt.verify(token, process.env.JWT_SECRET || "secret") as AuthUser;
  } catch {
    res.status(403).json({ error: "Invalid Token" });
    return null;
  }
};

export const tenantAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const user = verifyBearerToken(req, res);
  if (!user) return;

  if (user.scope && user.scope !== "TENANT") {
    return res.status(403).json({ error: "Tenant token required" });
  }

  if (!user.tenantId) {
    return res.status(403).json({ error: "Tenant token required" });
  }

  const tenant = await Tenant.findById(user.tenantId).select("status");
  if (!tenant) {
    return res.status(403).json({ error: "Tenant not found" });
  }

  if (!isTenantActive(tenant.status)) {
    return res.status(403).json({ error: "Tenant is not active" });
  }

  (req as AuthRequest).user = { ...user, scope: "TENANT" };
  next();
};

export const platformAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const user = verifyBearerToken(req, res);
  if (!user) return;

  if (user.scope !== "PLATFORM") {
    return res.status(403).json({ error: "Platform token required" });
  }

  (req as AuthRequest).user = user;
  next();
};

export const authMiddleware = tenantAuthMiddleware;

export const requireActiveTenant = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const user = (req as AuthRequest).user;

  if (!user?.tenantId) {
    return res.status(403).json({ error: "Tenant token required" });
  }

  const tenant = await Tenant.findById(user.tenantId).select("status");
  if (!tenant) {
    return res.status(403).json({ error: "Tenant not found" });
  }

  if (!isTenantActive(tenant.status)) {
    return res.status(403).json({ error: "Tenant is not active" });
  }

  next();
};

export const requireRoles = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthRequest).user;

    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (allowedRoles.some((role) => user.roles.includes(role))) {
      return next();
    }

    return res.status(403).json({ error: "Access Denied" });
  };
};

export const requireTenantRoles = requireRoles;

export const requirePlatformRoles = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthRequest).user;

    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (user.scope !== "PLATFORM") {
      return res.status(403).json({ error: "Platform token required" });
    }

    if (allowedRoles.some((role) => user.roles.includes(role))) {
      return next();
    }

    return res.status(403).json({ error: "Access Denied" });
  };
};
