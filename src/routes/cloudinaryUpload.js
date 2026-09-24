/** Direct media upload route. Uses Cloudinary when configured and the same persistent-in-code upload path as /api/files/upload when it is not. */
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cloudinaryService = require('../services/cloudinaryService');
const logger = require('../utils/logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800 },
});


const MAX_STATUS_VIDEO_SECONDS = 20;

function runTool(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error(cmd + ' timed out')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(cmd + ' exited ' + code)); });
  });
}

// Local-disk fallback (Cloudinary not configured): cut the stored clip with ffmpeg when present.
// Returns the new file name, or null when ffmpeg is not available on this host.
async function trimLocalVideo(dir, filename, start, duration) {
  const input = path.join(dir, filename);
  const outName = filename.replace(/\.[^.]+$/, '') + '-trim.mp4';
  const output = path.join(dir, outName);
  try {
    await runTool('ffmpeg', ['-y', '-ss', String(start), '-i', input, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-movflags', '+faststart', output], 90000);
    fs.unlink(input, () => {});
    return outName;
  } catch (e) {
    fs.unlink(output, () => {});
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

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
    // A status/Vibe clip is never longer than 20 seconds. If the person chose a range, use it (capped);
    // if they did not, keep the FIRST 20 seconds. This used to reject or silently publish the full clip.
    const wanted = Number.isFinite(trimEndRaw) && trimEndRaw > trimStart ? trimEndRaw - trimStart : MAX_STATUS_VIDEO_SECONDS;
    const trimDuration = Math.min(MAX_STATUS_VIDEO_SECONDS, wanted);

    const result = cloudinaryService.isConfigured()
      ? await cloudinaryService.uploadToCloudinary(req.file.buffer, { folder: isVideo ? 'necpa/status/videos' : (req.file.mimetype || '').startsWith('audio/') ? 'necpa/status/audio' : 'necpa/status/images', timeoutMs: isVideo ? 120000 : 30000 })
      : localUpload(req, req.file);
    if (!result) return res.status(502).json({ success: false, error: 'Media upload failed' });
    let deliveryUrl = result.url;
    let trimmed = false;

    if (isVideo) {
      const knownDuration = Number(result.duration) || sourceDuration || 0;
      const needsTrim = trimStart > 0.05 || !knownDuration || knownDuration > trimDuration + 0.25;
      if (needsTrim && cloudinaryService.isConfigured() && result.publicId) {
        deliveryUrl = cloudinaryService.videoTrimUrl(result.publicId, trimStart, trimDuration) || result.url;
        trimmed = deliveryUrl !== result.url;
      } else if (needsTrim && !cloudinaryService.isConfigured()) {
        const dir = path.join(process.cwd(), 'uploads', 'video');
        const original = decodeURIComponent(path.basename(String(result.url).split('?')[0]));
        let outName = null;
        try { outName = await trimLocalVideo(dir, original, trimStart, trimDuration); }
        catch (e) { logger.error('[direct-upload] ffmpeg trim failed:', e); }
        if (outName) {
          deliveryUrl = String(result.url).replace(/[^/]+$/, encodeURIComponent(outName));
          trimmed = true;
        } else if (knownDuration > MAX_STATUS_VIDEO_SECONDS + 0.25 || !knownDuration) {
          fs.unlink(path.join(dir, original), () => {});
          return res.status(400).json({ success: false, error: 'This server cannot shorten videos. Please trim the clip to 20 seconds and try again.' });
        }
      }
    }

    return res.status(201).json({
      success: true,
      cloudinary: { url: deliveryUrl, public_id: result.publicId, width: result.width, height: result.height, format: result.format, bytes: result.bytes },
      url: deliveryUrl,
      publicId: result.publicId,
      trimmed,
      storage: cloudinaryService.isConfigured() ? 'cloudinary' : 'local-fallback'
    });
  } catch (error) {
    logger.error('[cloudinary/direct-upload] error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

module.exports = router;
