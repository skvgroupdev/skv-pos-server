import express, { Request, Response } from "express";
import { authMiddleware, AuthRequest, requireRoles } from "../middleware/authMiddleware";
import Order from "../models/Order";
import Product from "../models/Product";
import mongoose from "mongoose";

const router = express.Router();
router.use(authMiddleware as express.RequestHandler);
router.use(requireRoles(["SHOP_ADMIN"]));

// Helper: Parse Date Range
const getDateRange = (req: Request) => {
    const { startDate, endDate } = req.query;
    const end = endDate ? new Date(endDate as string) : new Date();
    const start = startDate ? new Date(startDate as string) : new Date(end);

    // Set to start/end of day
    end.setHours(23, 59, 59, 999);
    // If startDate not provided, maybe default to 30 days ago? Or today?
    // Let's default 'start' to beginning of 'end' day if only end provided or use explicit logic.
    if (!startDate) {
        start.setHours(0, 0, 0, 0); // Default to today range if nothing provided
    } else {
        start.setHours(0, 0, 0, 0);
    }

    return { start, end };
};

// Helper: Build Match Query (DRY)
const getMatchQuery = (req: Request) => {
    const authReq = req as AuthRequest;
    const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
    const { start, end } = getDateRange(req);
    const { cashierId } = req.query;

    const match: any = {
        tenantId,
        createdAt: { $gte: start, $lte: end },
        status: { $ne: 'CANCELLED' }
    };

    if (cashierId) {
        match.cashierId = new mongoose.Types.ObjectId(cashierId as string);
    }

    return match;
};

