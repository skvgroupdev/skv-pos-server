import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User";
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/skv-pos";

const generateUserId = () => {
  return uuidv4().replace(/-/g, '').substring(0, 5).toUpperCase();
};

const updateUsers = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    const users = await User.find({ userid: { $exists: false } });
    console.log(`Found ${users.length} users to update`);

    for (const user of users) {
      let uniqueId = generateUserId();
      // Simple collision check loop (optional but good for safety)
      let exists = await User.findOne({ userid: uniqueId });
      while(exists) {
         uniqueId = generateUserId();
         exists = await User.findOne({ userid: uniqueId });
      }

      user.userid = uniqueId;
      await User.updateOne({ _id: user._id }, { $set: { userid: uniqueId } });
      console.log(`Updated user ${user.username} with userid: ${uniqueId}`);
    }

    console.log("Migration completed");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
};

updateUsers();
