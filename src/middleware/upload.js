const multer = require('multer');
const uploadConfig = require('../config/upload');
const logger = require('../utils/logger');

const storage = multer.diskStorage(uploadConfig.storage);

const upload = multer({
  storage: storage,
  limits: uploadConfig.limits,
  fileFilter: uploadConfig.fileFilter,
});

const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 10MB',
      });
    }

    logger.error('Multer error:', err);
    return res.status(400).json({
      success: false,
      message: 'File upload error',
    });
  }

  if (err) {
    logger.error('Upload error:', err);
    return res.status(400).json({
      success: false,
      message: err.message || 'File upload failed',
    });
  }

  next();
};

const uploadSingle = fieldName => [upload.single(fieldName), handleUploadError];

const uploadMultiple = (fieldName, maxCount = 10) => [
  upload.array(fieldName, maxCount),
  handleUploadError,
];

const uploadFields = fields => [upload.fields(fields), handleUploadError];

// Middleware to process uploaded files
const processUploadedFiles = (req, res, next) => {
  if (req.file) {
    req.file.url = `${req.protocol}://${req.get('host')}/${req.file.path.replace(/\\/g, '/')}`;
  }

  if (req.files) {
    if (Array.isArray(req.files)) {
      req.files.forEach(file => {
        file.url = `${req.protocol}://${req.get('host')}/${file.path.replace(/\\/g, '/')}`;
      });
    } else {
      Object.keys(req.files).forEach(key => {
        req.files[key].forEach(file => {
          file.url = `${req.protocol}://${req.get('host')}/${file.path.replace(/\\/g, '/')}`;
        });
      });
    }
  }

  next();
};

module.exports = {
  uploadSingle,
  uploadMultiple,
  uploadFields,
  processUploadedFiles,
  handleUploadError,
};
