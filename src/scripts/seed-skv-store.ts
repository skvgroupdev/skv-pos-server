import mongoose from "mongoose";
import bcrypt from "bcrypt";
import "../config/env";
import Tenant from "../models/Tenant";
import User from "../models/User";

const TENANT_NAME = "SKV_STORE";
const SHOP_NAME = "SKV STORE";
const ADMIN_USERNAME = process.env.SKV_STORE_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.SKV_STORE_ADMIN_PASSWORD || "admin123";

const seedSkvStore = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not defined");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const expireAt = new Date();
  expireAt.setFullYear(expireAt.getFullYear() + 10);

  const tenant = await Tenant.findOneAndUpdate(
    { name: TENANT_NAME },
    {
      $set: {
        name: TENANT_NAME,
        shopName: SHOP_NAME,
        status: "ACTIVE",
        subscriptionPlan: "ENTERPRISE",
        expireAt,
      },
      $unset: {
        logo: "",
        bankQr: "",
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  await User.findOneAndUpdate(
    {
      tenantId: tenant._id,
      username: ADMIN_USERNAME,
    },
    {
      $set: {
        tenantId: tenant._id,
        username: ADMIN_USERNAME,
        passwordHash,
        roles: ["SHOP_ADMIN"],
        status: "ACTIVE",
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  console.log("SKV STORE dummy tenant is ready");
  console.log(`Tenant: ${tenant.shopName} (${tenant.name})`);
  console.log("Plan: ENTERPRISE");
  console.log(`Admin username: ${ADMIN_USERNAME}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
};

seedSkvStore()
  .catch((error) => {
    console.error("Failed to seed SKV STORE:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
