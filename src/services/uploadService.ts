import "../config/env";
import { DeleteObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from 'uuid';
import sharp from "sharp";

// Initialize S3 Client
const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || process.env.S3_BUCKET_NAME || "";

interface UploadToS3Options {
    folder?: string;
    namePrefix?: string;
}

export interface ImageSizeUrls {
    small: string;
    medium: string;
    original: string;
}

export interface ProductImageRefs {
    images?: string[];
    imageVariants?: ImageSizeUrls[];
}

const cleanNameForKey = (name: string) => {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u0E80-\u0EFF]+/gi, "-")
        .replace(/^-+|-+$/g, "") || "tenant";
};

const getPublicUrl = (fileKey: string) => {
    const baseUrl =
        process.env.S3_PUBLIC_BASE_URL ||
        `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    return `${baseUrl.replace(/\/$/, "")}/${encodeURI(fileKey)}`;
};

const getKeyFromUrl = (fileUrl: string) => {
    const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, "");

    if (publicBaseUrl && fileUrl.startsWith(publicBaseUrl)) {
        return decodeURIComponent(fileUrl.slice(publicBaseUrl.length + 1));
    }

    try {
        const parsedUrl = new URL(fileUrl);
        return decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));
    } catch {
        return fileUrl;
    }
};

const collectProductImageUrls = (product: ProductImageRefs) => {
    const urls = new Set<string>();

    product.images?.forEach((url) => {
        if (url) urls.add(url);
    });

    product.imageVariants?.forEach((variant) => {
        if (variant.small) urls.add(variant.small);
        if (variant.medium) urls.add(variant.medium);
        if (variant.original) urls.add(variant.original);
    });

    return urls;
};

const uploadBufferToS3 = async (
    buffer: Buffer,
    fileKey: string,
    contentType: string
) => {
    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileKey,
        Body: buffer,
        ContentType: contentType,
    });

    await s3Client.send(command);
    return getPublicUrl(fileKey);
};

export const uploadToS3 = async (
    file: Express.Multer.File,
    options: UploadToS3Options = {}
): Promise<string> => {
    if (!BUCKET_NAME) {
         throw new Error("AWS_BUCKET_NAME or S3_BUCKET_NAME is not defined in environment variables");
    }

    const fileExtension = file.originalname.split('.').pop();
    const safePrefix = options.namePrefix ? cleanNameForKey(options.namePrefix) : "";
    const fileName = `${safePrefix ? `${safePrefix}-` : ""}${uuidv4()}.${fileExtension}`;
    const fileKey = options.folder ? `${options.folder}/${fileName}` : fileName;

    try {
        return await uploadBufferToS3(file.buffer, fileKey, file.mimetype);
    } catch (error) {
        console.error("Error uploading to S3:", error);
        throw new Error("Failed to upload image to S3");
    }
};

export const uploadProductImageSetToS3 = async (
    file: Express.Multer.File,
    options: UploadToS3Options = {}
): Promise<ImageSizeUrls> => {
    if (!BUCKET_NAME) {
        throw new Error("AWS_BUCKET_NAME or S3_BUCKET_NAME is not defined in environment variables");
    }

    const smallWidth = Number(process.env.PRODUCT_IMAGE_SMALL_WIDTH || 320);
    const mediumWidth = Number(process.env.PRODUCT_IMAGE_MEDIUM_WIDTH || 800);
    const safePrefix = options.namePrefix ? cleanNameForKey(options.namePrefix) : "";
    const baseName = `${safePrefix ? `${safePrefix}-` : ""}${uuidv4()}`;
    const folder = options.folder || "pos/products";
    const contentType = "image/webp";

    try {
        const [smallBuffer, mediumBuffer, originalBuffer] = await Promise.all([
            sharp(file.buffer)
                .rotate()
                .resize({ width: smallWidth, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer(),
            sharp(file.buffer)
                .rotate()
                .resize({ width: mediumWidth, withoutEnlargement: true })
                .webp({ quality: 85 })
                .toBuffer(),
            sharp(file.buffer)
                .rotate()
                .webp({ quality: 92 })
                .toBuffer(),
        ]);

        const keys = {
            small: `${folder}/${baseName}-small.webp`,
            medium: `${folder}/${baseName}-medium.webp`,
            original: `${folder}/${baseName}-original.webp`,
        };

        const [small, medium, original] = await Promise.all([
            uploadBufferToS3(smallBuffer, keys.small, contentType),
            uploadBufferToS3(mediumBuffer, keys.medium, contentType),
            uploadBufferToS3(originalBuffer, keys.original, contentType),
        ]);

        return { small, medium, original };
    } catch (error) {
        console.error("Error uploading product image set to S3:", error);
        throw new Error("Failed to upload product image set to S3");
    }
};

export const deleteS3ObjectsByUrls = async (urls: Iterable<string>) => {
    if (!BUCKET_NAME) {
        throw new Error("AWS_BUCKET_NAME or S3_BUCKET_NAME is not defined in environment variables");
    }

    const keys = [...new Set([...urls].filter(Boolean).map(getKeyFromUrl))];

    await Promise.all(
        keys.map((key) => {
            return s3Client.send(
                new DeleteObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: key,
                })
            );
        })
    );
};

export const deleteProductImagesFromS3 = async (
    product: ProductImageRefs,
    urlsToKeep: Iterable<string> = []
) => {
    const keepUrls = new Set(urlsToKeep);
    const urlsToDelete = [...collectProductImageUrls(product)].filter((url) => {
        return !keepUrls.has(url);
    });

    if (urlsToDelete.length === 0) return;

    await deleteS3ObjectsByUrls(urlsToDelete);
};
