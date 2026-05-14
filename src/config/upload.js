const config = require('./index');

module.exports = {
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800,
  },

  // FIX-026: Hardened MIME type allowlist — prevents arbitrary file upload (shell scripts, binaries, etc.)
  // Extensions are NOT trusted — only the actual mimetype reported by multer is checked.
  ALLOWED_MIME_TYPES: new Set([
    // Images
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    // Video
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
    // Audio
    'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac',
    'audio/x-m4a', 'audio/mp4',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    // Archives (limited)
    'application/zip',
  ]),

  fileFilter: function(req, file, cb) {
    // Re-read the allowlist from the module itself so it stays DRY
    const allowed = module.exports.ALLOWED_MIME_TYPES;
    if (allowed.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error(`File type not allowed: ${file.mimetype}`);
      err.code = 'INVALID_FILE_TYPE';
      err.status = 415;
      cb(err, false);
    }
  },

  storage: {
    destination: function (req, file, cb) {
      let uploadPath = process.env.UPLOAD_DIR || './uploads';

      if (file.mimetype.startsWith('image/')) {
        uploadPath += 'images/';
      } else if (file.mimetype.startsWith('video/')) {
        uploadPath += 'videos/';
      } else if (file.mimetype.startsWith('audio/')) {
        uploadPath += 'audio/';
      } else {
        uploadPath += 'other/';
      }

      cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = file.originalname.split('.').pop();
      cb(null, file.fieldname + '-' + uniqueSuffix + '.' + ext);
    },
  },
};
