import Unit, { IUnit } from "../models/Unit";

export class UnitService {
  static async getUnits(
    tenantId: string,
    page: number = 1,
    limit: number = 20,
    search?: string
  ) {
    const skip = (page - 1) * limit;
    const query: any = { tenantId };

    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const [units, total] = await Promise.all([
      Unit.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit),
      Unit.countDocuments(query),
    ]);

    return {
      data: units,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async touchUnit(tenantId: string, name: string) {
    // Update the timestamp of the unit with this name
    return await Unit.findOneAndUpdate(
      { tenantId, name },
      { $set: { updatedAt: new Date() } },
      { new: true }
    );
  }

  static async createUnit(tenantId: string, data: Partial<IUnit>) {
    const unit = new Unit({ ...data, tenantId });
    return await unit.save();
  }

  static async updateUnit(tenantId: string, id: string, data: Partial<IUnit>) {
    const unit = await Unit.findOneAndUpdate({ _id: id, tenantId }, data, {
      new: true,
    });
    if (!unit) throw new Error("Unit not found");
    return unit;
  }

  static async deleteUnit(tenantId: string, id: string) {
    const unit = await Unit.findOneAndDelete({ _id: id, tenantId });
    if (!unit) throw new Error("Unit not found");
    return unit;
  }
}