// 1. GET /summary
router.get("/summary", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match = getMatchQuery(req);

        // Basic Stats (Sales, Orders, Debt)
        const statsPipeline = [
            { $match: match },
            {
                $group: {
                    _id: "$paymentMethod",
                    totalSales: { $sum: "$total" },
                    totalOrders: { $count: {} },
                    totalDiscount: { $sum: "$discount" },
                    avgOrderValue: { $avg: "$total" },
                    totalDebt: { $sum: "$remainingAmount" },
                    totalChange: { $sum: "$change" }
                }
            }
        ];

        // Received breakdown by currency
        const receivedPipeline = [
            { $match: match },
            { $unwind: "$payments" },
            {
                $group: {
                    _id: "$payments.currency",
                    amount: { $sum: "$payments.amount" },
                    amountInLAK: { $sum: "$payments.amountInLAK" }
                }
            }
        ];

        // Profit (Cost calculation) & Categorical breakdown
        const itemsPipeline = [
            { $match: match },
            { $unwind: "$items" },
            {
                $lookup: {
                    from: "products",
                    localField: "items.product",
                    foreignField: "_id",
                    as: "productInfo"
                }
            },
            { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } },
            {
                $group: {
                    _id: null,
                    totalCost: { $sum: { $multiply: ["$items.cost", "$items.quantity"] } },
                    categoryBreakdown: {
                        $push: {
                            category: "$productInfo.category",
                            revenue: { $multiply: ["$items.price", "$items.quantity"] },
                            cost: { $multiply: ["$items.cost", "$items.quantity"] }
                        }
                    }
                }
            }
        ];

        const [statsResult, receivedResult, itemsResult] = await Promise.all([
            Order.aggregate(statsPipeline),
            Order.aggregate(receivedPipeline),
            Order.aggregate(itemsPipeline)
        ]);

        // Process statsResult which is now grouped by paymentMethod
        const breakdownByMethod = statsResult.map(r => ({
            method: r._id,
            totalSales: r.totalSales, // Sum of order.total (Net Sales already)
            totalOrders: r.totalOrders,
            totalDebt: r.totalDebt,
            totalChange: r.totalChange,
            totalDiscount: r.totalDiscount,
            netRevenue: r.totalSales // Correct: totalSales is already the net revenue
        }));

        const stats = {
            totalSales: breakdownByMethod.reduce((sum, b) => sum + b.totalSales, 0),
            totalOrders: breakdownByMethod.reduce((sum, b) => sum + b.totalOrders, 0),
            totalDebt: breakdownByMethod.reduce((sum, b) => sum + b.totalDebt, 0),
            totalChange: breakdownByMethod.reduce((sum, b) => sum + b.totalChange, 0),
            totalDiscount: breakdownByMethod.reduce((sum, b) => sum + b.totalDiscount, 0),
            avgOrderValue: 0
        };
        stats.avgOrderValue = stats.totalSales / (stats.totalOrders || 1);

        // Adjust received breakdown: subtract change from LAK
        const totalChange = stats.totalChange;
        const receivedBreakdown = receivedResult.map(r => {
            let amount = r.amount;
            let amountInLAK = r.amountInLAK;
            if (r._id === 'LAK') {
                amount -= totalChange;
                amountInLAK -= totalChange;
            }
            return {
                currency: r._id,
                amount,
                amountInLAK
            };
        });

        // If 'LAK' was not in results but there was change, we should add it?
        // Usually LAK exists if there's change because change reflects a LAK impact.
        // But to be safe:
        if (!receivedBreakdown.find(b => b.currency === 'LAK') && stats.totalChange > 0) {
            receivedBreakdown.push({
                currency: 'LAK',
                amount: -stats.totalChange,
                amountInLAK: -stats.totalChange
            });
        }

        const cost = itemsResult[0]?.totalCost || 0;
        const totalProfit = stats.totalSales - cost;

        // Calculate Profit by Category
        const categoryMap: any = {};
        itemsResult[0]?.categoryBreakdown?.forEach((item: any) => {
            const cat = item.category || 'Uncategorized';
            if (!categoryMap[cat]) categoryMap[cat] = { revenue: 0, cost: 0, profit: 0 };
            categoryMap[cat].revenue += item.revenue;
            categoryMap[cat].cost += item.cost;
            categoryMap[cat].profit += (item.revenue - item.cost);
        });

        const profitByCategory = Object.keys(categoryMap).map(cat => ({
            category: cat,
            ...categoryMap[cat]
        })).sort((a, b) => b.profit - a.profit);

        res.json({
            ...stats,
            totalProfit,
            receivedBreakdown,
            profitByCategory,
            breakdownByMethod,
            netSales: stats.totalSales
        });
    } catch (error) {
        console.error("Report Summary Error:", error);
        res.status(500).json({ error: "Failed to fetch summary" });
    }
});

// 2. GET /sales-trends
router.get("/sales-trends", async (req: Request, res: Response) => {
    try {
        const match = getMatchQuery(req);
        const { interval } = req.query; // 'hourly', 'daily', 'monthly'

        // Format for grouping
        let formatString = "%Y-%m-%d";
        if (interval === 'hourly') formatString = "%Y-%m-%d-%H";
        else if (interval === 'monthly') formatString = "%Y-%m";

        const pipeline = [
            { $match: match },
            { $unwind: "$items" },
            {
                $group: {
                    _id: { $dateToString: { format: formatString, date: "$createdAt", timezone: "+07:00" } },
                    sales: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
                    cost: { $sum: { $multiply: ["$items.cost", "$items.quantity"] } },
                    orders: { $sum: 1 } // Note: this is items count if summed here, better group by order first for real orders count?
                }
            },
            { $sort: { _id: 1 } }
        ];

        // For accurate orders count with profit, we need a different approach or two stages
        const trends = await Order.aggregate(pipeline as any);
        res.json(trends.map(t => ({
            date: t._id,
            sales: t.sales,
            profit: t.sales - t.cost,
            orders: t.orders
        })));

    } catch (error) {
        console.error("Sales Trends Error:", error);
        res.status(500).json({ error: "Failed to fetch trends" });
    }
});

