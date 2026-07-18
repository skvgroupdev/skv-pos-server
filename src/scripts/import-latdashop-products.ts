import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import "../config/env";
import Category from "../models/Category";
import Product from "../models/Product";
import Unit from "../models/Unit";

const TENANT_ID = process.env.LATDASHOP_TENANT_ID || "6a5babdbfe3057de449415f9";
const JSON_PATH = process.env.LATDASHOP_JSON_PATH || path.resolve(__dirname, "../../../zyzgbpsz_latdashop (1).json");
const THB_TO_LAK_RATE = Number(process.env.LATDASHOP_THB_TO_LAK || 700);
const DEFAULT_UNIT = "ອັນ";
const DEFAULT_CATEGORY = "GENERAL";

type PhpMyAdminExportEntry = {
  type?: string;
  name?: string;
  data?: Record<string, unknown>[];
};

type ImportProductRow = {
  barcode?: unknown;
  page?: unknown;
  No?: unknown;
  code?: unknown;
  size?: unknown;
  title?: unknown;
  use_for?: unknown;
  brand?: unknown;
  unit?: unknown;
  category?: unknown;
  cost_thb?: unknown;
  cost_lak?: unknown;
  wholesale_thb?: unknown;
  wholesale_lak?: unknown;
  retail_thb?: unknown;
  retail_lak?: unknown;
  qty_balance?: unknown;
  qty_alert?: unknown;
  supplier?: unknown;
  img_name?: unknown;
  status?: unknown;
};

type NormalizedStatus = "active" | "inactive";

const text = (value: unknown) => String(value ?? "").trim();

const numberValue = (value: unknown) => {
  const parsed = Number(text(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const lakPrice = (thbValue: unknown, lakValue: unknown) => {
  const thb = numberValue(thbValue);
  if (thb > 0) return Math.round(thb * THB_TO_LAK_RATE);
  return Math.round(numberValue(lakValue));
};

const categoryName = (value: unknown) => {
  const name = text(value).replace(/\s+/g, " ").toUpperCase();
  return name || DEFAULT_CATEGORY;
};

const unitName = (value: unknown) => {
  const name = text(value).replace(/\s+/g, " ");
  return name || DEFAULT_UNIT;
};

const loadProducts = () => {
  const file = fs.readFileSync(JSON_PATH, "utf8");
  const exported = JSON.parse(file) as PhpMyAdminExportEntry[];
  const productsTable = exported.find((entry) => entry.type === "table" && entry.name === "products");
  if (!productsTable?.data?.length) {
    throw new Error(`No products table data found in ${JSON_PATH}`);
  }
  return productsTable.data as ImportProductRow[];
};

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not defined");
  }
  if (!mongoose.Types.ObjectId.isValid(TENANT_ID)) {
    throw new Error(`Invalid tenant id: ${TENANT_ID}`);
  }
  if (!Number.isFinite(THB_TO_LAK_RATE) || THB_TO_LAK_RATE <= 0) {
    throw new Error(`Invalid THB to LAK rate: ${THB_TO_LAK_RATE}`);
  }

  const tenantObjectId = new mongoose.Types.ObjectId(TENANT_ID);
  const rows = loadProducts();

  const normalizedRows = rows.map((row, index) => {
    const barcode = text(row.barcode);
    if (!barcode) {
      throw new Error(`Product row ${index + 1} has no barcode`);
    }

    return {
      tenantId: tenantObjectId,
      name: text(row.title) || barcode,
      description: text(row.use_for),
      costPrice: lakPrice(row.cost_thb, row.cost_lak),
      costCurrency: "LAK",
      sellPrice: lakPrice(row.retail_thb, row.retail_lak),
      wholesalePrice: lakPrice(row.wholesale_thb, row.wholesale_lak),
      stock: numberValue(row.qty_balance),
      reservedStock: 0,
      minStock: numberValue(row.qty_alert),
      unit: unitName(row.unit),
      sku: text(row.code),
      barcode,
      supplier: text(row.supplier),
      brand: text(row.brand),
      modelName: text(row.use_for),
      category: categoryName(row.category),
      images: text(row.img_name) ? [text(row.img_name)] : [],
      imageVariants: [],
      status: (text(row.status) === "inactive" ? "inactive" : "active") as NormalizedStatus,
      catalog: {
        No: text(row.No),
        code: text(row.code),
        page: text(row.page),
        number: text(row.size),
      },
    };
  });

  const categories = Array.from(new Set(normalizedRows.map((row) => row.category))).sort();
  const units = Array.from(new Set(normalizedRows.map((row) => row.unit))).sort();

  await mongoose.connect(process.env.MONGO_URI);

  const before = {
    products: await Product.countDocuments({ tenantId: tenantObjectId }),
    categories: await Category.countDocuments({ tenantId: tenantObjectId }),
    units: await Unit.countDocuments({ tenantId: tenantObjectId }),
  };

  await Category.bulkWrite(
    categories.map((name) => ({
      updateOne: {
        filter: { tenantId: tenantObjectId, name },
        update: { $setOnInsert: { tenantId: tenantObjectId, name } },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  await Unit.bulkWrite(
    units.map((name) => ({
      updateOne: {
        filter: { tenantId: tenantObjectId, name },
        update: { $setOnInsert: { tenantId: tenantObjectId, name, symbol: name } },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  const productResult = await Product.bulkWrite(
    normalizedRows.map((product) => ({
      updateOne: {
        filter: { tenantId: tenantObjectId, barcode: product.barcode },
        update: {
          $set: product,
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  const after = {
    products: await Product.countDocuments({ tenantId: tenantObjectId }),
    categories: await Category.countDocuments({ tenantId: tenantObjectId }),
    units: await Unit.countDocuments({ tenantId: tenantObjectId }),
  };

  console.log("Latdashop product seed completed");
  console.log(JSON.stringify({
    tenantId: TENANT_ID,
    jsonPath: JSON_PATH,
    thbToLakRate: THB_TO_LAK_RATE,
    sourceRows: rows.length,
    normalizedCategories: categories.length,
    normalizedUnits: units.length,
    productBulkWrite: {
      matched: productResult.matchedCount,
      modified: productResult.modifiedCount,
      upserted: productResult.upsertedCount,
    },
    before,
    after,
  }, null, 2));
};

main()
  .catch((error) => {
    console.error("Failed to seed Latdashop products:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
