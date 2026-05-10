import express from "express";
import multer from "multer";
import { uploadProductImageSetToS3, uploadToS3 } from "../services/uploadService";
import { authMiddleware, AuthRequest } from "../middleware/authMiddleware";
import Tenant from "../models/Tenant";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/upload
router.post("/", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const file = (req as any).file;
        if (!file) {
            return res.status(400).json({ message: "No file uploaded" });
        }

        const imageUrl = await uploadToS3(file);
        res.status(200).json({ url: imageUrl });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ message: "Upload failed" });
    }
});

// POST /api/upload/products
router.post("/products", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const authReq = req as AuthRequest;
        const file = req.file;
        if (!file) {
            return res.status(400).json({ message: "No file uploaded" });
        }
        if (!file.mimetype.startsWith("image/")) {
            return res.status(400).json({ message: "Only image files are allowed" });
        }

        const tenant = await Tenant.findById(authReq.user!.tenantId);
        if (!tenant) {
            return res.status(404).json({ message: "Tenant not found" });
        }

        const tenantName = tenant.shopName || tenant.name;
        const imageUrls = await uploadProductImageSetToS3(file, {
            folder: "pos/products",
            namePrefix: tenantName,
        });

        res.status(200).json({
            url: imageUrls.original,
            images: imageUrls,
        });
    } catch (error) {
        console.error("Product upload error:", error);
        res.status(500).json({ message: "Product upload failed" });
    }
});

export default router;
