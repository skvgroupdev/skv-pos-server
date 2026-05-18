import "../config/env";
import mongoose from "mongoose";
import { runMongoBackupToS3 } from "../services/s3BackupService";

const run = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI is not defined");
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    const result = await runMongoBackupToS3();
    console.log(
        `Backup ${result.backupDate} uploaded to s3://${result.bucketName}/${result.backupPrefix}`
    );

    result.uploadedFiles.forEach((file) => {
        console.log(
            `Uploaded ${file.fileName} (${file.recordCount} records) to s3://${result.bucketName}/${file.key}`
        );
    });

    if (result.deletedObjectKeys.length > 0) {
        console.log(`Deleted ${result.deletedObjectKeys.length} old backup object(s)`);
    }
};

run()
    .catch((error) => {
        console.error("Backup failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
