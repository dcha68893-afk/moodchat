/**
 * files.js — /api/files  
 * 
 * FORENSIC FINDING: This file was referenced in routes/index.js (line 103) as the
 * handler for /api/files, but the file DID NOT EXIST. Every media upload from the
 * frontend (FormData POST to /api/files/upload) returned 404. This broke:
 *   - Image messages in chat
 *   - Audio messages
 *   - Video messages
 *   - Document sharing
 *   - Status media uploads (photos/videos)
 *   - Group file sharing
 *
 * FIX: Implement the /api/files/upload endpoint that the frontend expects.
 */
'use strict';

const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const cloudinaryService = require('../services/cloudinaryService');

// FIX (UPLOAD-EPHEMERAL-DISK): this route used to always write to local disk.
// Render's filesystem is ephemeral — files vanish on every restart/redeploy
// and aren't shared across multiple instances — so every image/video sent
// through chat, group chat, or anywhere else that calls /api/files/upload
// would eventually 404. Cloudinary is already configured for avatars
// (see services/cloudinaryService.js); reuse it here for all file uploads
// whenever it's configured, and only fall back to local disk when it isn't.
const CLOUDINARY_ENABLED = cloudinaryService.isConfigured();

// ─── Upload directory (disk fallback only) ────────────────────────────────────
const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const DIRS = {
    image    : path.join(UPLOAD_ROOT, 'images'),
    audio    : path.join(UPLOAD_ROOT, 'audio'),
    video    : path.join(UPLOAD_ROOT, 'video'),
    document : path.join(UPLOAD_ROOT, 'documents'),
    default  : path.join(UPLOAD_ROOT, 'files'),
};
if (!CLOUDINARY_ENABLED) {
    Object.values(DIRS).forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch(_) {} });
} else {
    console.log('✅ /api/files/upload storage: Cloudinary (persistent CDN)');
}

// ─── MIME → type map ──────────────────────────────────────────────────────────
const MIME_TYPE_MAP = {
    'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image',
    'image/webp': 'image', 'image/heic': 'image', 'image/heif': 'image',
    'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/ogg': 'audio',
    'audio/wav': 'audio', 'audio/webm': 'audio', 'audio/aac': 'audio',
    'video/mp4': 'video', 'video/webm': 'video', 'video/ogg': 'video',
    'video/quicktime': 'video',
    'application/pdf': 'document',
    'application/msword': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
    'text/plain': 'document',
};

const ALLOWED_MIMES = new Set(Object.keys(MIME_TYPE_MAP));
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '52428800'); // 50MB default

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = CLOUDINARY_ENABLED
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
            const type = MIME_TYPE_MAP[file.mimetype] || 'default';
            cb(null, DIRS[type] || DIRS.default);
        },
        filename: (req, file, cb) => {
            const ext  = path.extname(file.originalname).toLowerCase() || '';
            const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
            cb(null, name);
        },
    });

const upload = multer({
    storage,
    limits: { fileSize: MAX_SIZE },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true);
        cb(new Error(`File type ${file.mimetype} not allowed`), false);
    },
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function absUrl(req, relPath) {
    const base = process.env.RENDER_EXTERNAL_URL ||
                 process.env.BACKEND_URL ||
                 `${req.protocol}://${req.get('host')}`;
    return `${base.replace(/\/+$/, '')}${relPath}`;
}

// ── POST /api/files/upload ────────────────────────────────────────────────────
// Called by: js/api.messages.js uploadFile(), js/services.message.js uploadFile()
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const type = MIME_TYPE_MAP[req.file.mimetype] || 'file';

        if (CLOUDINARY_ENABLED) {
            const folder = `moodchat/files/${type === 'file' ? 'other' : type}s`;
            const result = await cloudinaryService.uploadToCloudinary(req.file.buffer, { folder });
            if (!result) {
                return res.status(502).json({ success: false, message: 'Upload to Cloudinary failed' });
            }
            return res.status(201).json({
                success: true,
                message: 'File uploaded successfully',
                data: {
                    url: result.url,
                    publicId: result.publicId,
                    originalName: req.file.originalname,
                    mimeType: req.file.mimetype,
                    size: req.file.size,
                    type,
                },
                url: result.url,
                fileUrl: result.url,
                mediaUrl: result.url,
                type,
            });
        }

        const subDir    = DIRS[type] === DIRS.image  ? 'images'
                        : DIRS[type] === DIRS.audio  ? 'audio'
                        : DIRS[type] === DIRS.video  ? 'video'
                        : DIRS[type] === DIRS.document ? 'documents' : 'files';
        const relPath   = `/uploads/${subDir}/${req.file.filename}`;
        const url       = absUrl(req, relPath);

        return res.status(201).json({
            success   : true,
            message   : 'File uploaded successfully',
            data      : {
                url,
                relativePath : relPath,
                filename     : req.file.filename,
                originalName : req.file.originalname,
                mimeType     : req.file.mimetype,
                size         : req.file.size,
                type,        // 'image' | 'audio' | 'video' | 'document' | 'file'
            },
            // Legacy compat fields some callers expect at the top level
            url,
            fileUrl   : url,
            mediaUrl  : url,
            type,
        });
    } catch (e) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(500).json({ success: false, message: e.message || 'Upload failed' });
    }
});

// ── POST /api/files/upload-multiple ──────────────────────────────────────────
router.post('/upload-multiple', upload.array('files', 10), (req, res) => {
    try {
        if (!req.files?.length) {
            return res.status(400).json({ success: false, message: 'No files uploaded' });
        }
        const files = req.files.map(f => {
            const type    = MIME_TYPE_MAP[f.mimetype] || 'file';
            const subDir  = type === 'image' ? 'images' : type === 'audio' ? 'audio'
                          : type === 'video' ? 'video'  : type === 'document' ? 'documents' : 'files';
            const relPath = `/uploads/${subDir}/${f.filename}`;
            const url     = absUrl(req, relPath);
            return { url, relativePath: relPath, filename: f.filename,
                     originalName: f.originalname, mimeType: f.mimetype, size: f.size, type };
        });
        return res.status(201).json({ success: true, message: 'Files uploaded', data: { files }, files });
    } catch (e) {
        (req.files || []).forEach(f => { if (f.path) fs.unlink(f.path, () => {}); });
        return res.status(500).json({ success: false, message: e.message || 'Upload failed' });
    }
});

// ── GET /api/files/:filename — serve a previously uploaded file ───────────────
router.get('/:filename', (req, res) => {
    const filename = path.basename(req.params.filename); // strip traversal
    // Search all upload subdirectories
    const searchDirs = Object.values(DIRS);
    for (const dir of searchDirs) {
        const fullPath = path.join(dir, filename);
        if (fs.existsSync(fullPath)) {
            return res.sendFile(fullPath);
        }
    }
    return res.status(404).json({ success: false, message: 'File not found' });
});

module.exports = router;