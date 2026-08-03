import User, { IUser } from "../models/User";
import bcrypt from "bcrypt";
import {
  buildLoosePhoneRegex,
  normalizeLaoMobilePhone,
  normalizeUsername,
} from "../utils/userIdentity";

const EMPLOYEE_ROLES = ["SHOP_ADMIN", "CASHIER", "STOCK_KEEPER", "SALES"];

interface EmployeeInput {
  username?: unknown;
  password?: unknown;
  roles?: unknown;
  employeeCode?: unknown;
  phone?: unknown;
  address?: unknown;
  userid?: unknown;
}

const normalizePassword = (value: unknown) => String(value || "");

const normalizeRoles = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0) return ["CASHIER"];

  const roles = value.filter((role): role is string => EMPLOYEE_ROLES.includes(role));
  if (!roles.length || roles.length !== value.length) {
    throw new Error("Invalid employee role");
  }

  return roles;
};

const validatePassword = (password: string) => {
  if (!password.trim()) {
    throw new Error("Password is required");
  }

  if (password.length < 7) {
    throw new Error("Password must be at least 7 characters");
  }
};

const requireLoginPhone = (value: unknown) => {
  const loginPhone = normalizeLaoMobilePhone(value);
  if (!loginPhone) {
    throw new Error("Phone must use the format 20xxxxxxxx");
  }
  return loginPhone;
};

export class UserService {
  static async getEmployees(
    tenantId: string,
    page: number = 1,
    limit: number = 10
  ) {
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find({ tenantId, status: 'ACTIVE' })
        .select("-passwordHash")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments({ tenantId, status: 'ACTIVE' }),
    ]);

    return {
      data: users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async createEmployee(tenantId: string, data: EmployeeInput) {
    const { username, password, roles, employeeCode, phone, address, userid } = data;
    const cleanUsername = normalizeUsername(username);
    const cleanPassword = normalizePassword(password);
    const loginPhone = requireLoginPhone(phone);

    if (!cleanUsername) {
      throw new Error("Username is required");
    }

    validatePassword(cleanPassword);

    const [existingUser, existingPhone] = await Promise.all([
      User.findOne({ tenantId, username: cleanUsername }).select("_id"),
      User.findOne({
        $or: [
          { loginPhone },
          { phone: buildLoosePhoneRegex(loginPhone) },
        ],
      }).select("_id"),
    ]);
    if (existingUser) {
      throw new Error("Username already exists");
    }
    if (existingPhone) {
      throw new Error("Phone number already belongs to another account");
    }

    const passwordHash = await bcrypt.hash(cleanPassword, 10);
    const user = new User({
      tenantId,
      username: cleanUsername,
      passwordHash,
      roles: normalizeRoles(roles),
      employeeCode,
      phone: loginPhone,
      loginPhone,
      address,
      userid
    });
    await user.save();

    const savedUser = user.toObject();
    delete (savedUser as Partial<IUser>).passwordHash;
    return savedUser;
  }

  static async updateEmployee(tenantId: string, id: string, data: EmployeeInput) {
    const updates: Record<string, unknown> = {};

    if (data.username !== undefined) {
      const cleanUsername = normalizeUsername(data.username);
      if (!cleanUsername) {
        throw new Error("Username is required");
      }
      const existingUser = await User.findOne({
        tenantId,
        username: cleanUsername,
        _id: { $ne: id },
      }).select("_id");
      if (existingUser) {
        throw new Error("Username already exists");
      }
      updates.username = cleanUsername;
    }

    if (data.roles !== undefined) {
      updates.roles = normalizeRoles(data.roles);
    }

    if (data.password) {
      const cleanPassword = normalizePassword(data.password);
      validatePassword(cleanPassword);
      updates.passwordHash = await bcrypt.hash(cleanPassword, 10);
    }

    if (data.phone !== undefined) {
      const loginPhone = requireLoginPhone(data.phone);
      const existingPhone = await User.findOne({
        _id: { $ne: id },
        $or: [
          { loginPhone },
          { phone: buildLoosePhoneRegex(loginPhone) },
        ],
      }).select("_id");
      if (existingPhone) {
        throw new Error("Phone number already belongs to another account");
      }
      updates.phone = loginPhone;
      updates.loginPhone = loginPhone;
    }

    if (data.employeeCode !== undefined) {
      updates.employeeCode = String(data.employeeCode || "").trim();
    }
    if (data.address !== undefined) {
      updates.address = String(data.address || "").trim();
    }

    const user = await User.findOneAndUpdate({ _id: id, tenantId }, updates, {
      new: true,
    }).select("-passwordHash");
    if (!user) throw new Error("User not found");
    return user;
  }

  static async deleteEmployee(tenantId: string, id: string, requesterId: string) {
    if (id === requesterId) {
      throw new Error("You cannot delete your own account.");
    }

    const targetUser = await User.findOne({ _id: id, tenantId });
    if (!targetUser) throw new Error("User not found");

    if (targetUser.username === "shopowner") {
      throw new Error("The root Shopowner account cannot be deactivated.");
    }

    targetUser.status = 'INACTIVE';
    return await targetUser.save();
  }
}
