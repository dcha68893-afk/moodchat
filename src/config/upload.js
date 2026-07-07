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

  // FIX-XSS-EXT-SMUGGLING: express.static serves files with a Content-Type
  // derived from the file's EXTENSION, not from whatever mimetype was claimed
  // at upload time. The filename() function below used to take the extension
  // straight from file.originalname with no validation at all — so a client
  // could claim an allowed mimetype (e.g. 'text/plain', which passes
  // fileFilter) while naming the upload 'anything.html', and the file would
  // later be served back with Content-Type: text/html — a stored-XSS
  // vector, since any embedded <script> in the uploaded content then executes
  // in this app's origin for anyone who opens that URL. Fixed by mapping each
  // allowed mimetype to one single, fixed safe extension and always using
  // that — the client-supplied extension is never trusted or used.
  MIME_TO_SAFE_EXT: {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
    'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'application/zip': 'zip',
  },

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
      // FIX-XSS-EXT-SMUGGLING: use the fixed, safe extension for this
      // mimetype — never the client-supplied file.originalname extension.
      // See MIME_TO_SAFE_EXT above for why. Falls back to '.bin' for a
      // mimetype that somehow passed fileFilter without a mapping (shouldn't
      // happen given the allowlists are kept in sync, but never trust the
      // client's own filename as the fallback).
      const ext = module.exports.MIME_TO_SAFE_EXT[file.mimetype] || 'bin';
      cb(null, file.fieldname + '-' + uniqueSuffix + '.' + ext);
    },
  },
};
