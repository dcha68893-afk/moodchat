/** Direct media upload route. Uses Cloudinary when configured and the same persistent-in-code upload path as /api/files/upload when it is not. */
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cloudinaryService = require('../services/cloudinaryService');
const logger = require('../utils/logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800 },
});

function localUpload(req, file) {
  const mime = file.mimetype || '';
  const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
  const subdir = kind === 'image' ? 'images' : kind;
  const dir = path.join(process.cwd(), 'uploads', subdir);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.originalname || '').toLowerCase() || (mime.startsWith('video/') ? '.mp4' : mime.startsWith('audio/') ? '.bin' : '.jpg');
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  const base = (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  // ROOT-CAUSE FIX (status media 401s): this used to return
  // `${base}/api/files/${filename}` — that router is mounted with a
  // blanket authenticateToken (it's not in server.js's publicRoutes
  // whitelist), so a plain <video src="..."> / <img src="..."> tag hitting
  // it always 401s (browsers never attach the app's Bearer token to a
  // media-element resource fetch). The file above is written straight into
  // uploads/<subdir>, which app.js already serves with NO auth via
  // express.static('/uploads', ...) — so point callers at that already-public
  // path instead of the protected API route serving the same bytes.
  return { url: `${base}/uploads/${subdir}/${encodeURIComponent(filename)}`, publicId: null, width: null, height: null, format: ext.slice(1), bytes: file.size };
}

router.post('/direct-upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const isVideo = (req.file.mimetype || '').startsWith('video/');
    const trimStart = Math.max(0, Number(req.body?.trimStart || 0) || 0);
    const trimEndRaw = Number(req.body?.trimEnd);
    const sourceDuration = Number(req.body?.sourceDuration || 0) || 0;
    if (isVideo && trimEndRaw > trimStart && trimEndRaw - trimStart > 20) return res.status(400).json({ success: false, error: 'Status videos cannot exceed 20 seconds.' });
    if (isVideo && !cloudinaryService.isConfigured() && sourceDuration > 20) return res.status(400).json({ success: false, error: 'Video trimming requires Cloudinary when the original video is longer than 20 seconds.' });

    const result = cloudinaryService.isConfigured()
      ? await cloudinaryService.uploadToCloudinary(req.file.buffer, { folder: isVideo ? 'necpa/status/videos' : (req.file.mimetype || '').startsWith('audio/') ? 'necpa/status/audio' : 'necpa/status/images' })
      : localUpload(req, req.file);
    if (!result) return res.status(502).json({ success: false, error: 'Media upload failed' });
    let deliveryUrl = result.url;
    if (isVideo && cloudinaryService.isConfigured() && result.publicId && trimEndRaw > trimStart) deliveryUrl = cloudinaryService.videoTrimUrl(result.publicId, trimStart, Math.min(20, trimEndRaw - trimStart)) || result.url;

    return res.status(201).json({
      success: true,
      cloudinary: { url: deliveryUrl, public_id: result.publicId, width: result.width, height: result.height, format: result.format, bytes: result.bytes },
      url: deliveryUrl,
      publicId: result.publicId,
      storage: cloudinaryService.isConfigured() ? 'cloudinary' : 'local-fallback'
    });
  } catch (error) {
    logger.error('[cloudinary/direct-upload] error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

module.exports = router;
