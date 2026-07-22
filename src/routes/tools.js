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

let apiRateLimiter, marketplaceLimiter;
try {
    const rl = require('../middleware/rateLimiter');
    apiRateLimiter = rl.apiRateLimiter;
    // FIX (2026-07-22): use a dedicated bucket for this entire router (tools +
    // marketplace) instead of the global apiRateLimiter shared with chat/messages/
    // typing-indicators/calls — that shared bucket was getting exhausted by normal
    // chat activity, causing Publish and other marketplace calls to fail with
    // 429 "Too many requests" even though the user hadn't made many marketplace
    // requests themselves. Falls back to apiRateLimiter if unavailable for any reason.
    marketplaceLimiter = rl.marketplaceLimiter || rl.apiRateLimiter;
} catch (_) {
    // Fallback: pass-through when rateLimiter is unavailable (e.g. tests)
    apiRateLimiter = (_req, _res, next) => next();
    marketplaceLimiter = apiRateLimiter;
}



// ═════════════════════════════════════════════════════════════════════════════
// [FIX 1] TOOL MANIFEST — returns ALL tools the frontend should know about.
// Called by Tool-core.js on startup AND by ToolSyncEngine.discoverTools().
// Response shape: { tools: [...], total, categories, generatedAt }
// ═════════════════════════════════════════════════════════════════════════════
router.get('/',          marketplaceLimiter, toolsController.getToolsList.bind(toolsController));

// ─── [FIX 2] TOOL REGISTRY ───────────────────────────────────────────────────
// GET /api/tools/registry
// Same as above but named per ToolSyncEngine / ToolRegistryManager expectations.
// Shape: { tools: [...] }  (signed tool definitions)
router.get('/registry',  marketplaceLimiter, toolsController.getToolRegistry.bind(toolsController));

// ─── [FIX 3] UNIFIED TOOL ACTION DISPATCHER ──────────────────────────────────
// POST /api/tools/action
// Body: { toolId: string, action: string, params: {} }
// Replaces the old pattern of one route per tool operation.
// Supports both server-side AND client-driven tool execution.
router.post('/action',   marketplaceLimiter, toolsController.executeToolAction.bind(toolsController));

