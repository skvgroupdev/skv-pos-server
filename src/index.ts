import "./config/env";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import productRoutes from "./routes/products";
import categoryRoutes from "./routes/categories";
import unitRoutes from "./routes/units";
import exchangeRateRoutes from "./routes/exchangeRates";
import uploadRoutes from "./routes/upload";
import orderRoutes from "./routes/orders";
import customerRoutes from "./routes/customers";
import cartRoutes from "./routes/cart";
import debtRoutes from "./routes/debt";
import reportsRoutes from "./routes/reports";
import tenantsRoutes from "./routes/tenants";
import quotationRoutes from "./routes/quotations";
import { startDatabaseBackupScheduler } from "./jobs/backupScheduler";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 5000;
const jsonLimit = process.env.API_JSON_LIMIT || "1mb";

// 2. Middlewares
app.use(express.json({ limit: jsonLimit }));
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(morgan("dev"));

// 3. Database Connection
if (!process.env.MONGO_URI) {
  console.error("Error: MONGO_URI is not defined in .env file");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB");
    startDatabaseBackupScheduler();
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// 4. Default Route
app.get("/", (req, res) => {
  res.send("Server is running");
});

const healthHandler = (req: express.Request, res: express.Response) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
};

app.get("/healthy", healthHandler);
app.get("/health", healthHandler);

// 5. Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/units", unitRoutes);
app.use("/api/exchange-rates", exchangeRateRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/debt", debtRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/tenants", tenantsRoutes);
app.use("/api/quotations", quotationRoutes);

// 6. Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