// 3. GET /top-products
router.get("/top-products", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        // const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match = getMatchQuery(req);
        const limit = parseInt(req.query.limit as string) || 5;

        const pipeline = [
            { $match: match },
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.product",
                    name: { $first: "$items.name" },
                    sold: { $sum: "$items.quantity" },
                    revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } }
                }
            },
            { $sort: { sold: -1 } }, // Sort by qty sold
            { $limit: limit }
        ];

        const topProducts = await Order.aggregate(pipeline as any);
        res.json(topProducts);

    } catch (error) {
        console.error("Top Products Error:", error);
        res.status(500).json({ error: "Failed to fetch top products" });
    }
});

// 4. GET /top-customers
router.get("/top-customers", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        // const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match = getMatchQuery(req);
        const limit = parseInt(req.query.limit as string) || 5;

        const pipeline = [
            {
                $match: {
                    ...match,
                    customerId: { $ne: null } // Only registered customers
                }
            },
            {
                $group: {
                    _id: "$customerId",
                    totalSpent: { $sum: "$total" },
                    ordersCount: { $sum: 1 },
                    lastOrderDate: { $max: "$createdAt" }
                }
            },
            {
                $lookup: {
                    from: "customers",
                    localField: "_id",
                    foreignField: "_id",
                    as: "customerInfo"
                }
            },
            { $unwind: "$customerInfo" },
            {
                $project: {
                    name: "$customerInfo.name",
                    phone: "$customerInfo.phone",
                    totalSpent: 1,
                    ordersCount: 1,
                    lastOrderDate: 1
                }
            },
            { $sort: { totalSpent: -1 } },
            { $limit: limit }
        ];

        const topCustomers = await Order.aggregate(pipeline as any);
        res.json(topCustomers);

    } catch (error) {
        console.error("Top Customers Error:", error);
        res.status(500).json({ error: "Failed to fetch top customers" });
    }
});

// 5. GET /inventory-valuation
router.get("/inventory-valuation", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);

        // 1. Total stock and low stock count
        const productsCountResult = await Product.aggregate([
            { $match: { tenantId } },
            {
                $group: {
                    _id: null,
                    totalStock: { $sum: "$stock" },
                    totalItems: { $sum: 1 },
                    lowStockCount: {
                        $sum: {
                            $cond: [{ $lte: ["$stock", "$minStock"] }, 1, 0]
                        }
                    }
                }
            }
        ]);

        const totalStock = productsCountResult[0]?.totalStock || 0;
        const totalItems = productsCountResult[0]?.totalItems || 0;
        const lowStockCount = productsCountResult[0]?.lowStockCount || 0;

        // 2. Cost breakdown by currency
        const costPipeline = [
            { $match: { tenantId } },
            {
                $group: {
                    _id: "$costCurrency",
                    totalCost: { $sum: { $multiply: ["$costPrice", "$stock"] } },
                    itemCount: { $sum: 1 }
                }
            }
        ];

        // 3. Category distribution
        const categoryPipeline = [
            { $match: { tenantId } },
            {
                $group: {
                    _id: "$category",
                    count: { $sum: "$stock" },
                    productTypes: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } }
        ];

        // 4. Retail value (in LAK)
        const retailPipeline = [
            { $match: { tenantId } },
            {
                $group: {
                    _id: null,
                    totalRetailValue: { $sum: { $multiply: ["$sellPrice", "$stock"] } }
                }
            }
        ];

        const [costBreakdown, categoryStats, retailResult] = await Promise.all([
            Product.aggregate(costPipeline as any),
            Product.aggregate(categoryPipeline as any),
            Product.aggregate(retailPipeline as any)
        ]);

        const totalRetailValue = retailResult[0]?.totalRetailValue || 0;
        // Calculate total cost value (simple sum of all currency values for now, 
        // ideally should convert based on exchange rates if multi-currency is used)
        const totalCostValue = costBreakdown.reduce((sum, c) => sum + c.totalCost, 0);

        res.json({
            totalStock,
            totalItems,
            lowStockCount,
            totalRetailValue,
            totalCostValue,
            costBreakdown: costBreakdown.map(c => ({
                currency: c._id || 'LAK',
                value: c.totalCost,
                count: c.itemCount
            })),
            categoryBreakdown: categoryStats.map(c => ({
                category: c._id || 'Uncategorized',
                stockCount: c.count,
                productCount: c.productTypes
            }))
        });

    } catch (error) {
        console.error("Inventory Valuation Error:", error);
        res.status(500).json({ error: "Failed to fetch inventory valuation" });
    }
});

