import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
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
router.use(requireRoles(["SHOP_ADMIN", "CASHIER"]));

const releaseReservedStock = async (productId: any, tenantId: any, quantity: number) => {
    if (quantity <= 0) return Promise.resolve();

    const product = await Product.findOne({ _id: productId, tenantId });
    if (!product) return;

    product.reservedStock = Math.max(0, (product.reservedStock || 0) - quantity);
    await product.save();
};

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

        const quantityDelta = Number(quantity);
        if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
            return res.status(400).json({ error: "Invalid quantity" });
        }

        if (quantityDelta > 0 && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
            return res.status(400).json({ error: "Invalid price" });
        }

        const cart = await Cart.findOne({ 
            _id: cartId,
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        const existingItem = cart.items.find(item => item.product.toString() === productId);

        let reservedQuantity = 0;
        let product: any = null;

        if (quantityDelta > 0) {
            const reserveResult = await Product.updateOne(
                {
                    _id: productId,
                    tenantId: authReq.user!.tenantId,
                    status: "active",
                    $expr: {
                        $gte: [
                            { $subtract: ["$stock", { $ifNull: ["$reservedStock", 0] }] },
                            quantityDelta
                        ]
                    }
                },
                { $inc: { reservedStock: quantityDelta } }
            );

            if (reserveResult.matchedCount === 0) {
                product = await Product.findOne({ _id: productId, tenantId: authReq.user!.tenantId });
                if (!product) return res.status(404).json({ error: "Product not found" });
                if (product.status !== "active") {
                    return res.status(400).json({ error: "Product is inactive and cannot be sold" });
                }
                return res.status(400).json({ error: "Stock not available (Reserved by others)" });
            }

            reservedQuantity = quantityDelta;
            product = await Product.findById(productId);
        }

        try {
            if (existingItem) {
                existingItem.quantity += quantityDelta;
                if (existingItem.quantity <= 0) {
                    const releaseQuantity = Math.min(-quantityDelta, existingItem.quantity - quantityDelta);
                    await releaseReservedStock(productId, authReq.user!.tenantId, releaseQuantity);
                    const idx = cart.items.indexOf(existingItem);
                    cart.items.splice(idx, 1);
                } else if (quantityDelta < 0) {
                    await releaseReservedStock(productId, authReq.user!.tenantId, -quantityDelta);
                }
            } else if (quantityDelta > 0) {
                cart.items.push({
                    product: productId,
                    quantity: quantityDelta,
                    price: Number(price),
                    costPrice: product?.costPrice,
                    costCurrency: product?.costCurrency
                } as any);
            } else {
                await releaseReservedStock(productId, authReq.user!.tenantId, reservedQuantity);
                return res.status(400).json({ error: "Product is not in cart" });
            }

            await cart.save();
        } catch (cartError) {
            await releaseReservedStock(productId, authReq.user!.tenantId, reservedQuantity);
            throw cartError;
        }
        
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

        if (!cartId || !productId) {
            return res.status(400).json({ error: "Cart ID and product ID are required" });
        }

        const cart = await Cart.findOne({ 
            _id: cartId,
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        });

        if (!cart) return res.status(404).json({ error: "Cart not found" });

        const itemIndex = cart.items.findIndex((item: any) => {
            const itemProductId = item.product?._id || item.product;
            return itemProductId?.toString() === productId;
        });

        if (itemIndex > -1) {
            const item = cart.items[itemIndex];
            const itemProductId = (item.product as any)?._id || item.product;
            
            // Release Stock
            await releaseReservedStock(itemProductId, authReq.user!.tenantId, item.quantity);

            cart.items.splice(itemIndex, 1);
            await cart.save();
        }

        const carts = await Cart.find({ 
            tenantId: authReq.user!.tenantId, 
            userId: authReq.user!.userId 
        }).populate('items.product').populate('customer');
        res.json(carts);

    } catch (error: any) {
        res.status(500).json({ error: error.message || "Failed to remove item" });
    }
});

// Update cart item prices when switching between retail and wholesale sale modes
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

        for (const item of cart.items as any[]) {
            const product = item.product;
            if (!product) continue;

            const wholesalePrice = Number(product.wholesalePrice) || 0;
            item.price = saleMode === "wholesale" && wholesalePrice > 0
                ? wholesalePrice
                : product.sellPrice;
        }

        await cart.save();

        const carts = await Cart.find({
            tenantId: authReq.user!.tenantId,
            userId: authReq.user!.userId
        }).populate("items.product").populate("customer");

        res.json(carts);
    } catch (error) {
        res.status(500).json({ error: "Failed to update cart prices" });
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
                await releaseReservedStock(item.product, authReq.user!.tenantId, item.quantity);
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
