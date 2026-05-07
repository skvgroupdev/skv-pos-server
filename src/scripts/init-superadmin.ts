import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import User from "../models/User";
import Tenant from "../models/Tenant";

dotenv.config();

const initSuperAdmin = async () => {
    try {
        if (!process.env.MONGO_URI) {
            throw new Error("MONGO_URI is not defined");
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        // 1. Ensure System Tenant exists
        let systemTenant = await Tenant.findOne({ name: "SYSTEM" });
        if (!systemTenant) {
            systemTenant = await Tenant.create({
                name: "SYSTEM",
                shopName: "SKV POS System",
                status: "ACTIVE",
                subscriptionPlan: "ENTERPRISE",
                expireAt: new Date("2099-12-31")
            });
            console.log("System Tenant created");
        }

        // 2. Create Super Admin
        const username = "admin";
        const password = "adminpassword"; // Change this in production
        const passwordHash = await bcrypt.hash(password, 10);

        const existingAdmin = await User.findOne({ username, roles: "SUPER_ADMIN" });
        if (existingAdmin) {
            console.log("Super Admin already exists");
        } else {
            await User.create({
                tenantId: systemTenant._id,
                username,
                passwordHash,
                roles: ["SUPER_ADMIN"],
                status: "ACTIVE"
            });
            console.log("Super Admin created successfully");
            console.log("Username: admin");
            console.log("Password: adminpassword");
        }

    } catch (error) {
        console.error("Error initializing Super Admin:", error);
    } finally {
        await mongoose.disconnect();
    }
};

initSuperAdmin();
