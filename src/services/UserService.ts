import User, { IUser } from "../models/User";
import bcrypt from "bcrypt";

const EMPLOYEE_ROLES = ["SHOP_ADMIN", "CASHIER", "STOCK_KEEPER", "SALES"];

const normalizeUsername = (value: unknown) => String(value || "").trim().toLowerCase();

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

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
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

  static async createEmployee(tenantId: string, data: any) {
    const { username, password, roles, employeeCode, phone, address, userid } = data;
    const cleanUsername = normalizeUsername(username);
    const cleanPassword = normalizePassword(password);

    if (!cleanUsername) {
      throw new Error("Username is required");
    }

    validatePassword(cleanPassword);

    const existingUser = await User.findOne({ tenantId, username: cleanUsername });
    if (existingUser) {
      throw new Error("Username already exists");
    }

    const passwordHash = await bcrypt.hash(cleanPassword, 10);
    const user = new User({
      tenantId,
      username: cleanUsername,
      passwordHash,
      roles: normalizeRoles(roles),
      employeeCode,
      phone,
      address,
      userid
    });
    await user.save();

    const savedUser = user.toObject();
    delete (savedUser as Partial<IUser>).passwordHash;
    return savedUser;
  }

  static async updateEmployee(tenantId: string, id: string, data: any) {
    if (data.username) {
      data.username = normalizeUsername(data.username);
      if (!data.username) {
        throw new Error("Username is required");
      }
    }

    if (data.roles) {
      data.roles = normalizeRoles(data.roles);
    }

    if (data.password) {
      const cleanPassword = normalizePassword(data.password);
      validatePassword(cleanPassword);
      data.passwordHash = await bcrypt.hash(cleanPassword, 10);
      delete data.password;
    } else {
      delete data.password;
    }

    const user = await User.findOneAndUpdate({ _id: id, tenantId }, data, {
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
