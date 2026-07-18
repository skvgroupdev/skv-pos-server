import Product, { IProduct } from "../models/Product";
import InventoryTransaction from "../models/InventoryTransaction";
import mongoose from "mongoose";
import { deleteProductImagesFromS3 } from "./uploadService";

export class ProductService {
  static async createProduct(tenantId: string, data: Partial<IProduct>) {
    const product = new Product({ ...data, tenantId });
    const savedProduct = await product.save();

    if (savedProduct.stock > 0) {
      // @ts-ignore
      await InventoryTransaction.create({
        tenantId: tenantId as any,
        productId: savedProduct._id as any,
        type: "IN_PURCHASE",
        quantity: savedProduct.stock,
        cost: savedProduct.costPrice,
        note: "ເພີ່ມສິນຄ້າໃໝ່",
        date: new Date(),
      });
    }

    return savedProduct;
  }

  static async getProducts(
    tenantId: string,
    page: number = 1,
    limit: number = 20,
    search?: string,
    filters?: {
      category?: string;
      status?: string;
      stockLevel?: string; // 'low', 'out'
      minPrice?: number;
      maxPrice?: number;
      sort?: string;
      unit?: string;
      catalogNo?: string;
      catalogCode?: string;
      catalogPage?: string;
      catalogNumber?: string;
    }
  ) {
    const skip = (page - 1) * limit;
    const tenantObjectId = mongoose.Types.ObjectId.isValid(tenantId)
      ? new mongoose.Types.ObjectId(tenantId)
      : tenantId;
    const query: any = { tenantId: tenantObjectId };

    if (search) {
      // Advanced Search Logic (Barcode has priority)
      const cleanInput = search.trim();
      if (cleanInput.length > 3 && /^\d+$/.test(cleanInput)) {
        // If number-like, prioritize barcode match
        query.$or = [
          { barcode: { $regex: cleanInput, $options: 'i' } },
          { name: { $regex: cleanInput, $options: 'i' } }
        ];
      } else {
        query.$or = [
          { name: { $regex: cleanInput, $options: 'i' } },
          { barcode: { $regex: cleanInput, $options: 'i' } },
          { brand: { $regex: cleanInput, $options: 'i' } },
          { sku: { $regex: cleanInput, $options: 'i' } }
        ];
      }
    }

    // Apply Filters
    if (filters) {
      if (filters.category && filters.category !== "all") {
        query.category = filters.category;
      }
      if (filters.unit && filters.unit !== "all") {
        query.unit = filters.unit;
      }
      if (filters.status && filters.status !== "all") {
        query.status = filters.status;
      }
      if (filters.stockLevel) {
        if (filters.stockLevel === "low") {
          query.$expr = { $lte: ["$stock", { $ifNull: ["$minStock", 5] }] };
        } else if (filters.stockLevel === "out") {
          query.stock = { $lte: 0 };
        }
      }
      if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
        query.sellPrice = {};
        if (filters.minPrice) query.sellPrice.$gte = Number(filters.minPrice);
        if (filters.maxPrice) query.sellPrice.$lte = Number(filters.maxPrice);
      }

      // Catalog Filters
      if (filters.catalogNo) query['catalog.No'] = { $regex: filters.catalogNo, $options: 'i' };
      if (filters.catalogCode) query['catalog.code'] = { $regex: filters.catalogCode, $options: 'i' };
      if (filters.catalogPage) query['catalog.page'] = { $regex: filters.catalogPage, $options: 'i' };
      if (filters.catalogNumber) query['catalog.number'] = { $regex: filters.catalogNumber, $options: 'i' };
    }

    let sortOption: any = { soldCount: -1, createdAt: -1 };

    if (filters?.sort) {
      switch (filters.sort) {
        case 'newest':
          sortOption = { createdAt: -1 };
          break;
        case 'price_high':
          sortOption = { sellPrice: -1 };
          break;
        case 'price_low':
          sortOption = { sellPrice: 1 };
          break;
        case 'best_selling':
        default:
          sortOption = { soldCount: -1, createdAt: -1 };
          break;
      }
    }

