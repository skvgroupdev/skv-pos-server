import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../src/models/Product";

dotenv.config();

const addProducts = async () => {
    if (!process.env.MONGO_URI) {
        console.error("MONGO_URI not found in .env");
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const tenantId = "6956029e749e169d22399ea0";
        const productsToAdd = [];

        console.log("Generating 700 products...");

        for (let i = 1; i <= 700; i++) {
            productsToAdd.push({
                tenantId: new mongoose.Types.ObjectId(tenantId),
                name: "ເຄື່ອງອາຫຼິວ",
                description: "",
                costPrice: 0,
                costCurrency: "LAK",
                sellPrice: 0,
                wholesalePrice: 0,
                stock: 0,
                minStock: 2,
                unit: "ເລືອກ",
                sku: "",
                barcode: `AL${i}`,
                supplier: "ອາຫຼິວ",
                brand: "",
                modelName: "",
                category: "ເລືອກ",
                images: [],
                status: "inactive",
                catalog: {
                    No: i.toString(),
                    code: "AL",
                    page: "",
                    number: ""
                },
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }

        console.log("Inserting products to database...");

        // Use insertMany for bulk operation
        const result = await Product.insertMany(productsToAdd);

        console.log(`✅ Successfully added ${result.length} products.`);
        console.log(`First product: ${result[0].barcode}`);
        console.log(`Last product: ${result[result.length - 1].barcode}`);

        process.exit(0);
    } catch (error) {
        console.error("Error adding products:", error);
        process.exit(1);
    }
};

addProducts();
