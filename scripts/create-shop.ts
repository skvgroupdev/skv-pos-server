import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import Tenant from "../src/models/Tenant";
import User from "../src/models/User";

dotenv.config();

const createShop = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not found in .env");
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Shop Details
    const shopName = "SKV Construction Materials";
    const shopAddress = "Vientiane, Laos";
    const shopPhone = "020-5555-5555";

    // Admin Details
    const username = "admin";
    const password = "password123";
    const name = "Super Admin";

    // 1. Create Tenant
    const newTenant = new Tenant({
      name: shopName,
      address: shopAddress,
      phone: shopPhone,
      status: 'active'
    });
    await newTenant.save();
    console.log(`✅ Tenant created: ${newTenant.name} (${newTenant._id})`);

    // 2. Create Admin User
    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = new User({
      tenantId: newTenant._id,
      username,
      passwordHash,
      name,
      roles: ["Admin", "SuperAdmin"]
    });
    await newUser.save();
    console.log(`✅ Admin user created: ${username}`);
    console.log(`👉 specific credentials: username=${username}, password=${password}`);

    process.exit(0);
  } catch (error) {
    console.error("Error creating shop:", error);
    process.exit(1);
  }
};

createShop();