// 6. GET /product-performance - Professional Product Analytics
router.get("/product-performance", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        // const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match = getMatchQuery(req);

        // Get all products with sales data
        const productAnalytics = await Order.aggregate([
            { $match: match },
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.product",
                    productName: { $first: "$items.name" },
                    totalSold: { $sum: "$items.quantity" },
                    totalRevenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
                    totalCost: { $sum: { $multiply: ["$items.cost", "$items.quantity"] } },
                    totalProfit: {
                        $sum: {
                            $subtract: [
                                { $multiply: ["$items.price", "$items.quantity"] },
                                { $multiply: ["$items.cost", "$items.quantity"] }
                            ]
                        }
                    },
                    ordersCount: { $sum: 1 },
                    avgPrice: { $avg: "$items.price" },
                    maxPrice: { $max: "$items.price" },
                    minPrice: { $min: "$items.price" }
                }
            },
            {
                $lookup: {
                    from: "products",
                    localField: "_id",
                    foreignField: "_id",
                    as: "productInfo"
                }
            },
            { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    productId: "$_id",
                    name: "$productName",
                    category: "$productInfo.category",
                    currentStock: "$productInfo.stock",
                    minStock: "$productInfo.minStock",
                    totalSold: 1,
                    totalRevenue: 1,
                    totalCost: 1,
                    totalProfit: 1,
                    profitMargin: {
                        $cond: [
                            { $gt: ["$totalRevenue", 0] },
                            { $multiply: [{ $divide: ["$totalProfit", "$totalRevenue"] }, 100] },
                            0
                        ]
                    },
                    ordersCount: 1,
                    avgPrice: 1,
                    stockStatus: {
                        $cond: [
                            { $lte: ["$productInfo.stock", "$productInfo.minStock"] },
                            "low",
                            "normal"
                        ]
                    }
                }
            },
            { $sort: { totalRevenue: -1 } }
        ]);

        // Calculate ABC Analysis (Pareto principle)
        const totalRevenue = productAnalytics.reduce((sum, p) => sum + p.totalRevenue, 0);
        let cumulativeRevenue = 0;
        const productsWithABC = productAnalytics.map(product => {
            cumulativeRevenue += product.totalRevenue;
            const cumulativePercent = (cumulativeRevenue / totalRevenue) * 100;
            let abcClass = 'C';
            if (cumulativePercent <= 80) abcClass = 'A';
            else if (cumulativePercent <= 95) abcClass = 'B';

            return { ...product, abcClass, cumulativePercent };
        });

        // Category Performance Summary
        const categoryPerformance = productAnalytics.reduce((acc: any, product) => {
            const cat = product.category || 'Uncategorized';
            if (!acc[cat]) {
                acc[cat] = {
                    category: cat,
                    totalRevenue: 0,
                    totalProfit: 0,
                    totalSold: 0,
                    productCount: 0
                };
            }
            acc[cat].totalRevenue += product.totalRevenue;
            acc[cat].totalProfit += product.totalProfit;
            acc[cat].totalSold += product.totalSold;
            acc[cat].productCount++;
            return acc;
        }, {});

        const categoryStats = Object.values(categoryPerformance).sort((a: any, b: any) => b.totalRevenue - a.totalRevenue);

        res.json({
            products: productsWithABC,
            categoryPerformance: categoryStats,
            summary: {
                totalProducts: productsWithABC.length,
                totalRevenue,
                totalProfit: productAnalytics.reduce((sum, p) => sum + p.totalProfit, 0),
                totalUnitsSold: productAnalytics.reduce((sum, p) => sum + p.totalSold, 0),
                avgProfitMargin: productAnalytics.reduce((sum, p) => sum + p.profitMargin, 0) / (productAnalytics.length || 1)
            }
        });

    } catch (error) {
        console.error("Product Performance Error:", error);
        res.status(500).json({ error: "Failed to fetch product performance" });
    }
});