    const summaryPipeline = [
      { $match: query },
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          totalProducts: { $sum: { $ifNull: ["$stock", 0] } },
          lowStock: {
            $sum: {
              $cond: [
                { $lte: [{ $ifNull: ["$stock", 0] }, { $ifNull: ["$minStock", 0] }] },
                1,
                0,
              ],
            },
          },
          totalValue: {
            $sum: {
              $multiply: [
                { $ifNull: ["$costPrice", 0] },
                { $ifNull: ["$stock", 0] },
              ],
            },
          },
          potentialProfit: {
            $sum: {
              $multiply: [
                { $subtract: [{ $ifNull: ["$sellPrice", 0] }, { $ifNull: ["$costPrice", 0] }] },
                { $ifNull: ["$stock", 0] },
              ],
            },
          },
          projectedRevenue: {
            $sum: {
              $multiply: [
                {
                  $cond: [
                    { $gt: [{ $ifNull: ["$wholesalePrice", 0] }, 0] },
                    { $ifNull: ["$wholesalePrice", 0] },
                    { $ifNull: ["$sellPrice", 0] },
                  ],
                },
                { $ifNull: ["$stock", 0] },
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalItems: 1,
          totalProducts: { $round: ["$totalProducts", 0] },
          lowStock: 1,
          totalValue: { $round: ["$totalValue", 0] },
          potentialProfit: { $round: ["$potentialProfit", 0] },
          projectedRevenue: { $round: ["$projectedRevenue", 0] },
        },
      },
    ];

    const [products, total, summaryResult] = await Promise.all([
      Product.find(query).sort(sortOption).skip(skip).limit(limit),
      Product.countDocuments(query),
      Product.aggregate(summaryPipeline as any),
    ]);
    return {
      data: products,
      summary: summaryResult[0] || {
        lowStock: 0,
        potentialProfit: 0,
        projectedRevenue: 0,
        totalItems: 0,
        totalProducts: 0,
        totalValue: 0,
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getProductById(tenantId: string, productId: string) {
    const product = await Product.findOne({ _id: productId, tenantId });
    if (!product) throw new Error("Product not found");
    return product;
  }

  static async searchProducts(tenantId: string, queryInput: string) {
    const cleanInput = queryInput.trim();

    // 1. Catalog Search Pattern Detection (e.g., "112 5" or "10A-12")
    const catalogRegex = /^([a-zA-Z0-9]+)[\s-]([a-zA-Z0-9]+)$/;
    const catalogMatch = cleanInput.match(catalogRegex);

    if (catalogMatch) {
      const [_, page, number] = catalogMatch;
      // Precision Search
      const catalogResult = await Product.findOne({
        tenantId: tenantId as any,
        'catalog.page': page,
        'catalog.number': number
      } as any);
      if (catalogResult) return [catalogResult];
    }

    // 2. Exact Match (Barcode or ID)
    if (cleanInput.length > 3) {
      const exactMatch = await Product.findOne({
        tenantId: tenantId as any,
        $or: [{ barcode: cleanInput }, { _id: mongoose.isValidObjectId(cleanInput) ? cleanInput : null }]
      } as any);
      if (exactMatch) return [exactMatch];
    }

    // 3. Text Search (Name, Brand, Model)
    // Using $regex for flexibility over $text (which requires weights and specific index setup)
    // or use $text if performance is key later.
    return await Product.find({
      tenantId: tenantId as any,
      $or: [
        { name: { $regex: cleanInput, $options: 'i' } },
        { brand: { $regex: cleanInput, $options: 'i' } },
        { modelName: { $regex: cleanInput, $options: 'i' } }, // Note: Schema uses 'modelName'
        { sku: { $regex: cleanInput, $options: 'i' } }
      ]
    } as any).limit(20);
  }

  static async updateProduct(
    tenantId: string,
    productId: string,
    data: Partial<IProduct>
  ) {
    const oldProduct = await Product.findOne({ _id: productId, tenantId });
    if (!oldProduct) throw new Error("Product not found");

    if (data.stock !== undefined && data.stock !== oldProduct.stock) {
      const diff = data.stock - oldProduct.stock;
      if (diff !== 0) {
        // @ts-ignore
        await InventoryTransaction.create({
          tenantId: tenantId as any,
          productId: productId as any,
          type: "ADJUST",
          quantity: diff,
          cost: data.costPrice || oldProduct.costPrice,
          note: "ແກ້ໄຂສິນຄ້າ",
          date: new Date(),
        });
      }
    }

    const product = await Product.findOneAndUpdate(
      { _id: productId, tenantId },
      data,
      { new: true }
    );

    if (product && (data.images !== undefined || data.imageVariants !== undefined)) {
      const nextImageUrls = new Set<string>();
      product.images?.forEach((url) => nextImageUrls.add(url));
      product.imageVariants?.forEach((variant) => {
        nextImageUrls.add(variant.small);
        nextImageUrls.add(variant.medium);
        nextImageUrls.add(variant.original);
      });

      try {
        await deleteProductImagesFromS3(oldProduct, nextImageUrls);
      } catch (error) {
        console.error("Failed to delete old product images from S3:", error);
      }
    }

    return product;
  }

  static async deleteProduct(tenantId: string, productId: string) {
    const product = await Product.findOneAndDelete({
      _id: productId,
      tenantId,
    });
    if (!product) throw new Error("Product not found");

    try {
      await deleteProductImagesFromS3(product);
    } catch (error) {
      console.error("Failed to delete product images from S3:", error);
    }

    return product;
  }

  static async adjustStock(
    tenantId: string,
    productId: string,
    data: { adjustment: number; type: string; note: string; cost?: number; processedBy: string }
  ) {
    const adjustment = Number(data.adjustment);
    if (!Number.isFinite(adjustment) || adjustment === 0) throw new Error("Invalid stock adjustment");
    if (data.type === "IN_PURCHASE" && adjustment < 0) throw new Error("Purchase adjustment must increase stock");
    if (data.type === "OUT_DAMAGE" && adjustment > 0) throw new Error("Damage adjustment must reduce stock");

    const session = await mongoose.startSession();
    try {
      let updatedProduct: any;
      await session.withTransaction(async () => {
        const product = await Product.findOne({ _id: productId, tenantId }).session(session);
        if (!product) throw new Error("Product not found");
        if (product.stock + adjustment < 0) throw new Error("Stock cannot be negative");

        await InventoryTransaction.create([{
          tenantId: tenantId as any,
          productId: productId as any,
          type: data.type as any,
          quantity: adjustment,
          cost: data.cost || product.costPrice,
          note: data.note,
          processedBy: data.processedBy,
          date: new Date(),
        }], { session });

        product.stock += adjustment;
        updatedProduct = await product.save({ session });
      });
      return updatedProduct;
    } finally {
      await session.endSession();
    }
  }

  static async getProductTransactions(tenantId: string, productId: string) {
    return await InventoryTransaction.find({
      tenantId: tenantId as any,
      productId: productId as any,
    }).sort({ date: -1 });
  }

  static async getInventoryTransactions(
    tenantId: string,
    filters: { startDate?: string; endDate?: string; type?: string }
  ) {
    const query: any = { tenantId };

    if (filters.type && filters.type !== "ALL") {
      query.type = filters.type;
    }

    if (filters.startDate || filters.endDate) {
      query.date = {};
      if (filters.startDate) {
        query.date.$gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        query.date.$lte = new Date(new Date(filters.endDate).setHours(23, 59, 59, 999));
      }
    }

    return await InventoryTransaction.find(query)
      .populate("productId", "name barcode")
      .sort({ date: -1 })
      .limit(100);
  }
}
