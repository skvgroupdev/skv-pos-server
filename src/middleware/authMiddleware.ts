import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthUser {
  userId: string;
  tenantId: string;
  roles: string[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(" ")[1];

    jwt.verify(token, process.env.JWT_SECRET || "secret", (err, user) => {
      if (err) {
        return res.status(403).json({ error: "Invalid Token" });
      }

      (req as AuthRequest).user = user as AuthUser;
      next();
    });
  } else {
    res.status(401).json({ error: "Authentication token missing" });
  }
};

export const requireRoles = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthRequest).user;

    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (
      user.roles.includes("SUPER_ADMIN") ||
      allowedRoles.some((role) => user.roles.includes(role))
    ) {
      return next();
    }

    return res.status(403).json({ error: "Access Denied" });
  };
};