// 7. GET /stock-movement - Track stock changes over time
router.get("/stock-movement", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        // const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match = getMatchQuery(req);

        // Daily sales movement
        const salesMovement = await Order.aggregate([
            { $match: match },
            { $unwind: "$items" },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+07:00" } }
                    },
                    unitsSold: { $sum: "$items.quantity" },
                    ordersCount: { $addToSet: "$_id" }
                }
            },
            {
                $project: {
                    date: "$_id.date",
                    unitsSold: 1,
                    ordersCount: { $size: "$ordersCount" }
                }
            },
            { $sort: { date: 1 } }
        ]);

        res.json(salesMovement);

    } catch (error) {
        console.error("Stock Movement Error:", error);
        res.status(500).json({ error: "Failed to fetch stock movement" });
    }
});

// 8. GET /low-stock-products - Detailed low stock report
router.get("/low-stock-products", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);

        const lowStockProducts = await Product.find({
            tenantId,
            $expr: { $lte: ["$stock", "$minStock"] }
        })
            .select('name category stock minStock costPrice sellPrice supplier brand')
            .sort({ stock: 1 })
            .lean();

        const enriched = lowStockProducts.map(p => ({
            ...p,
            reorderQuantity: Math.max(50, (p.minStock || 5) * 3 - (p.stock || 0)),
            daysUntilStockout: Math.ceil((p.stock || 0) / Math.max(1, (p.stock || 0) * 0.1)),
            status: (p.stock || 0) === 0 ? 'out-of-stock' : (p.stock || 0) <= (p.minStock || 5) * 0.5 ? 'critical' : 'low'
        }));

        res.json({ data: enriched });

    } catch (error) {
        console.error("Low Stock Products Error:", error);
        res.status(500).json({ error: "Failed to fetch low stock products" });
    }
});

// 9. GET /customer-analytics - Comprehensive customer analysis
router.get("/customer-analytics", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        // const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const match = getMatchQuery(req);

        // RFM Analysis (Recency, Frequency, Monetary)
        const customerAnalytics = await Order.aggregate([
            {
                $match: {
                    ...match,
                    customerId: { $ne: null }
                }
            },
            {
                $group: {
                    _id: "$customerId",
                    totalSpent: { $sum: "$total" },
                    totalOrders: { $sum: 1 },
                    totalDebt: { $sum: "$remainingAmount" },
                    paidAmount: { $sum: "$paidAmount" },
                    lastOrderDate: { $max: "$createdAt" },
                    firstOrderDate: { $min: "$createdAt" },
                    avgOrderValue: { $avg: "$total" },
                    totalDiscount: { $sum: "$discount" }
                }
            },
            {
                $lookup: {
                    from: "customers",
                    localField: "_id",
                    foreignField: "_id",
                    as: "customerInfo"
                }
            },
            { $unwind: "$customerInfo" },
            {
                $project: {
                    customerId: "$_id",
                    name: "$customerInfo.name",
                    phone: "$customerInfo.phone",
                    email: "$customerInfo.email",
                    totalSpent: 1,
                    totalOrders: 1,
                    totalDebt: 1,
                    paidAmount: 1,
                    lastOrderDate: 1,
                    firstOrderDate: 1,
                    avgOrderValue: 1,
                    totalDiscount: 1,
                    daysSinceLastOrder: {
                        $divide: [
                            { $subtract: [new Date(), "$lastOrderDate"] },
                            1000 * 60 * 60 * 24
                        ]
                    },
                    customerLifetimeDays: {
                        $divide: [
                            { $subtract: ["$lastOrderDate", "$firstOrderDate"] },
                            1000 * 60 * 60 * 24
                        ]
                    }
                }
            },
            { $sort: { totalSpent: -1 } }
        ]);

        // Calculate RFM scores
        const maxRecency = Math.max(...customerAnalytics.map(c => c.daysSinceLastOrder || 0));
        const maxFrequency = Math.max(...customerAnalytics.map(c => c.totalOrders));
        const maxMonetary = Math.max(...customerAnalytics.map(c => c.totalSpent));

        const customersWithRFM = customerAnalytics.map(customer => {
            // RFM Scoring (1-5, where 5 is best)
            const recencyScore = 5 - Math.floor((customer.daysSinceLastOrder / (maxRecency || 1)) * 4);
            const frequencyScore = Math.ceil((customer.totalOrders / (maxFrequency || 1)) * 5);
            const monetaryScore = Math.ceil((customer.totalSpent / (maxMonetary || 1)) * 5);
            const rfmScore = recencyScore + frequencyScore + monetaryScore;

            // Customer Segment
            let segment = 'At Risk';
            if (rfmScore >= 13) segment = 'VIP';
            else if (rfmScore >= 10) segment = 'Loyal';
            else if (rfmScore >= 7) segment = 'Regular';
            else if (rfmScore >= 4) segment = 'At Risk';
            else segment = 'Lost';

            return {
                ...customer,
                rfm: {
                    recency: recencyScore,
                    frequency: frequencyScore,
                    monetary: monetaryScore,
                    score: rfmScore,
                    segment
                },
                debtStatus: customer.totalDebt > 0 ? 'has-debt' : 'clear',
                lifetimeValue: customer.totalSpent
            };
        });

        res.json(customersWithRFM);

    } catch (error) {
        console.error("Customer Analytics Error:", error);
        res.status(500).json({ error: "Failed to fetch customer analytics" });
    }
});

