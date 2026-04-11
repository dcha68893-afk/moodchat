const path = require('path');
const express = require('express');
const router = express.Router();
const { apiRateLimiter } = require('../middleware/rateLimiter');
const toolsController = require('../controllers/toolsController');

// All routes are protected by parent auth middleware in server.js
// authenticate middleware is applied at the parent router level

console.log('✅ Tools routes initialized');

// ─── File upload routes ──────────────────────────────────────────
router.post('/upload/image', apiRateLimiter, toolsController.uploadImage);
router.post('/upload/file', apiRateLimiter, toolsController.uploadFile);
router.delete('/upload/:fileId', apiRateLimiter, toolsController.deleteFile);

// ─── Image processing routes ─────────────────────────────────────
router.post('/image/resize', apiRateLimiter, toolsController.resizeImage);
router.post('/image/compress', apiRateLimiter, toolsController.compressImage);
router.post('/image/convert', apiRateLimiter, toolsController.convertImage);
router.post('/image/watermark', apiRateLimiter, toolsController.addWatermark);

// ─── PDF tools routes ────────────────────────────────────────────
router.post('/pdf/merge', apiRateLimiter, toolsController.mergePDFs);
router.post('/pdf/split', apiRateLimiter, toolsController.splitPDF);
router.post('/pdf/compress', apiRateLimiter, toolsController.compressPDF);
router.post('/pdf/convert', apiRateLimiter, toolsController.convertToPDF);

// ─── Text tools routes ───────────────────────────────────────────
router.post('/text/analyze', apiRateLimiter, toolsController.analyzeText);
router.post('/text/translate', apiRateLimiter, toolsController.translateText);
router.post('/text/summarize', apiRateLimiter, toolsController.summarizeText);
router.post('/text/sentiment', apiRateLimiter, toolsController.analyzeSentiment);

// ─── QR / Barcode ────────────────────────────────────────────────
router.post('/qrcode/generate', apiRateLimiter, toolsController.generateQRCode);
router.post('/qrcode/scan', apiRateLimiter, toolsController.scanQRCode);
router.post('/barcode/generate', apiRateLimiter, toolsController.generateBarcode);
router.post('/barcode/scan', apiRateLimiter, toolsController.scanBarcode);

// ─── Utility generators ──────────────────────────────────────────
router.get('/password/generate', apiRateLimiter, toolsController.generatePassword);
router.post('/password/strength', apiRateLimiter, toolsController.checkPasswordStrength);
router.post('/hash/generate', apiRateLimiter, toolsController.generateHash);
router.get('/uuid/generate', apiRateLimiter, toolsController.generateUUID);

// ─── Encoding ────────────────────────────────────────────────────
router.post('/base64/encode', apiRateLimiter, toolsController.encodeBase64);
router.post('/base64/decode', apiRateLimiter, toolsController.decodeBase64);

// ─── JSON / CSV ──────────────────────────────────────────────────
router.post('/json/format', apiRateLimiter, toolsController.formatJSON);
router.post('/json/validate', apiRateLimiter, toolsController.validateJSON);
router.post('/json/minify', apiRateLimiter, toolsController.minifyJSON);
router.post('/csv/convert', apiRateLimiter, toolsController.convertCSV);
router.post('/csv/validate', apiRateLimiter, toolsController.validateCSV);

// ─── Date / Time ─────────────────────────────────────────────────
router.get('/timestamp/current', apiRateLimiter, toolsController.getCurrentTimestamp);
router.post('/timestamp/convert', apiRateLimiter, toolsController.convertTimestamp);
router.post('/date/difference', apiRateLimiter, toolsController.calculateDateDifference);
router.post('/date/add', apiRateLimiter, toolsController.addToDate);

// ─── Converters ──────────────────────────────────────────────────
router.post('/color/convert', apiRateLimiter, toolsController.convertColor);
router.post('/unit/convert', apiRateLimiter, toolsController.convertUnit);
router.post('/currency/convert', apiRateLimiter, toolsController.convertCurrency);

// ─── URL shortener ───────────────────────────────────────────────
router.post('/url/shorten', apiRateLimiter, toolsController.shortenURL);
router.get('/url/:shortCode', apiRateLimiter, toolsController.redirectShortURL);

// ─── IP / User-agent ─────────────────────────────────────────────
router.get('/ip/info', apiRateLimiter, toolsController.getIPInfo);
router.get('/ip/location', apiRateLimiter, toolsController.getIPLocation);
router.get('/user-agent/parse', apiRateLimiter, toolsController.parseUserAgent);

