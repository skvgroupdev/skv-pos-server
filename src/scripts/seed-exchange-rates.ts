import mongoose from "mongoose";
import dotenv from "dotenv";
import ExchangeRate from "../models/ExchangeRate";
import Tenant from "../models/Tenant";

dotenv.config();

const seedExchangeRates = async () => {
    try {
        if (!process.env.MONGO_URI) {
            throw new Error("MONGO_URI is not defined");
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB");

        const tenants = await Tenant.find({ status: "ACTIVE" });
        if (tenants.length === 0) {
            console.log("No active tenants found. Please seed a shop first using init-shop.ts");
            return;
        }

        // Rates against LAK (Base Currency)
        // Note: LAK is not in the Enum for ExchangeRate model, so we only seed others.
        const initialRates = [
            { currency: 'USD', rate: 21500 },
            { currency: 'THB', rate: 615 },
            { currency: 'CNY', rate: 3000 },
            { currency: 'VND', rate: 0.85 } // Added VND as it's in the enum
        ];

        console.log(`Starting seeding for ${tenants.length} tenants...`);

        for (const tenant of tenants) {
            console.log(`- Seeding for tenant: ${tenant.shopName} (${tenant._id})`);

            for (const rateData of initialRates) {
                await ExchangeRate.findOneAndUpdate(
                    {
                        tenantId: tenant._id,
                        currency: rateData.currency
                    },
                    {
                        ...rateData,
                        isBase: false,
                        updatedAt: new Date()
                    },
                    {
                        upsert: true,
                        new: true,
                        runValidators: true
                    }
                );
            }
        }

        console.log("Exchange rates seeded successfully.");

    } catch (error) {
        console.error("Error seeding exchange rates:", error);
    } finally {
        await mongoose.disconnect();
    }
};

seedExchangeRates();
