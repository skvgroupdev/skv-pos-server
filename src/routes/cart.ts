import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import Cart from "../models/Cart";
import Product from "../models/Product";

const router = express.Router();

type PopulatedCartItem = {
    product?: {
        sellPrice: number;
        wholesalePrice?: number;
        costPrice?: number;
        costCurrency?: string;
    };
    price: number;
    costPrice?: number;
    costCurrency?: string;
};

router.use(authMiddleware as express.RequestHandler);

// Get All Carts for User
router.get("/", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        let carts = await Cart.find({ 
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        }).populate('items.product').populate('customer');

        if (carts.length === 0) {
            const newCart = await Cart.create({
                tenantId: authReq.user!.tenantId,
                userId: authReq.user!.userId,
                name: "cart 1",
                items: []
            });
            carts = [newCart];
        }
        res.json(carts);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch carts" });
    }
});

// Create New Cart
router.post("/", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        
        // Find existing count to name it
        const count = await Cart.countDocuments({
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        });

        const newCart = await Cart.create({
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId,
            name: `cart ${count + 1}`,
            items: []
        });

        // Return all carts
        const carts = await Cart.find({ 
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        }).populate('items.product');
        
        res.json(carts);
    } catch (error) {
        res.status(500).json({ error: "Failed to create cart" });
    }
});

// Add Item (Reserve Stock)
router.post("/add", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { cartId, productId, quantity, price } = req.body;
        
        // 1. Check Product Stock and Status
        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ error: "Product not found" });

        if (product.status !== 'active') {
             return res.status(400).json({ error: "Product is inactive and cannot be sold" });
        }

        // Skip availability check if removing items (quantity < 0)
        if (quantity > 0) {
            const available = product.stock - (product.reservedStock || 0);
            if (available < quantity) {
                return res.status(400).json({ error: "Stock not available (Reserved by others)" });
            }
        }

        // 2. Reserve Stock
        // quantity can be negative here, efficiently releasing reservation
        product.reservedStock = Math.max(0, (product.reservedStock || 0) + quantity);
        await product.save();

        // 3. Update Cart
        const cart = await Cart.findOne({ 
            _id: cartId,
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        const existingItem = cart.items.find(item => item.product.toString() === productId);
        if (existingItem) {
            existingItem.quantity += quantity;
            if (existingItem.quantity <= 0) {
                 // Remove item if quantity drops to 0 or less
                 const idx = cart.items.indexOf(existingItem);
                 cart.items.splice(idx, 1);
            }
        } else if (quantity > 0) {
            cart.items.push({ 
                product: productId, 
                quantity, 
                price,
                costPrice: product.costPrice,
                costCurrency: product.costCurrency
            } as any);
        }
        
        await cart.save();
        
        const carts = await Cart.find({ 
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        }).populate('items.product');
        
        res.json(carts);

    } catch (error: any) {
        res.status(500).json({ error: error.message || "Failed to add to cart" });
    }
});

// Sync current cart item prices when sale mode changes.
router.post("/prices", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { cartId, saleMode } = req.body;

        if (!["retail", "wholesale"].includes(saleMode)) {
            return res.status(400).json({ error: "Invalid sale mode" });
        }

        const cart = await Cart.findOne({
            _id: cartId,
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        }).populate("items.product");

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        (cart.items as unknown as PopulatedCartItem[]).forEach((item) => {
            const product = item.product;
            if (!product) return;

            const wholesalePrice = product.wholesalePrice || 0;
            item.price = saleMode === "wholesale" && wholesalePrice > 0
                ? wholesalePrice
                : product.sellPrice;
            item.costPrice = product.costPrice;
            item.costCurrency = product.costCurrency;
        });

        await cart.save();

        const carts = await Cart.find({
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        }).populate("items.product").populate("customer");

        res.json(carts);
    } catch (error: any) {
        res.status(500).json({ error: error.message || "Failed to update cart prices" });
    }
});

// Remove Item Entirely (Release Stock)
router.post("/remove", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { cartId, productId } = req.body;

        const cart = await Cart.findOne({ 
            _id: cartId,
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        const itemIndex = cart.items.findIndex(item => item.product.toString() === productId);
        if (itemIndex > -1) {
            const item = cart.items[itemIndex];
            
            // Release Stock
            const product = await Product.findById(productId);
            if (product) {
                product.reservedStock = Math.max(0, (product.reservedStock || 0) - item.quantity);
                await product.save();
            }

            cart.items.splice(itemIndex, 1);
            await cart.save();
        }

        const carts = await Cart.find({ 
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        }).populate('items.product');
        res.json(carts);

    } catch (error) {
        res.status(500).json({ error: "Failed to remove item" });
    }
});

// Clear/Delete Specific Cart (Release All Stock)
router.delete("/:cartId", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const cartId = req.params.cartId;

        const cart = await Cart.findOne({ 
            _id: cartId,
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        });

        if (cart) {
            // Release all stock
            for (const item of cart.items) {
                const product = await Product.findById(item.product);
                if (product) {
                    product.reservedStock = Math.max(0, (product.reservedStock || 0) - item.quantity);
                    await product.save();
                }
            }
            
            await Cart.deleteOne({ _id: cartId });
            
            // Ensure at least one cart exists
            const remaining = await Cart.countDocuments({ tenantId: authReq.user!.tenantId, userId: authReq.user!.userId });
            if (remaining === 0) {
                 await Cart.create({
                    tenantId: authReq.user!.tenantId,
                    userId: authReq.user!.userId,
                    name: "Sale 1",
                    items: []
                });
            }
        }

        const carts = await Cart.find({ 
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        }).populate('items.product');
        res.json(carts);

    } catch (error) {
        res.status(500).json({ error: "Failed to clear cart" });
    }
});

// Set Customer for Cart
router.post("/customer", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const { cartId, customerId } = req.body;

        const cart = await Cart.findOne({
            _id: cartId,
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        cart.customer = customerId || undefined; // Clear if null
        await cart.save();

        const carts = await Cart.find({
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        }).populate('items.product').populate('customer');

        res.json(carts);
    } catch (error) {
        res.status(500).json({ error: "Failed to set customer" });
    }
});

export default router;
