import "../config/env";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import PlatformUser from "../models/PlatformUser";
import { normalizeLaoMobilePhone, normalizeUsername } from "../utils/userIdentity";

const {
  MONGO_URI,
  PLATFORM_ADMIN_USERNAME,
  PLATFORM_ADMIN_PHONE,
  PLATFORM_ADMIN_PASSWORD,
} = process.env;

async function main() {
  if (!MONGO_URI) throw new Error("MONGO_URI is required");
  if (!PLATFORM_ADMIN_USERNAME) throw new Error("PLATFORM_ADMIN_USERNAME is required");
  if (!PLATFORM_ADMIN_PASSWORD || PLATFORM_ADMIN_PASSWORD.length < 8) {
    throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 8 characters");
  }

  await mongoose.connect(MONGO_URI);

  const username = normalizeUsername(PLATFORM_ADMIN_USERNAME);
  const loginPhone = PLATFORM_ADMIN_PHONE
    ? normalizeLaoMobilePhone(PLATFORM_ADMIN_PHONE)
    : undefined;
  const passwordHash = await bcrypt.hash(PLATFORM_ADMIN_PASSWORD, 10);

  const user = await PlatformUser.findOneAndUpdate(
    { username },
    {
      $set: {
        username,
        loginPhone,
        passwordHash,
        roles: ["SUPER_ADMIN"],
        status: "ACTIVE",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`Platform super admin ready: ${user.username}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