// 10. GET /customer-preferences/:customerId - Individual customer purchase preferences
router.get("/customer-preferences/:customerId", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const customerIdParam = req.params.customerId;
        if (typeof customerIdParam !== "string" || !mongoose.Types.ObjectId.isValid(customerIdParam)) {
            return res.status(400).json({ error: "Invalid customer ID" });
        }

        const customerId = new mongoose.Types.ObjectId(customerIdParam);

        // Get customer's purchase history
        const purchaseHistory = await Order.aggregate([
            {
                $match: {
                    tenantId,
                    customerId,
                    status: { $ne: 'CANCELLED' }
                }
            },
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.product",
                    productName: { $first: "$items.name" },
                    timesBought: { $sum: 1 },
                    totalQuantity: { $sum: "$items.quantity" },
                    totalSpent: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
                    avgPrice: { $avg: "$items.price" },
                    lastPurchased: { $max: "$createdAt" }
                }
            },
            {
                $lookup: {
                    from: "products",
                    localField: "_id",
                    foreignField: "_id",
                    as: "productInfo"
                }
            },
            { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    productId: "$_id",
                    productName: 1,
                    category: "$productInfo.category",
                    brand: "$productInfo.brand",
                    currentStock: "$productInfo.stock",
                    currentPrice: "$productInfo.sellPrice",
                    timesBought: 1,
                    totalQuantity: 1,
                    totalSpent: 1,
                    avgPrice: 1,
                    lastPurchased: 1,
                    daysSinceLastPurchase: {
                        $divide: [
                            { $subtract: [new Date(), "$lastPurchased"] },
                            1000 * 60 * 60 * 24
                        ]
                    }
                }
            },
            { $sort: { timesBought: -1, totalSpent: -1 } }
        ]);

        // Category preferences
        const categoryPreferences = await Order.aggregate([
            {
                $match: {
                    tenantId,
                    customerId,
                    status: { $ne: 'CANCELLED' }
                }
            },
            { $unwind: "$items" },
            {
                $lookup: {
                    from: "products",
                    localField: "items.product",
                    foreignField: "_id",
                    as: "productInfo"
                }
            },
            { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } },
            {
                $group: {
                    _id: "$productInfo.category",
                    orderCount: { $sum: 1 },
                    totalSpent: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
                    itemsCount: { $sum: "$items.quantity" }
                }
            },
            {
                $project: {
                    category: "$_id",
                    orderCount: 1,
                    totalSpent: 1,
                    itemsCount: 1
                }
            },
            { $sort: { totalSpent: -1 } }
        ]);

        // Get recommendations (products in favorite categories not yet purchased)
        const favoriteCategories = categoryPreferences.slice(0, 3).map(c => c.category);
        const purchasedProductIds = purchaseHistory.map(p => p.productId);

        const recommendations = await Product.find({
            tenantId,
            category: { $in: favoriteCategories },
            _id: { $nin: purchasedProductIds },
            status: 'active',
            stock: { $gt: 0 }
        })
            .select('name category brand sellPrice stock')
            .limit(10)
            .lean();

        res.json({
            favoriteProducts: purchaseHistory.slice(0, 10),
            categoryPreferences,
            recommendations: recommendations.map(r => ({
                ...r,
                reason: `Popular in ${r.category} - customer's favorite category`
            })),
            summary: {
                totalProductsPurchased: purchaseHistory.length,
                favoriteCategory: categoryPreferences[0]?.category || 'N/A',
                mostBoughtProduct: purchaseHistory[0]?.productName || 'N/A'
            }
        });

    } catch (error) {
        console.error("Customer Preferences Error:", error);
        res.status(500).json({ error: "Failed to fetch customer preferences" });
    }
});

