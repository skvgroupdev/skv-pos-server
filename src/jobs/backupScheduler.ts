import cron from "node-cron";
import { runMongoBackupToS3 } from "../services/s3BackupService";

const BACKUP_CRON_EXPRESSION = "0 0 * * *";

let isBackupRunning = false;

const isBackupEnabled = () => {
    const value = (process.env.BACKUP_ENABLED || "true").toLowerCase();
    return !["false", "0", "no", "off"].includes(value);
};

const hasBackupConfig = () => {
    if (!process.env.AWS_ACCESS_KEY_ID) {
        console.error("S3 backup scheduler disabled: AWS_ACCESS_KEY_ID is not defined");
        return false;
    }

    if (!process.env.AWS_SECRET_ACCESS_KEY) {
        console.error("S3 backup scheduler disabled: AWS_SECRET_ACCESS_KEY is not defined");
        return false;
    }

    return true;
};

const runScheduledBackup = async () => {
    if (isBackupRunning) {
        console.warn("S3 backup skipped because a previous backup is still running");
        return;
    }

    isBackupRunning = true;

    try {
        const result = await runMongoBackupToS3();
        console.log(
            `S3 backup completed for ${result.backupDate}; s3://${result.bucketName}/${result.backupPrefix}; ${result.uploadedFiles.length} file(s) uploaded`
        );

        result.uploadedFiles.forEach((file) => {
            console.log(
                `S3 backup uploaded ${file.collectionName} (${file.recordCount} records) to s3://${result.bucketName}/${file.key}`
            );
        });

        if (result.deletedObjectKeys.length > 0) {
            console.log(`S3 backup deleted ${result.deletedObjectKeys.length} old object(s)`);
        }
    } catch (error) {
        console.error("S3 backup failed:", error);
    } finally {
        isBackupRunning = false;
    }
};

export const startDatabaseBackupScheduler = () => {
    if (!isBackupEnabled()) {
        console.log("S3 backup scheduler is disabled by BACKUP_ENABLED");
        return;
    }

    if (!hasBackupConfig()) return;

    const timeZone = process.env.BACKUP_TIMEZONE || "Asia/Vientiane";

    cron.schedule(BACKUP_CRON_EXPRESSION, runScheduledBackup, {
        timezone: timeZone,
        noOverlap: true,
        name: "s3-mongodb-backup",
    });

    console.log(`S3 backup scheduler started: ${BACKUP_CRON_EXPRESSION} (${timeZone})`);
};
