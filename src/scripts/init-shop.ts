import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import User from "../models/User";
import Tenant from "../models/Tenant";

dotenv.config();

const initShop = async () => {
    const args = process.argv.slice(2);
    const shopName = args[0] || "My Shop";
    const username = args[1] || "shopowner";
    const password = args[2] || "shoppassword";

    try {
        if (!process.env.MONGO_URI) {
            throw new Error("MONGO_URI is not defined");
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        // 1. Create Tenant
        const tenant = await Tenant.create({
            name: shopName.toUpperCase().replace(/\s+/g, '_'),
            shopName: shopName,
            status: "ACTIVE",
            subscriptionPlan: "BASIC",
            expireAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year from now
        });
        console.log(`Tenant '${shopName}' created`);

        // 2. Create Shop Admin
        const passwordHash = await bcrypt.hash(password, 10);

        await User.create({
            tenantId: tenant._id,
            username,
            passwordHash,
            roles: ["SHOP_ADMIN"],
            status: "ACTIVE"
        });

        console.log("Shop Owner created successfully");
        console.log(`Shop: ${shopName}`);
        console.log(`Username: ${username}`);
        console.log(`Password: ${password}`);

    } catch (error) {
        console.error("Error initializing Shop:", error);
    } finally {
        await mongoose.disconnect();
    }
};

initShop();
