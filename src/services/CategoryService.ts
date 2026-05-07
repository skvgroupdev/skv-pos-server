import Category, { ICategory } from "../models/Category";

export class CategoryService {
  static async getCategories(
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

    const [categories, total] = await Promise.all([
      Category.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit),
      Category.countDocuments(query),
    ]);

    return {
      data: categories,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async touchCategory(tenantId: string, name: string) {
    // Update the timestamp of the category with this name
    return await Category.findOneAndUpdate(
      { tenantId, name },
      { $set: { updatedAt: new Date() } },
      { new: true }
    );
  }

  static async createCategory(tenantId: string, data: Partial<ICategory>) {
    const category = new Category({ ...data, tenantId });
    return await category.save();
  }

  static async updateCategory(
    tenantId: string,
    id: string,
    data: Partial<ICategory>
  ) {
    const category = await Category.findOneAndUpdate(
      { _id: id, tenantId },
      data,
      { new: true }
    );
    if (!category) throw new Error("Category not found");
    return category;
  }

  static async deleteCategory(tenantId: string, id: string) {
    const category = await Category.findOneAndDelete({ _id: id, tenantId });
    if (!category) throw new Error("Category not found");
    return category;
  }
}
