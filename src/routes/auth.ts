import express from "express";
import { AuthService } from "../services/AuthService";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { tenantId, username, password, roles } = req.body;
    const result = await AuthService.register({
      tenantId,
      username,
      password,
      roles,
    });
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await AuthService.login(username, password);
    res.json(result);
  } catch (error: any) {
    res.status(401).json({ error: error.message });
  }
});

router.get("/me", authMiddleware, (req, res) => {
  const user = (req as AuthRequest).user;
  res.json(user);
});

export default router;
