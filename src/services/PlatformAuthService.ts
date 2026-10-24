import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import PlatformUser, { IPlatformUser } from "../models/PlatformUser";
import AdminAuditLog from "../models/AdminAuditLog";
import { normalizeLaoMobilePhone, normalizeUsername } from "../utils/userIdentity";

const findPlatformUserForLogin = async (identifier: string) => {
  const normalizedPhone = normalizeLaoMobilePhone(identifier);
  if (normalizedPhone) {
    return PlatformUser.findOne({ loginPhone: normalizedPhone });
  }

  const cleanUsername = normalizeUsername(identifier);
  return PlatformUser.findOne({ username: cleanUsername });
};

export class PlatformAuthService {
  static async login(identifier: string, password: string) {
    const user = await findPlatformUserForLogin(identifier);
    if (!user) throw new Error("Invalid credentials");

    if (user.status !== "ACTIVE") {
      throw new Error("Account is inactive. Please contact your administrator.");
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) throw new Error("Invalid credentials");

    user.lastLoginAt = new Date();
    await user.save();

    const token = jwt.sign(
      {
        userId: user._id,
        roles: user.roles,
        scope: "PLATFORM",
      },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "23h" }
    );

    await AdminAuditLog.create({
      actorId: user._id,
      actorUsername: user.username,
      action: "PLATFORM_LOGIN",
      targetType: "PlatformUser",
      targetId: user._id.toString(),
    });

    const userObj = user.toObject();
    delete (userObj as Partial<IPlatformUser>).passwordHash;

    return {
      token,
      user: {
        ...userObj,
        id: user._id.toString(),
        scope: "PLATFORM",
      },
    };
  }
}
