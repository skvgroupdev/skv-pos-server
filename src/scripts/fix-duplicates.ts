
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import Product from "../models/Product";
import Tenant from "../models/Tenant"; // Import other models if needed for context

// Load env vars
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/skv-pos";

async function fixDuplicates() {
    try {
        console.log("Connecting to MongoDB...", MONGO_URI);
        await mongoose.connect(MONGO_URI);
        console.log("Connected.");

        // Aggregation to find duplicates
        const duplicates = await Product.aggregate([
            {
                $group: {
                    _id: { tenantId: "$tenantId", barcode: "$barcode" },
                    count: { $sum: 1 },
                    docs: { $push: "$_id" }
                }
            },
            {
                $match: {
                    count: { $gt: 1 },
                    "_id.barcode": { $ne: null } // Ignore null barcodes if any
                }
            }
        ]);

        console.log(`Found ${duplicates.length} sets of duplicates.`);

        for (const dup of duplicates) {
            const { tenantId, barcode } = dup._id;
            const docIds = dup.docs;
            
            // Keep the last one created (highest ObjectId usually, or we can sort)
            // Actually, let's just keep the last one in the array (assuming insertion order, but better to query)
            
            // Re-fetch to be safe about sorting
            const products = await Product.find({ _id: { $in: docIds } }).sort({ createdAt: -1 });
            
            if (products.length < 2) continue;

            const [toKeep, ...toRemove] = products;
            
            console.log(`Processing duplicate for barcode: ${barcode}`);
            console.log(`  Keeping: ${toKeep._id} (${toKeep.name})`);
            
            for (const remove of toRemove) {
                console.log(`  Removing: ${remove._id} (${remove.name})`);
                await Product.findByIdAndDelete(remove._id);
            }
        }

        console.log("Duplicates removed. Attempting to ensure unique index...");
        
        // Force index creation
        await Product.syncIndexes();
        console.log("Indexes synced.");

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await mongoose.disconnect();
        console.log("Disconnected.");
    }
}

fixDuplicates();