// ─── File info / System ──────────────────────────────────────────
router.post('/file/info', apiRateLimiter, toolsController.getFileInfo);
router.get('/system/status', apiRateLimiter, toolsController.getSystemStatus);
router.get('/system/health', apiRateLimiter, toolsController.getHealthStatus);

// ─── Backup / Cleanup ────────────────────────────────────────────
router.post('/backup/create', apiRateLimiter, toolsController.createBackup);
router.get('/backup/list', apiRateLimiter, toolsController.listBackups);
router.post('/backup/restore', apiRateLimiter, toolsController.restoreBackup);
router.post('/cleanup/temp', apiRateLimiter, toolsController.cleanupTempFiles);
router.post('/cleanup/old', apiRateLimiter, toolsController.cleanupOldFiles);

// ─── Export / Import / Batch ─────────────────────────────────────
router.post('/export/data', apiRateLimiter, toolsController.exportData);
router.post('/import/data', apiRateLimiter, toolsController.importData);
router.post('/batch/process', apiRateLimiter, toolsController.processBatch);

// ─── Usage stats ─────────────────────────────────────────────────
router.get('/stats/usage', apiRateLimiter, toolsController.getUsageStats);

// ─── User subscription ───────────────────────────────────────────
// GET /api/tools/user/subscription  — used by Tool-core.js
router.get('/user/subscription', apiRateLimiter, toolsController.getUserSubscription);

// ═══════════════════════════════════════════════════════════════
// MARKETPLACE ROUTES
// These endpoints are called directly by Tool-core.js via authorizedFetch
// ═══════════════════════════════════════════════════════════════

// All Listings (with filters, pagination, search)
// GET /api/marketplace/listings?page=1&limit=20&category=&search=&sort=newest
router.get('/marketplace/listings', apiRateLimiter, toolsController.getListings);

// My Listings
router.get('/marketplace/listings/mine', apiRateLimiter, toolsController.getMyListings);

// Saved / Bookmarked Listings
router.get('/marketplace/listings/saved', apiRateLimiter, toolsController.getSavedListings);

// Premium Listings
router.get('/marketplace/listings/premium', apiRateLimiter, toolsController.getPremiumListings);

// Single Listing
router.get('/marketplace/listings/:listingId', apiRateLimiter, toolsController.getListing);

// Create Listing (Service, Digital, Premium, Physical)
router.post('/marketplace/listings', apiRateLimiter, toolsController.createListing);

// Bulk Create Listings
router.post('/marketplace/listings/bulk', apiRateLimiter, toolsController.bulkCreateListings);

// Update Listing
router.put('/marketplace/listings/:listingId', apiRateLimiter, toolsController.updateListing);

// Delete Listing
router.delete('/marketplace/listings/:listingId', apiRateLimiter, toolsController.deleteListing);

// Record a View
router.post('/marketplace/listings/:listingId/view', apiRateLimiter, toolsController.recordListingView);

// Toggle Save/Bookmark a Listing
router.post('/marketplace/listings/:listingId/save', apiRateLimiter, toolsController.toggleSaveListing);

// Purchase a Listing
router.post('/marketplace/listings/:listingId/purchase', apiRateLimiter, toolsController.purchaseListing);

// Rate a Listing
router.post('/marketplace/listings/:listingId/rate', apiRateLimiter, toolsController.rateListing);

// Spotlight / Featured — GET all spotlight items
router.get('/marketplace/spotlight', apiRateLimiter, toolsController.getSpotlightListings);

// Add a listing to spotlight
router.post('/marketplace/spotlight', apiRateLimiter, toolsController.addToSpotlight);

// Boost a listing
router.post('/marketplace/boost', apiRateLimiter, toolsController.boostListing);

// Seller Leaderboard — GET /api/marketplace/leaderboard
router.get('/marketplace/leaderboard', apiRateLimiter, toolsController.getLeaderboard);

// Send a tip to a seller
router.post('/marketplace/tips', apiRateLimiter, toolsController.sendTip);

// Marketplace analytics / stats
router.get('/marketplace/stats', apiRateLimiter, toolsController.getMarketplaceStats);

// Premium features list
router.get('/premium/features', apiRateLimiter, toolsController.getPremiumFeatures);

// Payments
router.post('/payments/process', apiRateLimiter, toolsController.processPayment);

module.exports = router;