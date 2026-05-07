import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../models/Product';
import path from 'path';
import fs from 'fs';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/skv-pos";
const TENANT_ID = "694a3d5a45df47cc7a8cf906";

interface JsonProduct {
    barcode: string;
    page: string | null;
    No: string | null;
    code: string;
    size: string | null;
    title: string;
    use_for: string | null;
    brand: string | null;
    unit: string;
    category: string;
    cost_thb: string;
    cost_lak: string;
    wholesale_thb: string;
    wholesale_lak: string;
    retail_thb: string;
    retail_lak: string;
    discount: string;
    num_of_discount: string;
    qty_start: string;
    qty_in: string;
    qty_out: string;
    qty_balance: string;
    qty_alert: string;
    supplier: string | null;
    img_name: string | null;
    status: string;
}

const importProducts = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB");

        const jsonPath = path.join(__dirname, 'products.json');
        const fileContent = fs.readFileSync(jsonPath, 'utf-8');
        const products: JsonProduct[] = JSON.parse(fileContent);

        console.log(`Found ${products.length} products to import...`);

        let successCount = 0;
        let errorCount = 0;

        for (const p of products) {
            try {
                // Parse numbers safely
                const costPrice = parseFloat(p.cost_lak) || 0;
                const sellPrice = parseFloat(p.retail_lak) || 0;
                const wholesalePrice = parseFloat(p.wholesale_lak) || 0;
                
                let barcode = p.barcode;
                if (barcode.length === 4) {
                    barcode = '1' + barcode;
                }

                // Construct product object
                const productData = {
                    tenantId: new mongoose.Types.ObjectId(TENANT_ID),
                    name: p.title,
                    description: p.use_for || '',
                    costPrice: costPrice,
                    costCurrency: 'LAK',
                    sellPrice: sellPrice,
                    wholesalePrice: wholesalePrice,
                    stock: 0, // Ignore quantity as requested
                    unit: p.unit || 'unit',
                    barcode: barcode,
                    category: p.category,
                    status: 'active',
                    catalog: {
                        No: p.No || '',
                        code: p.code || '',
                        page: p.page || ''
                    }
                };

                // Upsert based on barcode AND tenantId
                await Product.updateOne(
                    { barcode: barcode, tenantId: TENANT_ID },
                    { $set: productData },
                    { upsert: true }
                );

                successCount++;
                if (successCount % 100 === 0) {
                    console.log(`Processed ${successCount} products...`);
                }

            } catch (err) {
                console.error(`Error processing barcode ${p.barcode}:`, err);
                errorCount++;
            }
        }

        console.log(`Import completed.`);
        console.log(`Success: ${successCount}`);
        console.log(`Errors: ${errorCount}`);

        process.exit(0);
    } catch (error) {
        console.error("Critical error:", error);
        process.exit(1);
    }
};

importProducts();