/**
 * routes/tools.js — FIXED: Dynamic Tool Registry + Action Dispatcher Routes
 * ──────────────────────────────────────────────────────────────────────────
 * FIX LOG:
 *  [1] Added GET  /api/tools                   → dynamic tool manifest
 *  [2] Added GET  /api/tools/registry          → ToolRegistryManager sync endpoint
 *  [3] Added POST /api/tools/action            → unified tool action dispatcher
 *  [4] Added POST /api/tools/:toolId/usage     → record individual tool usage
 *  [5] Ordering fixed — specific paths before :param wildcards to avoid ambiguity
 */

'use strict';

const express          = require('express');
const router           = express.Router();
const toolsController  = require('../controllers/toolsController');

let apiRateLimiter;
try {
    apiRateLimiter = require('../middleware/rateLimiter').apiRateLimiter;
} catch (_) {
    // Fallback: pass-through when rateLimiter is unavailable (e.g. tests)
    apiRateLimiter = (_req, _res, next) => next();
}



// ═════════════════════════════════════════════════════════════════════════════
// [FIX 1] TOOL MANIFEST — returns ALL tools the frontend should know about.
// Called by Tool-core.js on startup AND by ToolSyncEngine.discoverTools().
// Response shape: { tools: [...], total, categories, generatedAt }
// ═════════════════════════════════════════════════════════════════════════════
router.get('/',          apiRateLimiter, toolsController.getToolsList.bind(toolsController));

// ─── [FIX 2] TOOL REGISTRY ───────────────────────────────────────────────────
// GET /api/tools/registry
// Same as above but named per ToolSyncEngine / ToolRegistryManager expectations.
// Shape: { tools: [...] }  (signed tool definitions)
router.get('/registry',  apiRateLimiter, toolsController.getToolRegistry.bind(toolsController));

// ─── [FIX 3] UNIFIED TOOL ACTION DISPATCHER ──────────────────────────────────
// POST /api/tools/action
// Body: { toolId: string, action: string, params: {} }
// Replaces the old pattern of one route per tool operation.
// Supports both server-side AND client-driven tool execution.
router.post('/action',   apiRateLimiter, toolsController.executeToolAction.bind(toolsController));

