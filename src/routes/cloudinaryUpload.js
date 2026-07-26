/**
 * src/routes/cloudinaryUpload.js
 *
 * FIX (UPLOAD-CLOUDINARY-404): The frontend (js/status-api.js → uploadMedia())
 * posts every status image/video/audio to POST /api/cloudinary/direct-upload
 * expecting back { cloudinary: { url, public_id } }. That route never existed
 * anywhere in the backend, so every status media upload failed with a 404
 * before the status was even created. This file implements it using the
 * existing services/cloudinaryService.js (same Cloudinary account already
 * configured via CLOUDINARY_URL / CLOUDINARY_CLOUD_NAME+API_KEY+API_SECRET
 * for group/user avatars), so no new env vars are required.
 */
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinaryService = require('../services/cloudinaryService');
const logger = require('../utils/logger');

// Files are held in memory only long enough to stream to Cloudinary — never
// touch local disk, so this works the same on Render's ephemeral filesystem
// as anywhere else.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800 },
});

router.post('/direct-upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    if (!cloudinaryService.isConfigured()) {
      logger.error('[cloudinary/direct-upload] Cloudinary not configured — set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET');
      return res.status(503).json({
        success: false,
        error: 'Media storage is not configured on the server',
      });
    }

    const mimetype = req.file.mimetype || '';
    const folder = mimetype.startsWith('video/') ? 'nexopa/status/videos'
                 : mimetype.startsWith('audio/') ? 'nexopa/status/audio'
                 : 'nexopa/status/images';

    const result = await cloudinaryService.uploadToCloudinary(req.file.buffer, { folder });

    if (!result) {
      return res.status(502).json({ success: false, error: 'Upload to Cloudinary failed' });
    }

    return res.status(201).json({
      success: true,
      cloudinary: {
        url: result.url,
        public_id: result.publicId,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
      },
      // Legacy-compat top-level fields some callers expect
      url: result.url,
      publicId: result.publicId,
    });
  } catch (error) {
    logger.error('[cloudinary/direct-upload] error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

module.exports = router;
