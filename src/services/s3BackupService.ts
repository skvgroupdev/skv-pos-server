import {
    DeleteObjectsCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import mongoose from "mongoose";

const JSON_MIME_TYPE = "application/json";
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface BackupCollectionResult {
    collectionName: string;
    fileName: string;
    key: string;
    recordCount: number;
}

export interface MongoBackupResult {
    backupDate: string;
    bucketName: string;
    backupPrefix: string;
    uploadedFiles: BackupCollectionResult[];
    deletedObjectKeys: string[];
}

const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
});

const normalizePrefix = (prefix: string) => {
    return prefix.replace(/^\/+|\/+$/g, "");
};

export const getBackupDate = (
    date: Date = new Date(),
    timeZone = process.env.BACKUP_TIMEZONE || "Asia/Vientiane"
) => {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const values = Object.fromEntries(
        parts
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
};

const parseBackupDateUtc = (dateName: string) => {
    if (!DATE_FOLDER_PATTERN.test(dateName)) return null;

    const [year, month, day] = dateName.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
};

const getRetentionDays = () => {
    const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);

    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
        throw new Error("BACKUP_RETENTION_DAYS must be a non-negative number");
    }

    return Math.floor(retentionDays);
};

const getS3BackupConfig = () => {
    const bucketName = process.env.S3_BACKUP_BUCKET_NAME || "skvgroupbucket";
    const backupPrefix = normalizePrefix(process.env.S3_BACKUP_PREFIX || "backup/pos");

    if (!process.env.AWS_ACCESS_KEY_ID) {
        throw new Error("AWS_ACCESS_KEY_ID is not defined");
    }

    if (!process.env.AWS_SECRET_ACCESS_KEY) {
        throw new Error("AWS_SECRET_ACCESS_KEY is not defined");
    }

    if (!bucketName) {
        throw new Error("S3_BACKUP_BUCKET_NAME must not be empty");
    }

    if (!backupPrefix) {
        throw new Error("S3_BACKUP_PREFIX must not be empty");
    }

    return {
        bucketName,
        backupPrefix,
        retentionDays: getRetentionDays(),
    };
};

const getBackupKey = (backupPrefix: string, backupDate: string, collectionName: string) => {
    return `${backupPrefix}/${backupDate}/${collectionName}.json`;
};

const uploadCollectionJson = async (
    bucketName: string,
    key: string,
    json: string
) => {
    await s3Client.send(
        new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: json,
            ContentType: JSON_MIME_TYPE,
        })
    );
};

const listBackupObjectKeys = async (bucketName: string, backupPrefix: string) => {
    const objectKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
        const response = await s3Client.send(
            new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: `${backupPrefix}/`,
                ContinuationToken: continuationToken,
            })
        );

        for (const object of response.Contents || []) {
            if (object.Key) objectKeys.push(object.Key);
        }

        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objectKeys;
};

const getDateFromBackupKey = (backupPrefix: string, key: string) => {
    const relativeKey = key.slice(`${backupPrefix}/`.length);
    return relativeKey.split("/")[0];
};

const deleteObjectKeysInBatches = async (bucketName: string, objectKeys: string[]) => {
    const deletedObjectKeys: string[] = [];

    for (let start = 0; start < objectKeys.length; start += 1000) {
        const keysBatch = objectKeys.slice(start, start + 1000);
        if (keysBatch.length === 0) continue;

        await s3Client.send(
            new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: {
                    Objects: keysBatch.map((key) => ({ Key: key })),
                    Quiet: true,
                },
            })
        );

        deletedObjectKeys.push(...keysBatch);
    }

    return deletedObjectKeys;
};

const cleanupOldBackupObjects = async (
    bucketName: string,
    backupPrefix: string,
    currentBackupDate: string,
    retentionDays: number
) => {
    if (retentionDays === 0) return [];

    const currentDateUtc = parseBackupDateUtc(currentBackupDate);
    if (currentDateUtc === null) return [];

    const cutoffDateUtc = currentDateUtc - retentionDays * 24 * 60 * 60 * 1000;
    const objectKeys = await listBackupObjectKeys(bucketName, backupPrefix);
    const keysToDelete = objectKeys.filter((key) => {
        const backupDate = getDateFromBackupKey(backupPrefix, key);
        const backupDateUtc = parseBackupDateUtc(backupDate);

        return backupDateUtc !== null && backupDateUtc < cutoffDateUtc;
    });

    return deleteObjectKeysInBatches(bucketName, keysToDelete);
};

export const runMongoBackupToS3 = async (): Promise<MongoBackupResult> => {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
        throw new Error("MongoDB is not connected");
    }

    const { bucketName, backupPrefix, retentionDays } = getS3BackupConfig();
    const backupDate = getBackupDate();
    const collections = await mongoose.connection.db.collections();
    const uploadedFiles: BackupCollectionResult[] = [];

    for (const collection of collections) {
        const collectionName = collection.collectionName;
        if (collectionName.startsWith("system.")) continue;

        const documents = await collection.find({}).toArray();
        const json = JSON.stringify(documents, null, 2);
        const key = getBackupKey(backupPrefix, backupDate, collectionName);

        await uploadCollectionJson(bucketName, key, json);

        uploadedFiles.push({
            collectionName,
            fileName: `${collectionName}.json`,
            key,
            recordCount: documents.length,
        });
    }

    const deletedObjectKeys = await cleanupOldBackupObjects(
        bucketName,
        backupPrefix,
        backupDate,
        retentionDays
    );

    return {
        backupDate,
        bucketName,
        backupPrefix,
        uploadedFiles,
        deletedObjectKeys,
    };
};
