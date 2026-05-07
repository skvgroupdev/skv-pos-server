import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/Order";

dotenv.config();

const createIndexes = async () => {
    try {
        if (!process.env.MONGO_URI) {
            throw new Error("MONGO_URI is not defined");
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        console.log("Creating indexes for Orders collection...");

        // Use native collection to avoid Mongoose overhead and access low-level indexing
        const orderCollection = mongoose.connection.collection("orders");

        // 1. Basic Filters
        await orderCollection.createIndex({ tenantId: 1 });
        await orderCollection.createIndex({ cashierId: 1 });
        await orderCollection.createIndex({ customerId: 1 });
        await orderCollection.createIndex({ createdAt: -1 });
        await orderCollection.createIndex({ status: 1 });
        await orderCollection.createIndex({ paymentStatus: 1 });
        await orderCollection.createIndex({ paymentMethod: 1 });

        // 2. Compound Indexes for common queries (Search + Filter)
        // Multi-tenancy isolation + Date Range sorting
        await orderCollection.createIndex({ tenantId: 1, createdAt: -1 });

        // Bill Manager common query: Cashier + Status + Date
        await orderCollection.createIndex({
            tenantId: 1,
            cashierId: 1,
            status: 1,
            createdAt: -1
        });

        // Search by orderId (unique) - should already be done by Mongoose but safe to ensure
        await orderCollection.createIndex({ orderId: 1 }, { unique: true });

        console.log("Indexes created successfully");

        // List existing indexes
        const indexes = await orderCollection.indexes();
        console.log("Current indexes on 'orders':", indexes.map(idx => idx.name));

    } catch (error) {
        console.error("Error creating indexes:", error);
    } finally {
        await mongoose.disconnect();
    }
};

createIndexes();