// 11. GET /customer-debt-summary - Debt tracking overview
router.get("/customer-debt-summary", async (req: Request, res: Response) => {
    try {
        const authReq = req as AuthRequest;
        const tenantId = new mongoose.Types.ObjectId(authReq.user!.tenantId);
        const { start, end } = getDateRange(req);

        const debtSummary = await Order.aggregate([
            {
                $match: {
                    tenantId,
                    createdAt: { $gte: start, $lte: end },
                    remainingAmount: { $gt: 0 },
                    status: { $ne: 'CANCELLED' }
                }
            },
            {
                $group: {
                    _id: "$customerId",
                    totalDebt: { $sum: "$remainingAmount" },
                    totalOrders: { $sum: 1 },
                    oldestDebt: { $min: "$createdAt" },
                    newestDebt: { $max: "$createdAt" }
                }
            },
            {
                $lookup: {
                    from: "customers",
                    localField: "_id",
                    foreignField: "_id",
                    as: "customerInfo"
                }
            },
            { $unwind: "$customerInfo" },
            {
                $project: {
                    customerId: "$_id",
                    name: "$customerInfo.name",
                    phone: "$customerInfo.phone",
                    totalDebt: 1,
                    totalOrders: 1,
                    oldestDebt: 1,
                    newestDebt: 1,
                    daysSinceOldest: {
                        $divide: [
                            { $subtract: [new Date(), "$oldestDebt"] },
                            1000 * 60 * 60 * 24
                        ]
                    },
                    debtStatus: {
                        $cond: [
                            { $gte: [{ $divide: [{ $subtract: [new Date(), "$oldestDebt"] }, 1000 * 60 * 60 * 24] }, 30] },
                            "overdue",
                            "current"
                        ]
                    }
                }
            },
            { $sort: { totalDebt: -1 } }
        ]);

        const totalDebt = debtSummary.reduce((sum, c) => sum + c.totalDebt, 0);
        const overdueCount = debtSummary.filter(c => c.debtStatus === 'overdue').length;
        const overdueAmount = debtSummary
            .filter(c => c.debtStatus === 'overdue')
            .reduce((sum, c) => sum + c.totalDebt, 0);

        res.json({
            customers: debtSummary,
            summary: {
                totalDebt,
                totalCustomersWithDebt: debtSummary.length,
                overdueCount,
                overdueAmount,
                currentDebt: totalDebt - overdueAmount
            }
        });

    } catch (error) {
        console.error("Customer Debt Summary Error:", error);
        res.status(500).json({ error: "Failed to fetch debt summary" });
    }
});

export default router;
