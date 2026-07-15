import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import { ProductService } from "../services/ProductService";

const router = express.Router();

router.use(authMiddleware as express.RequestHandler);

router.get("/", requireRoles(["SHOP_ADMIN", "CASHIER", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const {
      page,
      limit,
      search,
      category,
      unit,
      status,
      stockLevel,
      minPrice,
      maxPrice,
      catalogNo,
      catalogCode,
      catalogPage,
      catalogNumber,
    } = req.query;

    const result = await ProductService.getProducts(
      authReq.user!.tenantId,
      Number(page) || 1,
      Number(limit) || 20,
      search as string,
      {
         category: category as string,
         unit: unit as string,
         status: status as string,
         stockLevel: stockLevel as string,
         minPrice: minPrice ? Number(minPrice) : undefined,
         maxPrice: maxPrice ? Number(maxPrice) : undefined,
         sort: req.query.sort as string,
         catalogNo: catalogNo as string,
         catalogCode: catalogCode as string,
         catalogPage: catalogPage as string,
         catalogNumber: catalogNumber as string,
      }
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.get("/search", requireRoles(["SHOP_ADMIN", "CASHIER", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
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

router.get("/:id", requireRoles(["SHOP_ADMIN", "CASHIER", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
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

router.post("/", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
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

router.put("/:id", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const existing = await ProductService.getProductById(authReq.user!.tenantId, req.params.id as string);
    if (req.body.stock !== undefined && Number(req.body.stock) !== existing.stock) {
      return res.status(400).json({ error: "Use the audited stock adjustment action to change stock" });
    }
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

router.delete("/:id", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    await ProductService.deleteProduct(authReq.user!.tenantId, req.params.id as string);
    res.json({ message: "Product deleted" });
  } catch (error) {
    res.status(400).json({ error: "Failed to delete product" });
  }
});

router.get("/:id/transactions", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
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

router.get("/transactions/all", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
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

router.post("/:id/stock", requireRoles(["SHOP_ADMIN", "STOCK_KEEPER"]), async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { adjustment, type, note, cost } = req.body;
        if (!note?.trim()) return res.status(400).json({ error: "Stock adjustment reason is required" });
        if (!["IN_PURCHASE", "OUT_DAMAGE", "ADJUST"].includes(type)) {
          return res.status(400).json({ error: "Invalid manual stock adjustment type" });
        }
        
        const product = await ProductService.adjustStock(
            authReq.user!.tenantId,
            req.params.id as string,
            { adjustment, type, note: note.trim(), cost, processedBy: authReq.user!.userId }
        );
        res.json(product);
    } catch (error) {
        res.status(400).json({ error: (error as Error).message || "Failed to adjust stock" });
    }  
});

export default router;