// ─── [FIX 4] USAGE TELEMETRY ─────────────────────────────────────────────────
// POST /api/tools/:toolId/usage
// Body: { action: string }  — logs a tool invocation for the requesting user
router.post('/:toolId/usage', apiRateLimiter, toolsController.recordUsage.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═════════════════════════════════════════════════════════════════════════════
router.post('/upload/image',   apiRateLimiter, toolsController.uploadImage.bind(toolsController));
router.post('/upload/file',    apiRateLimiter, toolsController.uploadFile.bind(toolsController));
router.delete('/upload/:fileId', apiRateLimiter, toolsController.deleteFile.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// IMAGE PROCESSING
// ═════════════════════════════════════════════════════════════════════════════
router.post('/image/resize',    apiRateLimiter, toolsController.resizeImage.bind(toolsController));
router.post('/image/compress',  apiRateLimiter, toolsController.compressImage.bind(toolsController));
router.post('/image/convert',   apiRateLimiter, toolsController.convertImage.bind(toolsController));
router.post('/image/watermark', apiRateLimiter, toolsController.addWatermark.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// PDF TOOLS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/pdf/merge',    apiRateLimiter, toolsController.mergePDFs.bind(toolsController));
router.post('/pdf/split',    apiRateLimiter, toolsController.splitPDF.bind(toolsController));
router.post('/pdf/compress', apiRateLimiter, toolsController.compressPDF.bind(toolsController));
router.post('/pdf/convert',  apiRateLimiter, toolsController.convertToPDF.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// TEXT TOOLS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/text/analyze',   apiRateLimiter, toolsController.analyzeText.bind(toolsController));
router.post('/text/translate', apiRateLimiter, toolsController.translateText.bind(toolsController));
router.post('/text/summarize', apiRateLimiter, toolsController.summarizeText.bind(toolsController));
router.post('/text/sentiment', apiRateLimiter, toolsController.analyzeSentiment.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// QR / BARCODE
// ═════════════════════════════════════════════════════════════════════════════
router.post('/qrcode/generate', apiRateLimiter, toolsController.generateQRCode.bind(toolsController));
router.post('/qrcode/scan',     apiRateLimiter, toolsController.scanQRCode.bind(toolsController));
router.post('/barcode/generate',apiRateLimiter, toolsController.generateBarcode.bind(toolsController));
router.post('/barcode/scan',    apiRateLimiter, toolsController.scanBarcode.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// SECURITY GENERATORS
// ═════════════════════════════════════════════════════════════════════════════
router.get('/password/generate',  apiRateLimiter, toolsController.generatePassword.bind(toolsController));
router.post('/password/strength', apiRateLimiter, toolsController.checkPasswordStrength.bind(toolsController));
router.post('/hash/generate',     apiRateLimiter, toolsController.generateHash.bind(toolsController));
router.get('/uuid/generate',      apiRateLimiter, toolsController.generateUUID.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// ENCODING
// ═════════════════════════════════════════════════════════════════════════════
router.post('/base64/encode', apiRateLimiter, toolsController.encodeBase64.bind(toolsController));
router.post('/base64/decode', apiRateLimiter, toolsController.decodeBase64.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// JSON / CSV
// ═════════════════════════════════════════════════════════════════════════════
router.post('/json/format',   apiRateLimiter, toolsController.formatJSON.bind(toolsController));
router.post('/json/validate', apiRateLimiter, toolsController.validateJSON.bind(toolsController));
router.post('/json/minify',   apiRateLimiter, toolsController.minifyJSON.bind(toolsController));
router.post('/csv/convert',   apiRateLimiter, toolsController.convertCSV.bind(toolsController));
router.post('/csv/validate',  apiRateLimiter, toolsController.validateCSV.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// DATE / TIME
// ═════════════════════════════════════════════════════════════════════════════
router.get('/timestamp/current',   apiRateLimiter, toolsController.getCurrentTimestamp.bind(toolsController));
router.post('/timestamp/convert',  apiRateLimiter, toolsController.convertTimestamp.bind(toolsController));
router.post('/date/difference',    apiRateLimiter, toolsController.calculateDateDifference.bind(toolsController));
router.post('/date/add',           apiRateLimiter, toolsController.addToDate.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// CONVERTERS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/color/convert',    apiRateLimiter, toolsController.convertColor.bind(toolsController));
router.post('/unit/convert',     apiRateLimiter, toolsController.convertUnit.bind(toolsController));
router.post('/currency/convert', apiRateLimiter, toolsController.convertCurrency.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// URL SHORTENER
// ═════════════════════════════════════════════════════════════════════════════
router.post('/url/shorten',     apiRateLimiter, toolsController.shortenURL.bind(toolsController));
// [FIX 5] — :shortCode MUST come after all static /url/... paths to avoid capture
router.get('/url/:shortCode',   apiRateLimiter, toolsController.redirectShortURL.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// NETWORK / SYSTEM
// ═════════════════════════════════════════════════════════════════════════════
router.get('/ip/info',         apiRateLimiter, toolsController.getIPInfo.bind(toolsController));
router.get('/ip/location',     apiRateLimiter, toolsController.getIPLocation.bind(toolsController));
router.get('/user-agent/parse',apiRateLimiter, toolsController.parseUserAgent.bind(toolsController));
router.post('/file/info',      apiRateLimiter, toolsController.getFileInfo.bind(toolsController));
router.get('/system/status',   apiRateLimiter, toolsController.getSystemStatus.bind(toolsController));
router.get('/system/health',   apiRateLimiter, toolsController.getHealthStatus.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// BACKUP / CLEANUP
// ═════════════════════════════════════════════════════════════════════════════
router.post('/backup/create',  apiRateLimiter, toolsController.createBackup.bind(toolsController));
router.get('/backup/list',     apiRateLimiter, toolsController.listBackups.bind(toolsController));
router.post('/backup/restore', apiRateLimiter, toolsController.restoreBackup.bind(toolsController));
router.post('/cleanup/temp',   apiRateLimiter, toolsController.cleanupTempFiles.bind(toolsController));
router.post('/cleanup/old',    apiRateLimiter, toolsController.cleanupOldFiles.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT / IMPORT / BATCH
// ═════════════════════════════════════════════════════════════════════════════
router.post('/export/data',    apiRateLimiter, toolsController.exportData.bind(toolsController));
router.post('/import/data',    apiRateLimiter, toolsController.importData.bind(toolsController));
router.post('/batch/process',  apiRateLimiter, toolsController.processBatch.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// STATS / SUBSCRIPTION
// ═════════════════════════════════════════════════════════════════════════════
router.get('/stats/usage',       apiRateLimiter, toolsController.getUsageStats.bind(toolsController));
router.get('/user/subscription', apiRateLimiter, toolsController.getUserSubscription.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// MARKETPLACE
// NOTE: Specific paths must come before :listingId wildcard paths
// ═════════════════════════════════════════════════════════════════════════════
router.get('/marketplace/listings/mine',    apiRateLimiter, toolsController.getMyListings.bind(toolsController));
router.get('/marketplace/listings/saved',   apiRateLimiter, toolsController.getSavedListings.bind(toolsController));
router.get('/marketplace/listings/premium', apiRateLimiter, toolsController.getPremiumListings.bind(toolsController));
router.get('/marketplace/listings',         apiRateLimiter, toolsController.getListings.bind(toolsController));
router.get('/marketplace/listings/:listingId', apiRateLimiter, toolsController.getListing.bind(toolsController));

router.post('/marketplace/listings',         apiRateLimiter, toolsController.createListing.bind(toolsController));
router.post('/marketplace/listings/bulk',    apiRateLimiter, toolsController.bulkCreateListings.bind(toolsController));
router.put('/marketplace/listings/:listingId',    apiRateLimiter, toolsController.updateListing.bind(toolsController));
router.delete('/marketplace/listings/:listingId', apiRateLimiter, toolsController.deleteListing.bind(toolsController));

router.post('/marketplace/listings/:listingId/view',     apiRateLimiter, toolsController.recordListingView.bind(toolsController));
router.post('/marketplace/listings/:listingId/save',     apiRateLimiter, toolsController.toggleSaveListing.bind(toolsController));
router.post('/marketplace/listings/:listingId/purchase', apiRateLimiter, toolsController.purchaseListing.bind(toolsController));
router.post('/marketplace/listings/:listingId/rate',     apiRateLimiter, toolsController.rateListing.bind(toolsController));

router.get('/marketplace/spotlight',  apiRateLimiter, toolsController.getSpotlightListings.bind(toolsController));
router.post('/marketplace/spotlight', apiRateLimiter, toolsController.addToSpotlight.bind(toolsController));
router.post('/marketplace/boost',     apiRateLimiter, toolsController.boostListing.bind(toolsController));
router.get('/marketplace/leaderboard',apiRateLimiter, toolsController.getLeaderboard.bind(toolsController));
router.post('/marketplace/tips',      apiRateLimiter, toolsController.sendTip.bind(toolsController));
router.get('/marketplace/stats',      apiRateLimiter, toolsController.getMarketplaceStats.bind(toolsController));

// ── Orders ────────────────────────────────────────────────────────────────────
router.get('/marketplace/orders/mine',               apiRateLimiter, toolsController.getMyOrders.bind(toolsController));
router.get('/marketplace/orders/selling',            apiRateLimiter, toolsController.getSellerOrders.bind(toolsController));
router.get('/marketplace/orders/:orderId',           apiRateLimiter, toolsController.getOrder.bind(toolsController));
router.post('/marketplace/orders',                   apiRateLimiter, toolsController.placeOrder.bind(toolsController));
router.patch('/marketplace/orders/:orderId/status',  apiRateLimiter, toolsController.updateOrderStatus.bind(toolsController));
router.post('/marketplace/orders/:orderId/cancel',   apiRateLimiter, toolsController.cancelOrder.bind(toolsController));

// ── Reviews ───────────────────────────────────────────────────────────────────
router.get('/marketplace/listings/:listingId/reviews',  apiRateLimiter, toolsController.getReviews.bind(toolsController));
router.post('/marketplace/listings/:listingId/reviews', apiRateLimiter, toolsController.createReview.bind(toolsController));
router.patch('/marketplace/reviews/:reviewId/reply',    apiRateLimiter, toolsController.replyToReview.bind(toolsController));
router.post('/marketplace/reviews/:reviewId/helpful',   apiRateLimiter, toolsController.markReviewHelpful.bind(toolsController));

// ── Seller Profile ────────────────────────────────────────────────────────────
router.get('/marketplace/seller/:sellerId',          apiRateLimiter, toolsController.getSellerProfile.bind(toolsController));
router.get('/marketplace/seller/:sellerId/listings', apiRateLimiter, toolsController.getSellerListings.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// PREMIUM / PAYMENTS
// ═════════════════════════════════════════════════════════════════════════════
router.get('/premium/features',         apiRateLimiter, toolsController.getPremiumFeatures.bind(toolsController));
router.post('/payments/process',        apiRateLimiter, toolsController.processPayment.bind(toolsController));
router.post('/payments/mpesa/callback', toolsController.mpesaCallback.bind(toolsController)); // no rate limit — Safaricom push

// ═════════════════════════════════════════════════════════════════════════════
// FULL ECOMMERCE MARKETPLACE — marketplace.routes.js mounted here
// Adds: products, wishlist, orders, payments, reviews, seller dashboard,
//       delivery, categories, admin, image upload, M-Pesa, card payment.
// Exposed at /api/tools/marketplace/* (forwards to /api/marketplace/*)
// ═════════════════════════════════════════════════════════════════════════════
(function _mountEcomRoutes() {
    let mpRouter;
    try {
        mpRouter = require('./marketplace.routes');
    } catch (_) {
        try { mpRouter = require('../routes/marketplace.routes'); } catch (_) {}
    }
    if (mpRouter) {
        router.use('/marketplace', mpRouter);
        console.log('[tools.js] ✅ Marketplace ecommerce routes mounted at /api/tools/marketplace');
    } else {
        console.warn('[tools.js] ⚠️ marketplace.routes.js not found — ecom routes unavailable');
    }
})();

module.exports = router;