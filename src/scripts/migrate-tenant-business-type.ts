import "../config/env";
import mongoose from "mongoose";
import Tenant from "../models/Tenant";

const apply = process.argv.includes("--apply");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

  await mongoose.connect(process.env.MONGO_URI);

  const filter = {
    $or: [
      { businessType: { $exists: false } },
      { businessType: null },
      { businessType: "" },
    ],
  };

  const count = await Tenant.countDocuments(filter);
  console.log(`${apply ? "Applying" : "Dry-run"} tenant businessType migration`);
  console.log(`Tenants to update: ${count}`);

  if (!apply) {
    console.log("No changes written. Re-run with --apply to update tenants to GROCERY.");
    return;
  }

  const result = await Tenant.updateMany(filter, { $set: { businessType: "GROCERY" } });
  console.log(`Updated tenants: ${result.modifiedCount}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
