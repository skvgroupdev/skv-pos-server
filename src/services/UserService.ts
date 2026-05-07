import User, { IUser } from "../models/User";
import bcrypt from "bcrypt";

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
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({
      tenantId,
      username,
      passwordHash,
      roles: roles || ["Employee"],
      employeeCode,
      phone,
      address,
      userid
    });
    return await user.save();
  }

  static async updateEmployee(tenantId: string, id: string, data: any) {
    if (data.password) {
      data.passwordHash = await bcrypt.hash(data.password, 10);
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
