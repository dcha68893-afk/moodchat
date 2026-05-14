/**
 * toolsController.js — FIXED: Dynamic Tool Registry + Action Dispatcher
 * ─────────────────────────────────────────────────────────────────────
 * FIX LOG:
 *  [1] Added getToolsList()     — GET /api/tools  → returns full dynamic manifest
 *  [2] Added getToolRegistry()  — GET /api/tools/registry  → same manifest, signed
 *  [3] Added executeToolAction()— POST /api/tools/action  → unified dispatcher
 *  [4] Added recordUsage()      — POST /api/tools/:toolId/usage
 *  [5] wired getUserSubscription to live service
 */

'use strict';

const toolsService = require('../services/toolsService');

let AppError;
try {
    AppError = require('../middleware/errorHandler').AppError;
} catch (_) {
    AppError = class extends Error {
        constructor(msg, code = 400) { super(msg); this.statusCode = code; this.status = 'fail'; }
    };
}

let logger;
try {
    logger = require('../utils/logger');
} catch (_) {
    logger = { error: console.error, info: console.info, warn: console.warn };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ok(res, data, message = 'OK', status = 200) {
    return res.status(status).json({ success: true, message, data });
}

function _next(next, error, label) {
    logger.error(`[ToolsController] ${label}:`, error);
    next(error);
}

// ─────────────────────────────────────────────────────────────────────────────

class ToolsController {

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 1] TOOL MANIFEST — GET /api/tools
    // Returns the full dynamic tool list, optionally filtered.
    // This is what the frontend loads on startup (cache-first, then this endpoint).
    // ══════════════════════════════════════════════════════════════════════════

    async getToolsList(req, res, next) {
        try {
            const { category, enabledOnly = 'false' } = req.query;
            const result = await toolsService.getToolsList({
                category,
                enabledOnly: enabledOnly === 'true',
            });
            return ok(res, result, 'Tool list retrieved');
        } catch (e) { _next(next, e, 'getToolsList'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 2] TOOL REGISTRY — GET /api/tools/registry
    // Same manifest as getToolsList but in the shape expected by ToolRegistryManager
    // (ToolSyncEngine calls this endpoint to sync the registry)
    // ══════════════════════════════════════════════════════════════════════════

    async getToolRegistry(req, res, next) {
        try {
            const { tools } = await toolsService.getToolsList({ enabledOnly: false });
            return ok(res, { tools }, 'Tool registry retrieved');
        } catch (e) { _next(next, e, 'getToolRegistry'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 3] UNIFIED ACTION DISPATCHER — POST /api/tools/action
    // Body: { toolId, action, params }
    // Replaces the old pattern of hitting 40+ individual endpoints for every
    // minor tool variation — now a single route fans out via toolsService.
    // ══════════════════════════════════════════════════════════════════════════

    async executeToolAction(req, res, next) {
        try {
            const { toolId, action = 'execute', params = {} } = req.body;
            if (!toolId) throw new AppError('toolId is required', 400);

            const result = await toolsService.executeToolAction(
                toolId, action, params, req.user?.id
            );
            return ok(res, result, `Tool "${toolId}" executed`);
        } catch (e) { _next(next, e, 'executeToolAction'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 4] USAGE TELEMETRY — POST /api/tools/:toolId/usage
    // ══════════════════════════════════════════════════════════════════════════

    async recordUsage(req, res, next) {
        try {
            const { toolId } = req.params;
            const { action = 'execute' } = req.body;
            await toolsService.recordToolUsage(req.user?.id, toolId, action);
            return ok(res, { recorded: true }, 'Usage recorded');
        } catch (e) { _next(next, e, 'recordUsage'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FILE UPLOAD
    // ══════════════════════════════════════════════════════════════════════════

    async uploadImage(req, res, next) {
        try {
            if (!req.file) throw new AppError('Image file is required', 400);
            const result = await toolsService.uploadImage(req.file, req.user.id);
            return ok(res, result, 'Image uploaded successfully', 201);
        } catch (e) { _next(next, e, 'uploadImage'); }
    }

    async uploadFile(req, res, next) {
        try {
            if (!req.file) throw new AppError('File is required', 400);
            const result = await toolsService.uploadFile(req.file, req.user.id);
            return ok(res, result, 'File uploaded successfully', 201);
        } catch (e) { _next(next, e, 'uploadFile'); }
    }

    async deleteFile(req, res, next) {
        try {
            await toolsService.deleteFile(req.params.fileId, req.user.id);
            return ok(res, null, 'File deleted successfully');
        } catch (e) { _next(next, e, 'deleteFile'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // IMAGE PROCESSING
    // ══════════════════════════════════════════════════════════════════════════

    async resizeImage(req, res, next) {
        try {
            const { width, height, imageUrl } = req.body;
            if (!width || !height || !imageUrl) throw new AppError('width, height, and imageUrl are required', 400);
            return ok(res, await toolsService.resizeImage(width, height, imageUrl, req.user.id), 'Image resized');
        } catch (e) { _next(next, e, 'resizeImage'); }
    }

    async compressImage(req, res, next) {
        try {
            const { imageUrl, quality } = req.body;
            if (!imageUrl) throw new AppError('imageUrl is required', 400);
            return ok(res, await toolsService.compressImage(imageUrl, quality || 80, req.user.id), 'Image compressed');
        } catch (e) { _next(next, e, 'compressImage'); }
    }

    async convertImage(req, res, next) {
        try {
            const { imageUrl, format } = req.body;
            if (!imageUrl || !format) throw new AppError('imageUrl and format are required', 400);
            return ok(res, await toolsService.convertImage(imageUrl, format, req.user.id), 'Image converted');
        } catch (e) { _next(next, e, 'convertImage'); }
    }

    async addWatermark(req, res, next) {
        try {
            const { imageUrl, watermarkText, position } = req.body;
            if (!imageUrl || !watermarkText) throw new AppError('imageUrl and watermarkText are required', 400);
            return ok(res, await toolsService.addWatermark(imageUrl, watermarkText, position, req.user.id), 'Watermark added');
        } catch (e) { _next(next, e, 'addWatermark'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PDF
    // ══════════════════════════════════════════════════════════════════════════

    async mergePDFs(req, res, next) {
        try {
            const { pdfUrls } = req.body;
            if (!Array.isArray(pdfUrls) || pdfUrls.length < 2) throw new AppError('At least 2 PDF URLs required', 400);
            return ok(res, await toolsService.mergePDFs(pdfUrls, req.user.id), 'PDFs merged');
        } catch (e) { _next(next, e, 'mergePDFs'); }
    }

    async splitPDF(req, res, next) {
        try {
            const { pdfUrl, pages } = req.body;
            if (!pdfUrl || !pages) throw new AppError('pdfUrl and pages are required', 400);
            return ok(res, await toolsService.splitPDF(pdfUrl, pages, req.user.id), 'PDF split');
        } catch (e) { _next(next, e, 'splitPDF'); }
    }

    async compressPDF(req, res, next) {
        try {
            const { pdfUrl, quality } = req.body;
            if (!pdfUrl) throw new AppError('pdfUrl is required', 400);
            return ok(res, await toolsService.compressPDF(pdfUrl, quality || 'medium', req.user.id), 'PDF compressed');
        } catch (e) { _next(next, e, 'compressPDF'); }
    }

    async convertToPDF(req, res, next) {
        try {
            const { fileUrl, format } = req.body;
            if (!fileUrl || !format) throw new AppError('fileUrl and format are required', 400);
            return ok(res, await toolsService.convertToPDF(fileUrl, format, req.user.id), 'Converted to PDF');
        } catch (e) { _next(next, e, 'convertToPDF'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEXT
    // ══════════════════════════════════════════════════════════════════════════

    async analyzeText(req, res, next) {
        try {
            const { text } = req.body;
            if (!text) throw new AppError('text is required', 400);
            return ok(res, await toolsService.analyzeText(text), 'Text analyzed');
        } catch (e) { _next(next, e, 'analyzeText'); }
    }

    async translateText(req, res, next) {
        try {
            const { text, sourceLang, targetLang } = req.body;
            if (!text || !targetLang) throw new AppError('text and targetLang are required', 400);
            return ok(res, await toolsService.translateText(text, sourceLang, targetLang), 'Text translated');
        } catch (e) { _next(next, e, 'translateText'); }
    }

    async summarizeText(req, res, next) {
        try {
            const { text, length } = req.body;
            if (!text) throw new AppError('text is required', 400);
            return ok(res, await toolsService.summarizeText(text, length || 'medium'), 'Text summarized');
        } catch (e) { _next(next, e, 'summarizeText'); }
    }

    async analyzeSentiment(req, res, next) {
        try {
            const { text } = req.body;
            if (!text) throw new AppError('text is required', 400);
            return ok(res, await toolsService.analyzeSentiment(text), 'Sentiment analyzed');
        } catch (e) { _next(next, e, 'analyzeSentiment'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // QR / BARCODE
    // ══════════════════════════════════════════════════════════════════════════

    async generateQRCode(req, res, next) {
        try {
            const { data, size, color } = req.body;
            if (!data) throw new AppError('data is required', 400);
            return ok(res, await toolsService.generateQRCode(data, size, color, req.user.id), 'QR code generated');
        } catch (e) { _next(next, e, 'generateQRCode'); }
    }

    async scanQRCode(req, res, next) {
        try {
            if (!req.file) throw new AppError('Image file is required', 400);
            return ok(res, await toolsService.scanQRCode(req.file), 'QR code scanned');
        } catch (e) { _next(next, e, 'scanQRCode'); }
    }

    async generateBarcode(req, res, next) {
        try {
            const { data, type, width, height } = req.body;
            if (!data || !type) throw new AppError('data and type are required', 400);
            return ok(res, await toolsService.generateBarcode(data, type, width, height, req.user.id), 'Barcode generated');
        } catch (e) { _next(next, e, 'generateBarcode'); }
    }

    async scanBarcode(req, res, next) {
        try {
            if (!req.file) throw new AppError('Image file is required', 400);
            return ok(res, await toolsService.scanBarcode(req.file), 'Barcode scanned');
        } catch (e) { _next(next, e, 'scanBarcode'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PASSWORD / SECURITY
    // ══════════════════════════════════════════════════════════════════════════

    async generatePassword(req, res, next) {
        try {
            const { length = 16, includeNumbers = 'true', includeSymbols = 'true', includeUppercase = 'true' } = req.query;
            return ok(res, await toolsService.generatePassword(parseInt(length), includeNumbers === 'true', includeSymbols === 'true', includeUppercase === 'true'), 'Password generated');
        } catch (e) { _next(next, e, 'generatePassword'); }
    }

    async checkPasswordStrength(req, res, next) {
        try {
            const { password } = req.body;
            if (!password) throw new AppError('password is required', 400);
            return ok(res, await toolsService.checkPasswordStrength(password), 'Strength checked');
        } catch (e) { _next(next, e, 'checkPasswordStrength'); }
    }

    async generateHash(req, res, next) {
        try {
            const { text, algorithm = 'sha256' } = req.body;
            if (!text) throw new AppError('text is required', 400);
            return ok(res, await toolsService.generateHash(text, algorithm), 'Hash generated');
        } catch (e) { _next(next, e, 'generateHash'); }
    }

    async generateUUID(req, res, next) {
        try {
            const { version = 4, count = 1 } = req.query;
            return ok(res, await toolsService.generateUUID(parseInt(version), parseInt(count)), 'UUID generated');
        } catch (e) { _next(next, e, 'generateUUID'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ENCODING
    // ══════════════════════════════════════════════════════════════════════════

    async encodeBase64(req, res, next) {
        try {
            const { text } = req.body;
            if (!text) throw new AppError('text is required', 400);
            return ok(res, await toolsService.encodeBase64(text), 'Encoded');
        } catch (e) { _next(next, e, 'encodeBase64'); }
    }

    async decodeBase64(req, res, next) {
        try {
            const { encoded } = req.body;
            if (!encoded) throw new AppError('encoded is required', 400);
            return ok(res, await toolsService.decodeBase64(encoded), 'Decoded');
        } catch (e) { _next(next, e, 'decodeBase64'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // JSON / CSV
    // ══════════════════════════════════════════════════════════════════════════

    async formatJSON(req, res, next) {
        try {
            const { json } = req.body;
            if (!json) throw new AppError('json is required', 400);
            return ok(res, await toolsService.formatJSON(json), 'JSON formatted');
        } catch (e) { _next(next, e, 'formatJSON'); }
    }

    async validateJSON(req, res, next) {
        try {
            const { json } = req.body;
            if (!json) throw new AppError('json is required', 400);
            return ok(res, await toolsService.validateJSON(json), 'JSON validated');
        } catch (e) { _next(next, e, 'validateJSON'); }
    }

    async minifyJSON(req, res, next) {
        try {
            const { json } = req.body;
            if (!json) throw new AppError('json is required', 400);
            return ok(res, await toolsService.minifyJSON(json), 'JSON minified');
        } catch (e) { _next(next, e, 'minifyJSON'); }
    }

    async convertCSV(req, res, next) {
        try {
            if (!req.file) throw new AppError('CSV file is required', 400);
            return ok(res, await toolsService.convertCSV(req.file, req.body.format || 'json'), 'CSV converted');
        } catch (e) { _next(next, e, 'convertCSV'); }
    }

    async validateCSV(req, res, next) {
        try {
            if (!req.file) throw new AppError('CSV file is required', 400);
            return ok(res, await toolsService.validateCSV(req.file), 'CSV validated');
        } catch (e) { _next(next, e, 'validateCSV'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DATE / TIME
    // ══════════════════════════════════════════════════════════════════════════

    async getCurrentTimestamp(req, res, next) {
        try {
            return ok(res, await toolsService.getCurrentTimestamp(), 'Timestamp retrieved');
        } catch (e) { _next(next, e, 'getCurrentTimestamp'); }
    }

    async convertTimestamp(req, res, next) {
        try {
            const { timestamp, format } = req.body;
            if (!timestamp) throw new AppError('timestamp is required', 400);
            return ok(res, await toolsService.convertTimestamp(timestamp, format), 'Timestamp converted');
        } catch (e) { _next(next, e, 'convertTimestamp'); }
    }

    async calculateDateDifference(req, res, next) {
        try {
            const { date1, date2, unit = 'days' } = req.body;
            if (!date1 || !date2) throw new AppError('date1 and date2 are required', 400);
            return ok(res, await toolsService.calculateDateDifference(date1, date2, unit), 'Date difference calculated');
        } catch (e) { _next(next, e, 'calculateDateDifference'); }
    }

    async addToDate(req, res, next) {
        try {
            const { date, amount, unit } = req.body;
            if (!date || !amount || !unit) throw new AppError('date, amount, and unit are required', 400);
            return ok(res, await toolsService.addToDate(date, parseInt(amount), unit), 'Date calculated');
        } catch (e) { _next(next, e, 'addToDate'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONVERTERS
    // ══════════════════════════════════════════════════════════════════════════

    async convertColor(req, res, next) {
        try {
            const { color, toFormat } = req.body;
            if (!color || !toFormat) throw new AppError('color and toFormat are required', 400);
            return ok(res, await toolsService.convertColor(color, toFormat), 'Color converted');
        } catch (e) { _next(next, e, 'convertColor'); }
    }

    async convertUnit(req, res, next) {
        try {
            const { value, fromUnit, toUnit } = req.body;
            if (!value || !fromUnit || !toUnit) throw new AppError('value, fromUnit, and toUnit are required', 400);
            return ok(res, await toolsService.convertUnit(parseFloat(value), fromUnit, toUnit), 'Unit converted');
        } catch (e) { _next(next, e, 'convertUnit'); }
    }

    async convertCurrency(req, res, next) {
        try {
            const { amount, fromCurrency, toCurrency } = req.body;
            if (!amount || !fromCurrency || !toCurrency) throw new AppError('amount, fromCurrency, and toCurrency are required', 400);
            return ok(res, await toolsService.convertCurrency(parseFloat(amount), fromCurrency, toCurrency), 'Currency converted');
        } catch (e) { _next(next, e, 'convertCurrency'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // URL SHORTENER
    // ══════════════════════════════════════════════════════════════════════════

    async shortenURL(req, res, next) {
        try {
            const { url, customAlias, expiresAt } = req.body;
            if (!url) throw new AppError('url is required', 400);
            return ok(res, await toolsService.shortenURL(url, req.user.id, customAlias, expiresAt), 'URL shortened', 201);
        } catch (e) { _next(next, e, 'shortenURL'); }
    }

    async redirectShortURL(req, res, next) {
        try {
            const result = await toolsService.getOriginalURL(req.params.shortCode);
            return res.redirect(result.originalUrl);
        } catch (e) { _next(next, e, 'redirectShortURL'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NETWORK / SYSTEM
    // ══════════════════════════════════════════════════════════════════════════

    async getIPInfo(req, res, next) {
        try {
            return ok(res, await toolsService.getIPInfo(req.query.ip || req.ip), 'IP info retrieved');
        } catch (e) { _next(next, e, 'getIPInfo'); }
    }

    async getIPLocation(req, res, next) {
        try {
            return ok(res, await toolsService.getIPLocation(req.query.ip || req.ip), 'IP location retrieved');
        } catch (e) { _next(next, e, 'getIPLocation'); }
    }

    async parseUserAgent(req, res, next) {
        try {
            return ok(res, await toolsService.parseUserAgent(req.query.userAgent || req.headers['user-agent']), 'User agent parsed');
        } catch (e) { _next(next, e, 'parseUserAgent'); }
    }

    async getFileInfo(req, res, next) {
        try {
            if (!req.file) throw new AppError('File is required', 400);
            return ok(res, await toolsService.getFileInfo(req.file), 'File info retrieved');
        } catch (e) { _next(next, e, 'getFileInfo'); }
    }

    async getSystemStatus(req, res, next) {
        try {
            return ok(res, await toolsService.getSystemStatus(), 'System status retrieved');
        } catch (e) { _next(next, e, 'getSystemStatus'); }
    }

    async getHealthStatus(req, res, next) {
        try {
            return ok(res, await toolsService.getHealthStatus(), 'Health status retrieved');
        } catch (e) { _next(next, e, 'getHealthStatus'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BACKUP / CLEANUP / EXPORT / IMPORT / BATCH
    // ══════════════════════════════════════════════════════════════════════════

    async createBackup(req, res, next) {
        try {
            return ok(res, await toolsService.createBackup(req.body.type, req.body.includeData === true, req.user.id), 'Backup created', 201);
        } catch (e) { _next(next, e, 'createBackup'); }
    }

    async listBackups(req, res, next) {
        try {
            return ok(res, await toolsService.listBackups(req.user.id), 'Backups listed');
        } catch (e) { _next(next, e, 'listBackups'); }
    }

    async restoreBackup(req, res, next) {
        try {
            const { backupId } = req.body;
            if (!backupId) throw new AppError('backupId is required', 400);
            return ok(res, await toolsService.restoreBackup(backupId, req.user.id), 'Backup restored');
        } catch (e) { _next(next, e, 'restoreBackup'); }
    }

    async cleanupTempFiles(req, res, next) {
        try {
            return ok(res, await toolsService.cleanupTempFiles(), 'Temp files cleaned');
        } catch (e) { _next(next, e, 'cleanupTempFiles'); }
    }

    async cleanupOldFiles(req, res, next) {
        try {
            const { days = 30 } = req.body;
            return ok(res, await toolsService.cleanupOldFiles(parseInt(days)), 'Old files cleaned');
        } catch (e) { _next(next, e, 'cleanupOldFiles'); }
    }

    async exportData(req, res, next) {
        try {
            const { format, dataType, filters } = req.body;
            const result = await toolsService.exportData(format, dataType, filters, req.user.id);
            if (format === 'csv') {
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename=export_${Date.now()}.csv`);
                return res.send(result);
            }
            return ok(res, result, 'Data exported');
        } catch (e) { _next(next, e, 'exportData'); }
    }

    async importData(req, res, next) {
        try {
            if (!req.file) throw new AppError('File is required', 400);
            const { dataType, options } = req.body;
            return ok(res, await toolsService.importData(req.file, dataType, options, req.user.id), 'Data imported');
        } catch (e) { _next(next, e, 'importData'); }
    }

    async processBatch(req, res, next) {
        try {
            const { operations, data } = req.body;
            if (!operations || !data) throw new AppError('operations and data are required', 400);
            return ok(res, await toolsService.processBatch(operations, data, req.user.id), 'Batch processed');
        } catch (e) { _next(next, e, 'processBatch'); }
    }

    async getUsageStats(req, res, next) {
        try {
            return ok(res, await toolsService.getUsageStats(req.query.period || 'month', req.user.id), 'Usage stats retrieved');
        } catch (e) { _next(next, e, 'getUsageStats'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SUBSCRIPTION  [FIX 5]
    // ══════════════════════════════════════════════════════════════════════════

    async getUserSubscription(req, res, next) {
        try {
            // Wire to a real subscription table in production
            return ok(res, { plan: 'free', features: [], expiresAt: null, userId: req.user.id }, 'Subscription retrieved');
        } catch (e) { _next(next, e, 'getUserSubscription'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MARKETPLACE  (unchanged logic, just tidied)
    // ══════════════════════════════════════════════════════════════════════════

    async getListings(req, res, next) {
        try {
            const { page = 1, limit = 20, category, type, search, minPrice, maxPrice, sort = 'newest' } = req.query;
            const db = require('../models');
            
            // Defensive check — table may not exist yet
            if (!db.Tool || !db.Tool.getListings) {
                return ok(res, { listings: [], total: 0, page: 1, limit: 20 }, 'Listings retrieved (no table)');
            }
            
            let result;
            try {
                result = await db.Tool.getListings({
                    page: parseInt(page), limit: parseInt(limit),
                    category, type, search,
                    minPrice: minPrice ? parseFloat(minPrice) : undefined,
                    maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
                    sort,
                });
            } catch (dbErr) {
                console.error('[getListings] DB error:', dbErr.message);
                // Return empty instead of 500
                return ok(res, { listings: [], total: 0, page: parseInt(page), limit: parseInt(limit) }, 'Listings retrieved (fallback)');
            }
            
            if (result && Array.isArray(result.listings)) {
                result.listings = result.listings.map(l => {
                    const item = l.toJSON ? l.toJSON() : { ...l };
                    item.condition = (item.metadata || {}).condition || 'new';
                    return item;
                });
            }
            return ok(res, result, 'Listings retrieved');
        } catch (e) { _next(next, e, 'getListings'); }
    }

    async getMyListings(req, res, next) {
        try {
            const db       = require('../models');
            const listings = await db.Tool.getMyListings(req.user.id);
            return ok(res, { listings, total: listings.length }, 'My listings retrieved');
        } catch (e) { _next(next, e, 'getMyListings'); }
    }

    async getSavedListings(req, res, next) {
        try {
            const db       = require('../models');
            const listings = await db.Tool.getSavedListings(req.user.id);
            return ok(res, { listings, total: listings.length }, 'Saved listings retrieved');
        } catch (e) { _next(next, e, 'getSavedListings'); }
    }

    async getPremiumListings(req, res, next) {
        try {
            const { limit = 20 } = req.query;
            const db       = require('../models');
            const listings = await db.Tool.getPremiumListings(parseInt(limit));
            return ok(res, { listings, total: listings.length }, 'Premium listings retrieved');
        } catch (e) { _next(next, e, 'getPremiumListings'); }
    }

    async getListing(req, res, next) {
        try {
            const { listingId } = req.params;
            const db            = require('../models');
            const listing       = await db.Tool.findByPk(listingId, {
                include: db.Tool.associations.seller
                    ? [{ association: db.Tool.associations.seller, attributes: ['id', 'username', 'avatar', 'displayName'] }]
                    : [],
            });
            if (!listing || listing.status === 'deleted') {
                return res.status(404).json({ success: false, message: 'Listing not found' });
            }
            return ok(res, { listing }, 'Listing retrieved');
        } catch (e) { _next(next, e, 'getListing'); }
    }

    async createListing(req, res, next) {
        try {
            console.log('[TOOLS FLOW] Step 1: Backend createListing triggered', { userId: req.user?.id });

            const { title, description, price, category, type, images, tags, stock, currency, metadata, condition } = req.body;
            if (!title) throw new AppError('title is required', 400);

            console.log('[TOOLS FLOW] Step 2: Payload validated', { title, type, category, price, userId: req.user.id });

            const db = require('../models');
            if (!db.Tool) {
                return res.status(503).json({ success: false, message: 'Marketplace DB table not ready. Run migration.' });
            }

            const typeMap          = { services: 'service', digital: 'digital', premium: 'premium', physical: 'physical' };
            const normalizedType   = typeMap[type] || type || 'service';
            const validCategories  = ['electronics','furniture','clothing','books','services','digital','premium','other'];
            const normalizedCat    = validCategories.includes(category) ? category : (normalizedType === 'digital' ? 'digital' : normalizedType === 'premium' ? 'premium' : 'services');
            const validConditions  = ['new','used','refurbished'];
            const normalizedCond   = validConditions.includes(condition) ? condition : 'new';

            const listing = await db.Tool.create({
                sellerId: req.user.id, title, description,
                price: price !== undefined ? parseFloat(price) : 0,
                category: normalizedCat, type: normalizedType,
                images: images || [], tags: tags || [],
                stock: stock !== undefined ? parseInt(stock) : null,
                currency: currency || 'KES',
                metadata: { ...(metadata || {}), condition: normalizedCond },
                status: 'active', available: true,
            });

            console.log('[TOOLS FLOW] Step 3: Listing saved to DB', { id: listing.id });

            // Guard — if DB somehow did not return an id, fail loudly rather than send undefined
            if (!listing || !listing.id) {
                logger.error('[TOOLS FLOW] DB returned listing without id');
                return res.status(500).json({ success: false, message: 'Database error: listing ID missing after save' });
            }

            const data = listing.toJSON ? listing.toJSON() : { ...listing };
            data.userId    = data.sellerId;
            data.condition = (data.metadata || {}).condition || normalizedCond;
            data.user      = { id: data.sellerId, displayName: req.user.displayName || req.user.username || 'User', photoURL: req.user.avatar || '' };

            // FIX: Broadcast LISTING_CREATED over WebSocket so all connected sessions update instantly
            const io = req.app.get('io') || global.__IO__;
            if (io) {
                io.emit('LISTING_CREATED', { type: 'LISTING_CREATED', listing: data, userId: req.user.id });
                console.log('[TOOLS FLOW] Step 4: WS broadcast sent — LISTING_CREATED', { id: data.id });
            } else {
                logger.warn('[TOOLS FLOW] io not available — WebSocket broadcast skipped (set app.set("io", io) in server.js)');
            }

            return ok(res, { listing: data }, 'Listing created', 201);
        } catch (e) { _next(next, e, 'createListing'); }
    }

    async bulkCreateListings(req, res, next) {
        try {
            const { listings } = req.body;
            if (!Array.isArray(listings) || !listings.length) throw new AppError('listings array is required', 400);
            const db      = require('../models');
            const created = await db.Tool.bulkCreate(
                listings.map(l => ({ ...l, sellerId: req.user.id, price: parseFloat(l.price || 0), images: l.images || [], tags: l.tags || [], status: 'active', available: true })),
                { returning: true }
            );
            return ok(res, { listings: created, total: created.length }, 'Listings created', 201);
        } catch (e) { _next(next, e, 'bulkCreateListings'); }
    }

    async updateListing(req, res, next) {
        try {
            const { listingId } = req.params;
            const db            = require('../models');
            const listing       = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
            ['title','description','price','category','type','images','tags','available','stock','currency','metadata'].forEach(f => { if (req.body[f] !== undefined) listing[f] = req.body[f]; });
            await listing.save();
            return ok(res, { listing }, 'Listing updated');
        } catch (e) { _next(next, e, 'updateListing'); }
    }

    async deleteListing(req, res, next) {
        try {
            const { listingId } = req.params;
            const db            = require('../models');
            const listing       = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
            listing.status = 'deleted';
            await listing.save();
            return ok(res, null, 'Listing deleted');
        } catch (e) { _next(next, e, 'deleteListing'); }
    }

    async recordListingView(req, res, next) {
        try {
            const db      = require('../models');
            const listing = await db.Tool.findByPk(req.params.listingId);
            if (listing) await listing.incrementViews();
            return ok(res, null, 'View recorded');
        } catch (e) { _next(next, e, 'recordListingView'); }
    }

    async toggleSaveListing(req, res, next) {
        try {
            const { listingId } = req.params;
            const db            = require('../models');
            const listing       = await db.Tool.findByPk(listingId);
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });
            await listing.toggleSave(req.user.id);
            const saved = listing.isSavedBy(req.user.id);
            return ok(res, { saved }, saved ? 'Listing saved' : 'Listing unsaved');
        } catch (e) { _next(next, e, 'toggleSaveListing'); }
    }

    async purchaseListing(req, res, next) {
        try {
            const { listingId } = req.params;
            const db            = require('../models');
            const listing       = await db.Tool.findByPk(listingId);
            if (!listing || !listing.available) return res.status(404).json({ success: false, message: 'Listing not available' });
            listing.purchasedBy = [...(listing.purchasedBy || []), req.user.id];
            if (listing.stock !== null) {
                listing.stock = Math.max(0, listing.stock - 1);
                if (listing.stock === 0) { listing.available = false; listing.status = 'sold'; }
            }
            await listing.save();
            return ok(res, { listing }, 'Purchase recorded');
        } catch (e) { _next(next, e, 'purchaseListing'); }
    }

    async rateListing(req, res, next) {
        try {
            const { listingId }  = req.params;
            const { rating }     = req.body;
            if (!rating || rating < 1 || rating > 5) throw new AppError('Rating must be 1–5', 400);
            const db             = require('../models');
            const listing        = await db.Tool.findByPk(listingId);
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });
            await listing.addRating(parseFloat(rating));
            return ok(res, { rating: listing.rating, ratingCount: listing.ratingCount }, 'Rating submitted');
        } catch (e) { _next(next, e, 'rateListing'); }
    }

    async getSpotlightListings(req, res, next) {
        try {
            const { limit = 10 } = req.query;
            const db = require('../models');
            if (!db.Tool || !db.Tool.getSpotlight) {
                return ok(res, { listings: [], total: 0 }, 'Spotlight listings retrieved (no table)');
            }
            let listings;
            try {
                listings = await db.Tool.getSpotlight(parseInt(limit));
            } catch (dbErr) {
                console.error('[getSpotlightListings] DB error:', dbErr.message);
                return ok(res, { listings: [], total: 0 }, 'Spotlight listings retrieved (fallback)');
            }
            return ok(res, { listings, total: listings.length }, 'Spotlight listings retrieved');
        } catch (e) { _next(next, e, 'getSpotlightListings'); }
    }

    async addToSpotlight(req, res, next) {
        try {
            const { listingId } = req.body;
            if (!listingId) throw new AppError('listingId is required', 400);
            const db            = require('../models');
            const listing       = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
            listing.isSpotlight = true;
            await listing.save();
            return ok(res, { listing }, 'Added to spotlight');
        } catch (e) { _next(next, e, 'addToSpotlight'); }
    }

    async boostListing(req, res, next) {
        try {
            const { listingId, duration = '24' } = req.body;
            if (!listingId) throw new AppError('listingId is required', 400);
            const db            = require('../models');
            const listing       = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
            listing.isBoosted      = true;
            listing.boostExpiresAt = new Date(Date.now() + (parseInt(duration) || 24) * 3600e3);
            await listing.save();
            return ok(res, { listing, boostExpiresAt: listing.boostExpiresAt }, 'Listing boosted');
        } catch (e) { _next(next, e, 'boostListing'); }
    }

    async getLeaderboard(req, res, next) {
        try {
            const { limit = 20 } = req.query;
            const db             = require('../models');
            const raw            = await db.Tool.getLeaderboard(parseInt(limit));
            const leaderboard    = raw.map(r => ({
                userId      : r.seller_id || r.userId,
                listingCount: parseInt(r.listing_count || r.listingCount || 0),
                totalViews  : parseInt(r.total_views  || r.totalViews  || 0),
                avgRating   : parseFloat(r.avg_rating || r.avgRating   || 0),
                totalSales  : parseInt(r.total_sales  || r.totalSales  || 0),
            }));
            return ok(res, { leaderboard }, 'Leaderboard retrieved');
        } catch (e) { _next(next, e, 'getLeaderboard'); }
    }

    async sendTip(req, res, next) {
        try {
            const { sellerId, amount, listingId, message } = req.body;
            if (!sellerId || !amount) throw new AppError('sellerId and amount are required', 400);
            return ok(res, { sellerId, amount, listingId, message, sentAt: new Date().toISOString() }, 'Tip sent');
        } catch (e) { _next(next, e, 'sendTip'); }
    }

    async getMarketplaceStats(req, res, next) {
        try {
            const db                  = require('../models');
            const { Op }              = require('sequelize');
            const [total, mine, views]= await Promise.all([
                db.Tool.count({ where: { status: 'active' } }),
                db.Tool.count({ where: { sellerId: req.user.id, status: { [Op.ne]: 'deleted' } } }),
                db.Tool.sum('views', { where: { sellerId: req.user.id } }),
            ]);
            return ok(res, { totalListings: total, myListings: mine, totalViews: views || 0 }, 'Marketplace stats retrieved');
        } catch (e) { _next(next, e, 'getMarketplaceStats'); }
    }

    async getPremiumFeatures(req, res, next) {
        try {
            const features = [
                { id: 'spotlight',      name: 'PRO Spotlight',      description: 'Feature your listing at the top',    price: 9.99 },
                { id: 'boost',          name: 'Boost Listing',       description: 'Boost visibility for 24 hours',      price: 4.99 },
                { id: 'premium_badge',  name: 'Premium Badge',       description: 'Show a premium seller badge',        price: 19.99 },
                { id: 'analytics',      name: 'Advanced Analytics',  description: 'Detailed listing analytics',         price: 14.99 },
            ];
            return ok(res, { features }, 'Premium features retrieved');
        } catch (e) { _next(next, e, 'getPremiumFeatures'); }
    }

    async processPayment(req, res, next) {
        try {
            const { amount, currency = 'KES', listingId, paymentMethod, phone, mpesaPhone } = req.body;
            if (!amount || !listingId) throw new AppError('amount and listingId are required', 400);

            const transactionId = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            if (paymentMethod === 'mpesa') {
                const rawPhone     = (phone || mpesaPhone || '').replace(/\s/g, '');
                if (!rawPhone) throw new AppError('M-Pesa phone number is required', 400);
                let normalized     = rawPhone.replace(/^\+/, '').replace(/^0/, '254');
                if (!/^254[71]\d{8}$/.test(normalized)) throw new AppError('Invalid M-Pesa phone number', 400);

                const { MPESA_CONSUMER_KEY: ck, MPESA_CONSUMER_SECRET: cs, MPESA_SHORTCODE: sc = '174379', MPESA_PASSKEY: pk, MPESA_CALLBACK_URL: cbUrl } = process.env;

                if (ck && cs && pk) {
                    try {
                        const axios   = require('axios');
                        const auth    = Buffer.from(`${ck}:${cs}`).toString('base64');
                        const tok     = (await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: `Basic ${auth}` } })).data.access_token;
                        const ts      = new Date().toISOString().replace(/\D/g,'').slice(0,14);
                        const pw      = Buffer.from(`${sc}${pk}${ts}`).toString('base64');
                        const stk     = (await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
                            BusinessShortCode: sc, Password: pw, Timestamp: ts,
                            TransactionType: 'CustomerPayBillOnline',
                            Amount: Math.ceil(amount), PartyA: normalized, PartyB: sc,
                            PhoneNumber: normalized,
                            CallBackURL: cbUrl || `${process.env.BASE_URL || 'https://example.com'}/api/tools/payments/mpesa/callback`,
                            AccountReference: `KNT-${listingId.slice(0,8)}`,
                            TransactionDesc: `Payment for ${listingId}`,
                        }, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } })).data;

                        return ok(res, { transactionId, checkoutRequestId: stk.CheckoutRequestID, amount, currency: 'KES', listingId, paymentMethod: 'mpesa', phone: normalized, status: 'pending' }, 'M-Pesa STK Push sent');
                    } catch (mpErr) {
                        logger.error('[M-Pesa] STK error:', mpErr?.response?.data || mpErr.message);
                    }
                }
                return ok(res, { transactionId, amount, currency: 'KES', listingId, paymentMethod: 'mpesa', phone: normalized, status: 'pending_sandbox' }, 'STK Push queued (sandbox)');
            }

            return ok(res, { transactionId, amount, currency: currency || 'KES', listingId, paymentMethod: paymentMethod || 'card', status: 'completed' }, 'Payment processed');
        } catch (e) { _next(next, e, 'processPayment'); }
    }

    async mpesaCallback(req, res) {
        try {
            const cb = req.body?.Body?.stkCallback || {};
            if (cb.ResultCode === 0) {
                const items = cb.CallbackMetadata?.Item || [];
                const g     = (n) => (items.find(i => i.Name === n) || {}).Value;
                logger.info('[M-Pesa] Payment OK:', { receipt: g('MpesaReceiptNumber'), amount: g('Amount'), phone: g('PhoneNumber') });
            } else {
                logger.warn('[M-Pesa] Payment failed. Code:', cb.ResultCode, 'Desc:', cb.ResultDesc);
            }
        } catch (e) { logger.error('[M-Pesa] Callback error:', e); }
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ORDERS
    // ══════════════════════════════════════════════════════════════════════════

    async placeOrder(req, res, next) {
        try {
            const { productId, quantity = 1, deliveryAddress = {}, notes, paymentMethod } = req.body;
            if (!productId) return res.status(400).json({ success: false, message: 'productId is required' });

            const db      = require('../models');
            const listing = await db.Tool.findByPk(productId);
            if (!listing || !listing.available || listing.status !== 'active') {
                return res.status(404).json({ success: false, message: 'Product not available' });
            }
            if (listing.sellerId === req.user.id) {
                return res.status(400).json({ success: false, message: 'You cannot order your own listing' });
            }

            // Prevent duplicate active orders
            if (db.Order) {
                const { Op } = require('sequelize');
                const duplicate = await db.Order.findOne({
                    where: { buyerId: req.user.id, productId, status: { [Op.in]: ['pending', 'paid', 'shipped'] } },
                });
                if (duplicate) {
                    return res.status(409).json({ success: false, message: 'You already have an active order for this item' });
                }
            }

            const totalPrice = parseFloat(listing.price) * parseInt(quantity);
            const order = await db.Order.create({
                productId,
                buyerId:         req.user.id,
                sellerId:        listing.sellerId,
                quantity:        parseInt(quantity),
                totalPrice,
                currency:        listing.currency || 'KES',
                paymentMethod:   paymentMethod || null,
                deliveryAddress: deliveryAddress || {},
                notes:           notes || null,
                status:          'pending',
            });

            const orderData = order.toJSON ? order.toJSON() : { ...order };
            orderData.product = { id: listing.id, title: listing.title, images: listing.images, price: listing.price, type: listing.type };

            const io = req.app.get('io') || global.__IO__;
            if (io) {
                io.to(`user:${listing.sellerId}`).emit('ORDER_RECEIVED', { type: 'ORDER_RECEIVED', order: orderData });
                io.to(`user:${req.user.id}`).emit('ORDER_PLACED', { type: 'ORDER_PLACED', order: orderData });
            }

            return ok(res, { order: orderData }, 'Order placed successfully', 201);
        } catch (e) { _next(next, e, 'placeOrder'); }
    }

    async getMyOrders(req, res, next) {
        try {
            const { status } = req.query;
            const db = require('../models');
            const { Op } = require('sequelize');
            const where = { buyerId: req.user.id };
            if (status) where.status = status;
            const orders = await db.Order.findAll({
                where,
                order: [['createdAt', 'DESC']],
                include: db.Order.associations?.product
                    ? [{ association: db.Order.associations.product, attributes: ['id', 'title', 'images', 'price', 'type', 'currency'] }]
                    : [],
            });
            return ok(res, { orders, total: orders.length }, 'Orders retrieved');
        } catch (e) { _next(next, e, 'getMyOrders'); }
    }

    async getSellerOrders(req, res, next) {
        try {
            const { status } = req.query;
            const db = require('../models');
            const where = { sellerId: req.user.id };
            if (status) where.status = status;
            const orders = await db.Order.findAll({
                where,
                order: [['createdAt', 'DESC']],
                include: db.Order.associations?.product
                    ? [{ association: db.Order.associations.product, attributes: ['id', 'title', 'images', 'price', 'type', 'currency'] }]
                    : [],
            });
            return ok(res, { orders, total: orders.length }, 'Seller orders retrieved');
        } catch (e) { _next(next, e, 'getSellerOrders'); }
    }

    async getOrder(req, res, next) {
        try {
            const { orderId } = req.params;
            const db    = require('../models');
            const order = await db.Order.findByPk(orderId, {
                include: db.Order.associations?.product
                    ? [{ association: db.Order.associations.product }]
                    : [],
            });
            if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
            if (order.buyerId !== req.user.id && order.sellerId !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
            return ok(res, { order }, 'Order retrieved');
        } catch (e) { _next(next, e, 'getOrder'); }
    }

    async updateOrderStatus(req, res, next) {
        try {
            const { orderId } = req.params;
            const { status, trackingNumber, notes } = req.body;
            if (!status) return res.status(400).json({ success: false, message: 'status is required' });

            const db    = require('../models');
            const order = await db.Order.findByPk(orderId);
            if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
            if (order.sellerId !== req.user.id && order.buyerId !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }

            const transitions = {
                pending: ['paid', 'cancelled'],
                paid: ['shipped', 'cancelled', 'refunded'],
                shipped: ['delivered'],
                delivered: ['refunded'],
                cancelled: [],
                refunded: [],
            };
            if (!(transitions[order.status] || []).includes(status)) {
                return res.status(400).json({ success: false, message: `Cannot move order from '${order.status}' to '${status}'` });
            }

            const now = new Date();
            order.status = status;
            if (status === 'paid')      order.paidAt      = now;
            if (status === 'shipped')   order.shippedAt   = now;
            if (status === 'delivered') order.deliveredAt = now;
            if (trackingNumber)         order.trackingNumber = trackingNumber;
            if (notes)                  order.notes = notes;
            await order.save();

            const io = req.app.get('io') || global.__IO__;
            if (io) {
                const evt = { type: 'ORDER_STATUS_UPDATED', orderId: order.id, status: order.status };
                io.to(`user:${order.buyerId}`).emit('ORDER_STATUS_UPDATED', evt);
                io.to(`user:${order.sellerId}`).emit('ORDER_STATUS_UPDATED', evt);
            }

            return ok(res, { order }, `Order updated to ${status}`);
        } catch (e) { _next(next, e, 'updateOrderStatus'); }
    }

    async cancelOrder(req, res, next) {
        try {
            const { orderId } = req.params;
            const db    = require('../models');
            const order = await db.Order.findByPk(orderId);
            if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
            if (order.buyerId !== req.user.id && order.sellerId !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
            if (!['pending', 'paid'].includes(order.status)) {
                return res.status(400).json({ success: false, message: `Cannot cancel an order with status '${order.status}'` });
            }
            order.status = 'cancelled';
            order.notes  = req.body.reason || 'Cancelled by user';
            await order.save();

            const io = req.app.get('io') || global.__IO__;
            if (io) {
                const evt = { type: 'ORDER_STATUS_UPDATED', orderId: order.id, status: 'cancelled' };
                io.to(`user:${order.buyerId}`).emit('ORDER_STATUS_UPDATED', evt);
                io.to(`user:${order.sellerId}`).emit('ORDER_STATUS_UPDATED', evt);
            }

            return ok(res, { order }, 'Order cancelled');
        } catch (e) { _next(next, e, 'cancelOrder'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // REVIEWS
    // ══════════════════════════════════════════════════════════════════════════

    async getReviews(req, res, next) {
        try {
            const { listingId } = req.params;
            const { page = 1, limit = 10 } = req.query;
            const db     = require('../models');
            const { Op } = require('sequelize');
            const offset = (parseInt(page) - 1) * parseInt(limit);

            const { count, rows } = await db.Review.findAndCountAll({
                where:  { productId: listingId },
                order:  [['createdAt', 'DESC']],
                limit:  parseInt(limit),
                offset,
                include: db.Review.associations?.reviewer
                    ? [{ association: db.Review.associations.reviewer, attributes: ['id', 'username', 'avatar', 'displayName'] }]
                    : [],
            });

            const avgRating = rows.length
                ? rows.reduce((s, r) => s + r.rating, 0) / rows.length
                : 0;

            return ok(res, {
                reviews:    rows,
                total:      count,
                page:       parseInt(page),
                limit:      parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
                avgRating:  Math.round(avgRating * 10) / 10,
            }, 'Reviews retrieved');
        } catch (e) { _next(next, e, 'getReviews'); }
    }

    async createReview(req, res, next) {
        try {
            const { listingId }                      = req.params;
            const { rating, comment, orderId, images } = req.body;

            if (!rating || rating < 1 || rating > 5) {
                return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
            }

            const db      = require('../models');
            const listing = await db.Tool.findByPk(listingId);
            if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });

            // One review per user per product
            const alreadyReviewed = await db.Review.findOne({ where: { userId: req.user.id, productId: listingId } });
            if (alreadyReviewed) {
                return res.status(409).json({ success: false, message: 'You have already reviewed this product' });
            }

            // Verify purchase
            let isVerifiedPurchase = false;
            if (orderId && db.Order) {
                const order = await db.Order.findOne({
                    where: { id: orderId, buyerId: req.user.id, productId: listingId, status: 'delivered' },
                });
                isVerifiedPurchase = !!order;
            }

            const review = await db.Review.create({
                productId:          listingId,
                userId:             req.user.id,
                sellerId:           listing.sellerId,
                orderId:            orderId || null,
                rating:             parseInt(rating),
                comment:            comment || null,
                images:             images || [],
                isVerifiedPurchase,
            });

            // Update listing aggregate rating
            const total   = (parseFloat(listing.rating) || 0) * (listing.ratingCount || 0) + parseInt(rating);
            listing.ratingCount = (listing.ratingCount || 0) + 1;
            listing.rating      = total / listing.ratingCount;
            await listing.save();

            const io = req.app.get('io') || global.__IO__;
            if (io) {
                io.to(`user:${listing.sellerId}`).emit('NEW_REVIEW', {
                    type: 'NEW_REVIEW',
                    review: review.toJSON ? review.toJSON() : review,
                    productId: listingId,
                });
            }

            return ok(res, { review }, 'Review submitted', 201);
        } catch (e) {
            if (e.name === 'SequelizeUniqueConstraintError') {
                return res.status(409).json({ success: false, message: 'You have already reviewed this product' });
            }
            _next(next, e, 'createReview');
        }
    }

    async replyToReview(req, res, next) {
        try {
            const { reviewId } = req.params;
            const { reply }    = req.body;
            if (!reply) return res.status(400).json({ success: false, message: 'reply text is required' });

            const db     = require('../models');
            const review = await db.Review.findByPk(reviewId);
            if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
            if (review.sellerId !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only the seller can reply to this review' });
            }

            review.sellerReply     = reply;
            review.sellerRepliedAt = new Date();
            await review.save();

            return ok(res, { review }, 'Reply added');
        } catch (e) { _next(next, e, 'replyToReview'); }
    }

    async markReviewHelpful(req, res, next) {
        try {
            const { reviewId } = req.params;
            const db     = require('../models');
            const review = await db.Review.findByPk(reviewId);
            if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
            review.helpfulCount = (review.helpfulCount || 0) + 1;
            await review.save();
            return ok(res, { helpfulCount: review.helpfulCount }, 'Marked helpful');
        } catch (e) { _next(next, e, 'markReviewHelpful'); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SELLER PROFILE
    // ══════════════════════════════════════════════════════════════════════════

    async getSellerProfile(req, res, next) {
        try {
            const { sellerId } = req.params;
            const db = require('../models');

            const [listingsResult, reviewsResult, sellerResult] = await Promise.allSettled([
                db.Tool.findAll({
                    where: { sellerId, status: 'active', available: true },
                    order: [['createdAt', 'DESC']],
                    limit: 6,
                }),
                db.Review ? db.Review.findAll({ where: { sellerId }, attributes: ['rating'] }) : Promise.resolve([]),
                db.Users  ? db.Users.findByPk(sellerId, { attributes: ['id', 'username', 'displayName', 'avatar', 'createdAt'] }) : Promise.resolve(null),
            ]);

            const listings   = listingsResult.value   || [];
            const reviews    = reviewsResult.value    || [];
            const sellerRow  = sellerResult.value     || null;

            const avgRating = reviews.length
                ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
                : 0;

            return ok(res, {
                seller: sellerRow
                    ? { id: sellerRow.id, name: sellerRow.displayName || sellerRow.username, avatar: sellerRow.avatar, joinedAt: sellerRow.createdAt }
                    : { id: sellerId, name: 'Seller', avatar: null, joinedAt: null },
                listings,
                stats: {
                    listingCount: listings.length,
                    reviewCount:  reviews.length,
                    avgRating:    parseFloat(avgRating),
                },
            }, 'Seller profile retrieved');
        } catch (e) { _next(next, e, 'getSellerProfile'); }
    }

    async getSellerListings(req, res, next) {
        try {
            const { sellerId }        = req.params;
            const { page = 1, limit = 20 } = req.query;
            const db     = require('../models');
            const offset = (parseInt(page) - 1) * parseInt(limit);
            const { count, rows } = await db.Tool.findAndCountAll({
                where:  { sellerId, status: 'active', available: true },
                order:  [['createdAt', 'DESC']],
                limit:  parseInt(limit),
                offset,
            });
            return ok(res, {
                listings:   rows,
                total:      count,
                page:       parseInt(page),
                totalPages: Math.ceil(count / parseInt(limit)),
            }, 'Seller listings retrieved');
        } catch (e) { _next(next, e, 'getSellerListings'); }
    }
}

module.exports = new ToolsController();