import User, { IUser } from "../models/User";
import Tenant from "../models/Tenant";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import {
  buildLoosePhoneRegex,
  normalizeLaoMobilePhone,
  normalizeUsername,
} from "../utils/userIdentity";

const findUserForLogin = async (identifier: string) => {
  const normalizedPhone = normalizeLaoMobilePhone(identifier);
  if (normalizedPhone) {
    const users = await User.find({
      $or: [
        { loginPhone: normalizedPhone },
        { phone: buildLoosePhoneRegex(normalizedPhone) },
      ],
    }).limit(2);

    if (users.length > 1) {
      throw new Error("Phone number is linked to multiple accounts. Please contact the shop administrator.");
    }
    return users[0] || null;
  }

  const rawUsername = String(identifier || "").trim();
  const cleanUsername = normalizeUsername(rawUsername);
  const usernameCandidates = rawUsername !== cleanUsername
    ? [cleanUsername, rawUsername]
    : [cleanUsername];
  const users = await User.find({ username: { $in: usernameCandidates } }).limit(2);

  if (users.length > 1) {
    throw new Error("Username exists in multiple shops. Please log in with your phone number.");
  }
  return users[0] || null;
};

export class AuthService {
  static async login(identifier: string, password: string) {
    const user = await findUserForLogin(identifier);
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
    delete (userObj as Partial<IUser>).passwordHash;
    
    const response = { 
      token, 
      user: {
        ...userObj,
        id: user._id.toString(),
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
    const cleanUsername = normalizeUsername(username);

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
    
    return {
      token,
      user: {
        ...newUser.toObject(),
        id: newUser._id.toString(),
      },
    };
  }
}
