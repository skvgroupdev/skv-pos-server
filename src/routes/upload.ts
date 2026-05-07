import express from "express";
import multer from "multer";
import { uploadToS3 } from "../services/uploadService";
import { authMiddleware } from "../middleware/authMiddleware";

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

export default router;
