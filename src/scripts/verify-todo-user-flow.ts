import "../config/env";
import axios, { type AxiosInstance } from "axios";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import Customer from "../models/Customer";
import Order from "../models/Order";
import Tenant from "../models/Tenant";
import User from "../models/User";

const apiBaseUrl = process.env.VERIFY_API_URL || "http://localhost:8000/api";

const expectStatus = async (request: Promise<unknown>, expectedStatus: number) => {
  try {
    await request;
    if (expectedStatus >= 400) throw new Error(`Expected HTTP ${expectedStatus}, request succeeded`);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === expectedStatus) return;
    throw error;
  }
};

const run = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required for verification cleanup");

  const suffix = Date.now().toString().slice(-8);
  const adminUsername = `todo_admin_${suffix}`;
  const adminPassword = "todoAdmin123";
  const username = `todo_verify_${suffix}`;
  const duplicateUsername = `${username}_phone_duplicate`;
  const shortPasswordUsername = `${username}_short_password`;
  const phone = `20${suffix}`;
  const password = "todoVerify123";
  const tenantId = new mongoose.Types.ObjectId();
  const adminUserId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  try {
    await Tenant.create({
      _id: tenantId,
      name: `TODO_VERIFY_${suffix}`,
      shopName: "Todo verification shop",
      status: "ACTIVE",
      subscriptionPlan: "ENTERPRISE",
      expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await User.create({
      _id: adminUserId,
      tenantId,
      username: adminUsername,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      roles: ["SHOP_ADMIN"],
      status: "ACTIVE",
    });
    await Customer.create({
      _id: customerId,
      tenantId,
      name: "Todo debt customer",
      phone: `30${suffix}`,
      totalDebt: 15000,
    });
    await Order.create({
      tenantId,
      items: [{
        product: new mongoose.Types.ObjectId(),
        quantity: 2,
        price: 10000,
        cost: 6000,
        name: "Todo purchased product",
      }],
      total: 18000,
      paymentMethod: "DEBT",
      paidAmount: 3000,
      change: 0,
      discount: 2000,
      customerId,
      status: "COMPLETED",
      orderId: Date.now().toString().slice(-10),
      paymentStatus: "PARTIAL",
      remainingAmount: 15000,
      payments: [{ currency: "LAK", amount: 3000, rate: 1, amountInLAK: 3000 }],
      cashierId: adminUserId,
      saleMode: "retail",
    });

    const adminLogin = await axios.post(`${apiBaseUrl}/auth/login`, {
      username: adminUsername,
      password: adminPassword,
    });
    const token = adminLogin.data.token as string;
    if (!token || !adminLogin.data.user?.roles?.includes("SHOP_ADMIN")) {
      throw new Error("Verification account is not a shop admin");
    }

    const api: AxiosInstance = axios.create({
      baseURL: apiBaseUrl,
      headers: { Authorization: `Bearer ${token}` },
    });

    const created = await api.post("/users", {
      username,
      password,
      roles: ["CASHIER"],
      phone: `0${phone}`,
      address: "temporary verification account",
    });
    if (created.status !== 201 || created.data.username !== username || created.data.phone !== phone) {
      throw new Error("Employee create response did not contain normalized identity fields");
    }
    if (created.data.passwordHash) throw new Error("Employee response exposed passwordHash");

    const cashierOrderId = `CV${suffix}`;
    await Order.create({
      tenantId,
      items: [{
        product: new mongoose.Types.ObjectId(),
        quantity: 1,
        price: 7000,
        cost: 3500,
        name: "Cashier scoped product",
      }],
      total: 7000,
      paymentMethod: "CASH",
      paidAmount: 7000,
      change: 0,
      discount: 0,
      status: "COMPLETED",
      orderId: cashierOrderId,
      paymentStatus: "PAID",
      remainingAmount: 0,
      payments: [{ currency: "LAK", amount: 7000, rate: 1, amountInLAK: 7000 }],
      cashierId: created.data._id,
      saleMode: "retail",
    });

    const phoneLogin = await axios.post(`${apiBaseUrl}/auth/login`, {
      username: `0${phone}`,
      password,
    });
    const usernameLogin = await axios.post(`${apiBaseUrl}/auth/login`, { username, password });
    if (phoneLogin.data.user?.username !== username || usernameLogin.data.user?.username !== username) {
      throw new Error("Phone or username login returned the wrong employee");
    }
    if (phoneLogin.data.user?.passwordHash || usernameLogin.data.user?.passwordHash) {
      throw new Error("Login response exposed passwordHash");
    }

    const cashierApi: AxiosInstance = axios.create({
      baseURL: apiBaseUrl,
      headers: { Authorization: `Bearer ${phoneLogin.data.token}` },
    });
    const cashierSummary = (await cashierApi.get("/reports/summary", {
      params: { cashierId: adminUserId.toString() },
    })).data;
    const sensitiveSummaryKeys = [
      "totalCost",
      "netProfit",
      "totalProfit",
      "actualReceivedFromOrders",
      "debtRepaymentIncome",
      "totalIncomeToday",
      "netCashFlow",
      "receivedBreakdown",
      "profitByCategory",
    ];
    if (
      cashierSummary.totalSales !== 7000 ||
      cashierSummary.receivedByMethod?.find((row: Record<string, unknown>) => row.method === "CASH")?.totalReceived !== 7000 ||
      cashierSummary.breakdownByMethod?.find((row: Record<string, unknown>) => row.method === "CASH")?.totalSales !== 7000 ||
      sensitiveSummaryKeys.some((key) => Object.prototype.hasOwnProperty.call(cashierSummary, key)) ||
      cashierSummary.breakdownBySaleMode?.some((row: Record<string, unknown>) =>
        Object.prototype.hasOwnProperty.call(row, "totalProfit") ||
        Object.prototype.hasOwnProperty.call(row, "totalCost"))
    ) {
      throw new Error("Cashier summary was not scoped or exposed sensitive fields");
    }

    const cashierActivities = (await cashierApi.get("/financial-transactions", {
      params: { page: 1, limit: 20, cashierId: adminUserId.toString() },
    })).data;
    const cashierActivity = cashierActivities.data?.[0];
    if (
      cashierActivities.total !== 1 ||
      cashierActivity?.order?.orderId !== cashierOrderId ||
      Object.prototype.hasOwnProperty.call(cashierActivity?.order?.items?.[0] || {}, "cost") ||
      Object.prototype.hasOwnProperty.call(cashierActivities.summary || {}, "moneyIn") ||
      Object.prototype.hasOwnProperty.call(cashierActivities.summary || {}, "netProfit")
    ) {
      throw new Error("Cashier bill activity was not safely scoped and redacted");
    }

    await expectStatus(api.post("/users", {
      username,
      password,
      roles: ["CASHIER"],
      phone: `209${suffix.slice(1)}`,
    }), 400);
    await expectStatus(api.post("/users", {
      username: duplicateUsername,
      password,
      roles: ["CASHIER"],
      phone,
    }), 400);
    await expectStatus(api.post("/users", {
      username: shortPasswordUsername,
      password: "123456",
      roles: ["CASHIER"],
      phone: `208${suffix.slice(1)}`,
    }), 400);

    const summary = (await api.get("/reports/summary")).data;
    const formulaMatches =
      summary.grossSales === 27000 &&
      summary.totalSales === 25000 &&
      summary.totalDiscount === 2000 &&
      summary.totalCost === 15500 &&
      summary.netProfit === 9500 &&
      summary.totalProfit === summary.netProfit;
    if (!formulaMatches) throw new Error("Report summary formula contract is inconsistent");

    const movement = (await api.get("/reports/stock-movement")).data;
    if (!Array.isArray(movement) || movement.length !== 1 || movement[0].unitsSold !== 3) {
      throw new Error("Stock movement response does not include the fixture sale");
    }

    const debtors = (await api.get("/debt/customers", { params: { page: 1, limit: 1 } })).data;
    let debtBillItemsChecked = false;
    const firstDebtor = debtors.data?.[0];
    if (firstDebtor) {
      const unpaidOrders = (await api.get("/orders", {
        params: { customerId: firstDebtor._id, paymentStatus: "UNPAID_ALL", page: 1, limit: 20 },
      })).data;
      debtBillItemsChecked = unpaidOrders.data?.length === 1 &&
        unpaidOrders.data[0].items?.[0]?.name === "Todo purchased product";
    }
    if (!debtBillItemsChecked) throw new Error("Unpaid order response is missing purchased items");

    console.log(JSON.stringify({
      adminLogin: "passed",
      employeeCreate: "passed",
      phoneLogin: "passed",
      usernameLogin: "passed",
      duplicateUsernameRejected: "passed",
      duplicatePhoneRejected: "passed",
      shortPasswordRejected: "passed",
      cashierSummaryScopedAndRedacted: "passed",
      cashierBillsScopedAndRedacted: "passed",
      reportFormulaContract: "passed",
      stockMovementResponse: "passed",
      debtBillItems: "passed",
      passwordHashHidden: "passed",
    }, null, 2));
  } finally {
    await Order.deleteMany({ tenantId });
    await Customer.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Tenant.deleteOne({ _id: tenantId });
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