// ─── [FIX 4] USAGE TELEMETRY ─────────────────────────────────────────────────
// POST /api/tools/:toolId/usage
// Body: { action: string }  — logs a tool invocation for the requesting user
router.post('/:toolId/usage', marketplaceLimiter, toolsController.recordUsage.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═════════════════════════════════════════════════════════════════════════════
router.post('/upload/image',   marketplaceLimiter, toolsController.uploadImage.bind(toolsController));
router.post('/upload/file',    marketplaceLimiter, toolsController.uploadFile.bind(toolsController));
router.delete('/upload/:fileId', marketplaceLimiter, toolsController.deleteFile.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// IMAGE PROCESSING
// ═════════════════════════════════════════════════════════════════════════════
router.post('/image/resize',    marketplaceLimiter, toolsController.resizeImage.bind(toolsController));
router.post('/image/compress',  marketplaceLimiter, toolsController.compressImage.bind(toolsController));
router.post('/image/convert',   marketplaceLimiter, toolsController.convertImage.bind(toolsController));
router.post('/image/watermark', marketplaceLimiter, toolsController.addWatermark.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// PDF TOOLS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/pdf/merge',    marketplaceLimiter, toolsController.mergePDFs.bind(toolsController));
router.post('/pdf/split',    marketplaceLimiter, toolsController.splitPDF.bind(toolsController));
router.post('/pdf/compress', marketplaceLimiter, toolsController.compressPDF.bind(toolsController));
router.post('/pdf/convert',  marketplaceLimiter, toolsController.convertToPDF.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// TEXT TOOLS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/text/analyze',   marketplaceLimiter, toolsController.analyzeText.bind(toolsController));
router.post('/text/translate', marketplaceLimiter, toolsController.translateText.bind(toolsController));
router.post('/text/summarize', marketplaceLimiter, toolsController.summarizeText.bind(toolsController));
router.post('/text/sentiment', marketplaceLimiter, toolsController.analyzeSentiment.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// QR / BARCODE
// ═════════════════════════════════════════════════════════════════════════════
router.post('/qrcode/generate', marketplaceLimiter, toolsController.generateQRCode.bind(toolsController));
router.post('/qrcode/scan',     marketplaceLimiter, toolsController.scanQRCode.bind(toolsController));
router.post('/barcode/generate',marketplaceLimiter, toolsController.generateBarcode.bind(toolsController));
router.post('/barcode/scan',    marketplaceLimiter, toolsController.scanBarcode.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// SECURITY GENERATORS
// ═════════════════════════════════════════════════════════════════════════════
router.get('/password/generate',  marketplaceLimiter, toolsController.generatePassword.bind(toolsController));
router.post('/password/strength', marketplaceLimiter, toolsController.checkPasswordStrength.bind(toolsController));
router.post('/hash/generate',     marketplaceLimiter, toolsController.generateHash.bind(toolsController));
router.get('/uuid/generate',      marketplaceLimiter, toolsController.generateUUID.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// ENCODING
// ═════════════════════════════════════════════════════════════════════════════
router.post('/base64/encode', marketplaceLimiter, toolsController.encodeBase64.bind(toolsController));
router.post('/base64/decode', marketplaceLimiter, toolsController.decodeBase64.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// JSON / CSV
// ═════════════════════════════════════════════════════════════════════════════
router.post('/json/format',   marketplaceLimiter, toolsController.formatJSON.bind(toolsController));
router.post('/json/validate', marketplaceLimiter, toolsController.validateJSON.bind(toolsController));
router.post('/json/minify',   marketplaceLimiter, toolsController.minifyJSON.bind(toolsController));
router.post('/csv/convert',   marketplaceLimiter, toolsController.convertCSV.bind(toolsController));
router.post('/csv/validate',  marketplaceLimiter, toolsController.validateCSV.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// DATE / TIME
// ═════════════════════════════════════════════════════════════════════════════
router.get('/timestamp/current',   marketplaceLimiter, toolsController.getCurrentTimestamp.bind(toolsController));
router.post('/timestamp/convert',  marketplaceLimiter, toolsController.convertTimestamp.bind(toolsController));
router.post('/date/difference',    marketplaceLimiter, toolsController.calculateDateDifference.bind(toolsController));
router.post('/date/add',           marketplaceLimiter, toolsController.addToDate.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// CONVERTERS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/color/convert',    marketplaceLimiter, toolsController.convertColor.bind(toolsController));
router.post('/unit/convert',     marketplaceLimiter, toolsController.convertUnit.bind(toolsController));
router.post('/currency/convert', marketplaceLimiter, toolsController.convertCurrency.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// URL SHORTENER
// ═════════════════════════════════════════════════════════════════════════════
router.post('/url/shorten',     marketplaceLimiter, toolsController.shortenURL.bind(toolsController));
// [FIX 5] — :shortCode MUST come after all static /url/... paths to avoid capture
router.get('/url/:shortCode',   marketplaceLimiter, toolsController.redirectShortURL.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// NETWORK / SYSTEM
// ═════════════════════════════════════════════════════════════════════════════
router.get('/ip/info',         marketplaceLimiter, toolsController.getIPInfo.bind(toolsController));
router.get('/ip/location',     marketplaceLimiter, toolsController.getIPLocation.bind(toolsController));
router.get('/user-agent/parse',marketplaceLimiter, toolsController.parseUserAgent.bind(toolsController));
router.post('/file/info',      marketplaceLimiter, toolsController.getFileInfo.bind(toolsController));
router.get('/system/status',   marketplaceLimiter, toolsController.getSystemStatus.bind(toolsController));
router.get('/system/health',   marketplaceLimiter, toolsController.getHealthStatus.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// BACKUP / CLEANUP
// ═════════════════════════════════════════════════════════════════════════════
router.post('/backup/create',  marketplaceLimiter, toolsController.createBackup.bind(toolsController));
router.get('/backup/list',     marketplaceLimiter, toolsController.listBackups.bind(toolsController));
router.post('/backup/restore', marketplaceLimiter, toolsController.restoreBackup.bind(toolsController));
router.post('/cleanup/temp',   marketplaceLimiter, toolsController.cleanupTempFiles.bind(toolsController));
router.post('/cleanup/old',    marketplaceLimiter, toolsController.cleanupOldFiles.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT / IMPORT / BATCH
// ═════════════════════════════════════════════════════════════════════════════
router.post('/export/data',    marketplaceLimiter, toolsController.exportData.bind(toolsController));
router.post('/import/data',    marketplaceLimiter, toolsController.importData.bind(toolsController));
router.post('/batch/process',  marketplaceLimiter, toolsController.processBatch.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// STATS / SUBSCRIPTION
// ═════════════════════════════════════════════════════════════════════════════
router.get('/stats/usage',       marketplaceLimiter, toolsController.getUsageStats.bind(toolsController));
router.get('/user/subscription', marketplaceLimiter, toolsController.getUserSubscription.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// MARKETPLACE
// NOTE: Specific paths must come before :listingId wildcard paths
// ═════════════════════════════════════════════════════════════════════════════
router.get('/marketplace/listings/mine',    marketplaceLimiter, toolsController.getMyListings.bind(toolsController));
router.get('/marketplace/listings/saved',   marketplaceLimiter, toolsController.getSavedListings.bind(toolsController));
router.get('/marketplace/listings/premium', marketplaceLimiter, toolsController.getPremiumListings.bind(toolsController));
router.get('/marketplace/listings',         marketplaceLimiter, toolsController.getListings.bind(toolsController));
router.get('/marketplace/listings/:listingId', marketplaceLimiter, toolsController.getListing.bind(toolsController));

router.post('/marketplace/listings',         marketplaceLimiter, toolsController.createListing.bind(toolsController));
// FIX (2026-07-22): frontend has always POSTed here for Premium tab listings,
// but only a GET existed for this path — every premium submission 404'd.
// Reuses the same (now premium-aware) createListing controller rather than
// duplicating listing-creation logic in a second function.
router.post('/marketplace/listings/premium', marketplaceLimiter, toolsController.createListing.bind(toolsController));
router.post('/marketplace/listings/bulk',    marketplaceLimiter, toolsController.bulkCreateListings.bind(toolsController));
router.put('/marketplace/listings/:listingId',    marketplaceLimiter, toolsController.updateListing.bind(toolsController));
router.delete('/marketplace/listings/:listingId', marketplaceLimiter, toolsController.deleteListing.bind(toolsController));

router.post('/marketplace/listings/:listingId/view',     marketplaceLimiter, toolsController.recordListingView.bind(toolsController));
router.post('/marketplace/listings/:listingId/save',     marketplaceLimiter, toolsController.toggleSaveListing.bind(toolsController));
router.post('/marketplace/listings/:listingId/purchase', marketplaceLimiter, toolsController.purchaseListing.bind(toolsController));
router.post('/marketplace/listings/:listingId/rate',     marketplaceLimiter, toolsController.rateListing.bind(toolsController));

router.get('/marketplace/spotlight',  marketplaceLimiter, toolsController.getSpotlightListings.bind(toolsController));
router.post('/marketplace/spotlight', marketplaceLimiter, toolsController.addToSpotlight.bind(toolsController));
router.post('/marketplace/boost',     marketplaceLimiter, toolsController.boostListing.bind(toolsController));
router.get('/marketplace/leaderboard',marketplaceLimiter, toolsController.getLeaderboard.bind(toolsController));
router.post('/marketplace/tips',      marketplaceLimiter, toolsController.sendTip.bind(toolsController));
router.get('/marketplace/stats',      marketplaceLimiter, toolsController.getMarketplaceStats.bind(toolsController));

// ── Frontend alias routes ─────────────────────────────────────────────────────
// AUDIT FIX: These aliases used to shadow the real e-commerce marketplace.
// Tool-core.js's normalizeToolsEndpoint() rewrites every /api/marketplace/*
// call to /api/tools/marketplace/*, so marketplace-ecommerce.js's product
// browsing, wishlist, recommendations, and order placement/status/cancel
// calls were silently being served by the legacy Tools-listings controller
// (different data model — "listings" not "products") instead of
// marketplace.controller.js. Removed the colliding aliases; the real router
// is mounted via _mountEcomRoutes() at the bottom of this file and now
// handles these paths correctly. Kept /orders/mine and /orders/selling
// since they don't collide with the real router's route set and are still
// used by the legacy Tools UI.
router.get('/marketplace/orders/mine',               marketplaceLimiter, toolsController.getMyOrders.bind(toolsController));
router.get('/marketplace/orders/selling',            marketplaceLimiter, toolsController.getSellerOrders.bind(toolsController));

// ── Reviews ───────────────────────────────────────────────────────────────────
router.get('/marketplace/listings/:listingId/reviews',  marketplaceLimiter, toolsController.getReviews.bind(toolsController));
router.post('/marketplace/listings/:listingId/reviews', marketplaceLimiter, toolsController.createReview.bind(toolsController));
router.patch('/marketplace/reviews/:reviewId/reply',    marketplaceLimiter, toolsController.replyToReview.bind(toolsController));
router.post('/marketplace/reviews/:reviewId/helpful',   marketplaceLimiter, toolsController.markReviewHelpful.bind(toolsController));

// ── Seller Profile ────────────────────────────────────────────────────────────
router.get('/marketplace/seller/:sellerId',          marketplaceLimiter, toolsController.getSellerProfile.bind(toolsController));
router.get('/marketplace/seller/:sellerId/listings', marketplaceLimiter, toolsController.getSellerListings.bind(toolsController));

// ═════════════════════════════════════════════════════════════════════════════
// PREMIUM / PAYMENTS
// ═════════════════════════════════════════════════════════════════════════════
router.get('/premium/features',         marketplaceLimiter, toolsController.getPremiumFeatures.bind(toolsController));
router.post('/payments/process',        marketplaceLimiter, toolsController.processPayment.bind(toolsController));
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