import express, { Request, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import { ProductService } from "../services/ProductService";

const router = express.Router();

// Middleware: Allow ShopAdmin and StockKeeper
const requireProductPermission = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authReq = req as AuthRequest;
  if (
    !authReq.user ||
    (!authReq.user.roles.includes("SHOP_ADMIN") &&
      !authReq.user.roles.includes("CASHIER") &&
      !authReq.user.roles.includes("SUPER_ADMIN"))
  ) {
    return res.status(403).json({ error: "Access Denied" });
  }
  next();
};

router.use(authMiddleware as express.RequestHandler);
router.use(requireProductPermission);

router.get("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const { page, limit, search, category, status, stockLevel, minPrice, maxPrice } = req.query;

    const result = await ProductService.getProducts(
      authReq.user!.tenantId,
      Number(page) || 1,
      Number(limit) || 20,
      search as string,
      {
         category: category as string,
         status: status as string,
         stockLevel: stockLevel as string,
         minPrice: minPrice ? Number(minPrice) : undefined,
         maxPrice: maxPrice ? Number(maxPrice) : undefined,
         sort: req.query.sort as string
      }
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.get("/search", async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthRequest;
      const query = req.query.query as string;
      
      if (!query) {
          res.json([]);
          return;
      }
  
      const products = await ProductService.searchProducts(
        authReq.user!.tenantId,
        query
      );
      res.json(products);
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const product = await ProductService.getProductById(
      authReq.user!.tenantId,
      req.params.id as string
    );
    res.json(product);
  } catch (error) {
    res.status(404).json({ error: "Product not found" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const product = await ProductService.createProduct(
      authReq.user!.tenantId,
      req.body
    );
    res.status(201).json(product);
  } catch (error) {
    res.status(400).json({ error: "Failed to create product" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const product = await ProductService.updateProduct(
      authReq.user!.tenantId,
      req.params.id as string,
      req.body
    );
    res.json(product);
  } catch (error) {
    res.status(400).json({ error: "Failed to update product" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    await ProductService.deleteProduct(authReq.user!.tenantId, req.params.id as string);
    res.json({ message: "Product deleted" });
  } catch (error) {
    res.status(400).json({ error: "Failed to delete product" });
  }
});

router.get("/:id/transactions", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const transactions = await ProductService.getProductTransactions(
      authReq.user!.tenantId,
      req.params.id as string
    );
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

router.get("/transactions/all", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const { startDate, endDate, type } = req.query;
    const transactions = await ProductService.getInventoryTransactions(
        authReq.user!.tenantId,
        {
            startDate: startDate as string,
            endDate: endDate as string,
            type: type as string
        }
    );
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

router.post("/:id/stock", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { adjustment, type, note, cost } = req.body;
        
        const product = await ProductService.adjustStock(
            authReq.user!.tenantId,
            req.params.id as string,
            { adjustment, type, note, cost }
        );
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: "Failed to adjust stock" });
    }  
});

export default router;
