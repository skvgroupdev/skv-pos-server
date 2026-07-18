import User, { IUser } from "../models/User";
import Tenant from "../models/Tenant";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

export class AuthService {
  static async login(username: string, password: string) {
    const rawUsername = String(username || "").trim();
    const cleanUsername = rawUsername.toLowerCase();
    const user =
      (await User.findOne({ username: cleanUsername })) ||
      (rawUsername !== cleanUsername ? await User.findOne({ username: rawUsername }) : null);
    if (!user) throw new Error("Invalid credentials");

    if (user.status !== 'ACTIVE') {
      throw new Error("Account is inactive. Please contact your administrator.");
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) throw new Error("Invalid credentials");

    const token = jwt.sign(
      {
        userId: user._id,
        tenantId: user.tenantId,
        roles: user.roles,
      },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "23h" }
    );

    // Fetch tenant info to get subscriptionPlan
    const tenant = await Tenant.findById(user.tenantId);

    // Return user with subscriptionPlan
    const userObj = user.toObject();
    
    const response = { 
      token, 
      user: {
        ...userObj,
        subscriptionPlan: tenant?.subscriptionPlan || 'BASIC'
      } 
    };
    return response;
  }

  static async register(data: {
    tenantId: string;
    username: string;
    password: string;
    roles?: string[];
  }) {
    const { tenantId, username, password, roles } = data;
    const cleanUsername = String(username || "").trim().toLowerCase();

    if (!cleanUsername) {
      throw new Error("Username is required");
    }

    if (!password || password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }

    // Check if user exists in this tenant
    const existingUser = await User.findOne({ tenantId, username: cleanUsername });
    if (existingUser) {
      throw new Error("Username already exists in this tenant");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = new User({
      tenantId,
      username: cleanUsername,
      passwordHash,
      roles: roles || ["CASHIER"],
    });

    await newUser.save();

    const token = jwt.sign(
      {
        userId: newUser._id,
        tenantId: newUser.tenantId,
        roles: newUser.roles,
      },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "23h" }
    );

    // Fetch tenant info for consistency, though on register it might know the plan already or we default
    // ideally we should fetch it or return what we know. 
    // For now keeping it simple as per request mainly focusing on login.
    // The user might want register to also return it, but the request emphasized Login.
    
    return { token, user: newUser };
  }
}
