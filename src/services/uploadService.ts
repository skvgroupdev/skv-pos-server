import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from 'uuid';
import dotenv from "dotenv";

dotenv.config();

// Initialize S3 Client
const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-southeast-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "";

export const uploadToS3 = async (file: Express.Multer.File): Promise<string> => {
    if (!BUCKET_NAME) {
         throw new Error("AWS_BUCKET_NAME is not defined in environment variables");
    }

    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${uuidv4()}.${fileExtension}`;
    
    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
    });

    try {
        await s3Client.send(command);
        // Construct the URL.
        const url = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
        return url;
    } catch (error) {
        console.error("Error uploading to S3:", error);
        throw new Error("Failed to upload image to S3");
    }
};
