const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const toolsController = require('../controllers/toolsController');

// Apply authentication to all routes
router.use(authenticate);

// File upload routes
router.post('/upload/image', apiRateLimiter, toolsController.uploadImage);
router.post('/upload/file', apiRateLimiter, toolsController.uploadFile);
router.delete('/upload/:fileId', apiRateLimiter, toolsController.deleteFile);

// Image processing routes
router.post('/image/resize', apiRateLimiter, toolsController.resizeImage);
router.post('/image/compress', apiRateLimiter, toolsController.compressImage);
router.post('/image/convert', apiRateLimiter, toolsController.convertImage);
router.post('/image/watermark', apiRateLimiter, toolsController.addWatermark);

// PDF tools routes
router.post('/pdf/merge', apiRateLimiter, toolsController.mergePDFs);
router.post('/pdf/split', apiRateLimiter, toolsController.splitPDF);
router.post('/pdf/compress', apiRateLimiter, toolsController.compressPDF);
router.post('/pdf/convert', apiRateLimiter, toolsController.convertToPDF);

// Text tools routes
router.post('/text/analyze', apiRateLimiter, toolsController.analyzeText);
router.post('/text/translate', apiRateLimiter, toolsController.translateText);
router.post('/text/summarize', apiRateLimiter, toolsController.summarizeText);
router.post('/text/sentiment', apiRateLimiter, toolsController.analyzeSentiment);

// QR code routes
router.post('/qrcode/generate', apiRateLimiter, toolsController.generateQRCode);
router.post('/qrcode/scan', apiRateLimiter, toolsController.scanQRCode);

// Barcode routes
router.post('/barcode/generate', apiRateLimiter, toolsController.generateBarcode);
router.post('/barcode/scan', apiRateLimiter, toolsController.scanBarcode);

// Password generator
router.get('/password/generate', apiRateLimiter, toolsController.generatePassword);
router.post('/password/strength', apiRateLimiter, toolsController.checkPasswordStrength);

// Hash generator
router.post('/hash/generate', apiRateLimiter, toolsController.generateHash);

// UUID generator
router.get('/uuid/generate', apiRateLimiter, toolsController.generateUUID);

// Base64 encoder/decoder
router.post('/base64/encode', apiRateLimiter, toolsController.encodeBase64);
router.post('/base64/decode', apiRateLimiter, toolsController.decodeBase64);

// JSON formatter
router.post('/json/format', apiRateLimiter, toolsController.formatJSON);
router.post('/json/validate', apiRateLimiter, toolsController.validateJSON);
router.post('/json/minify', apiRateLimiter, toolsController.minifyJSON);

// CSV tools
router.post('/csv/convert', apiRateLimiter, toolsController.convertCSV);
router.post('/csv/validate', apiRateLimiter, toolsController.validateCSV);

// Date/time tools
router.get('/timestamp/current', apiRateLimiter, toolsController.getCurrentTimestamp);
router.post('/timestamp/convert', apiRateLimiter, toolsController.convertTimestamp);
router.post('/date/difference', apiRateLimiter, toolsController.calculateDateDifference);
router.post('/date/add', apiRateLimiter, toolsController.addToDate);

// Color converter
router.post('/color/convert', apiRateLimiter, toolsController.convertColor);

// Unit converter
router.post('/unit/convert', apiRateLimiter, toolsController.convertUnit);

// Currency converter
router.post('/currency/convert', apiRateLimiter, toolsController.convertCurrency);

// URL shortener
router.post('/url/shorten', apiRateLimiter, toolsController.shortenURL);
router.get('/url/:shortCode', apiRateLimiter, toolsController.redirectShortURL);

// IP tools
router.get('/ip/info', apiRateLimiter, toolsController.getIPInfo);
router.get('/ip/location', apiRateLimiter, toolsController.getIPLocation);

// User agent parser
router.get('/user-agent/parse', apiRateLimiter, toolsController.parseUserAgent);

// File info
router.post('/file/info', apiRateLimiter, toolsController.getFileInfo);

// System status
router.get('/system/status', apiRateLimiter, toolsController.getSystemStatus);
router.get('/system/health', apiRateLimiter, toolsController.getHealthStatus);

// Backup tools
router.post('/backup/create', apiRateLimiter, toolsController.createBackup);
router.get('/backup/list', apiRateLimiter, toolsController.listBackups);
router.post('/backup/restore', apiRateLimiter, toolsController.restoreBackup);

// Cleanup tools
router.post('/cleanup/temp', apiRateLimiter, toolsController.cleanupTempFiles);
router.post('/cleanup/old', apiRateLimiter, toolsController.cleanupOldFiles);

// Export tools
router.post('/export/data', apiRateLimiter, toolsController.exportData);

// Import tools
router.post('/import/data', apiRateLimiter, toolsController.importData);

// Batch processing
router.post('/batch/process', apiRateLimiter, toolsController.processBatch);

// Statistics
router.get('/stats/usage', apiRateLimiter, toolsController.getUsageStats);

module.exports = router;