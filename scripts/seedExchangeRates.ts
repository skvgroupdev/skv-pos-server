
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ExchangeRate from '../src/models/ExchangeRate';
import Tenant from '../src/models/Tenant';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/SKVPOOS';

const seedExchangeRates = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        // Find the first tenant or a specific one
        const tenant = await Tenant.findOne();
        if (!tenant) {
            console.error('No tenant found. Please create a tenant first.');
            process.exit(1);
        }

        console.log(`Seeding rates for tenant: ${tenant.name} (${tenant._id})`);

        const rates = [
            { currency: 'THB', rate: 650, isBase: false },
            { currency: 'USD', rate: 22000, isBase: false },
            { currency: 'CNY', rate: 3000, isBase: false },
            { currency: 'LAK', rate: 1, isBase: true },
        ];

        for (const rateData of rates) {
            await ExchangeRate.findOneAndUpdate(
                { tenantId: tenant._id, currency: rateData.currency },
                {
                    rate: rateData.rate,
                    isBase: rateData.isBase
                },
                { upsert: true, new: true }
            );
            console.log(`Updated/Created rate for ${rateData.currency}: ${rateData.rate}`);
        }

        console.log('Exchange rates seeded successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding exchange rates:', error);
        process.exit(1);
    }
};

seedExchangeRates();
