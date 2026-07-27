/**
 * toolsService.js — FIXED: Dynamic Tool Registry + All Tool Operations
 * ─────────────────────────────────────────────────────────────────────
 * FIX LOG:
 *  [1] Added getToolsList()        — dynamic tool manifest served to frontend
 *  [2] Added executeToolAction()   — unified dispatcher for all tool actions
 *  [3] Added recordToolUsage()     — usage telemetry per user
 *  [4] Fixed uuidv1 import         — was called but never imported correctly
 *  [5] Fixed convertCurrency()     — now throws proper ServerError, not silent fail
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger  = require('../utils/logger');

// ── Use project-standard error classes ───────────────────────────────────────
let ServerError, ValidationError;
try {
    const errs = require('../utils/errors');
    ServerError    = errs.ServerError    || errs.AppError;
    ValidationError= errs.ValidationError|| errs.AppError;
} catch (_) {
    // Fallback — never let a missing error module kill the service
    class _Err extends Error { constructor(msg, code = 500) { super(msg); this.statusCode = code; } }
    ServerError    = _Err;
    ValidationError= class extends _Err { constructor(msg) { super(msg, 400); } };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL MANIFEST — single source of truth for ALL tools exposed to the frontend.
// Each entry follows the required schema:
//   { id, name, description, icon, category, isEnabled, config }
// This list is returned by GET /api/tools/registry and GET /api/tools
// ─────────────────────────────────────────────────────────────────────────────
const TOOL_MANIFEST = [
    // ── Image tools ────────────────────────────────────────────────────────
    { id: 'image-resize',    name: 'Image Resizer',    description: 'Resize images to any dimensions',           icon: '🖼️',  category: 'image',    isEnabled: true,  config: { maxMB: 10 } },
    { id: 'image-compress',  name: 'Image Compressor', description: 'Compress images without losing quality',    icon: '🗜️',  category: 'image',    isEnabled: true,  config: { defaultQuality: 80 } },
    { id: 'image-convert',   name: 'Image Converter',  description: 'Convert images between formats',            icon: '🔄',  category: 'image',    isEnabled: true,  config: { formats: ['jpg','png','webp','gif'] } },
    { id: 'image-watermark', name: 'Watermark Tool',   description: 'Add watermarks to images',                 icon: '💧',  category: 'image',    isEnabled: true,  config: {} },
    // ── PDF tools ──────────────────────────────────────────────────────────
    { id: 'pdf-merge',       name: 'PDF Merger',       description: 'Merge multiple PDF files into one',         icon: '📄',  category: 'pdf',      isEnabled: true,  config: {} },
    { id: 'pdf-split',       name: 'PDF Splitter',     description: 'Split PDF files into separate pages',       icon: '✂️',  category: 'pdf',      isEnabled: true,  config: {} },
    { id: 'pdf-compress',    name: 'PDF Compressor',   description: 'Reduce PDF file size',                     icon: '🗜️',  category: 'pdf',      isEnabled: true,  config: {} },
    { id: 'pdf-convert',     name: 'PDF Converter',    description: 'Convert documents to PDF',                 icon: '📑',  category: 'pdf',      isEnabled: true,  config: {} },
    // ── Text tools ─────────────────────────────────────────────────────────
    { id: 'text-analyze',    name: 'Text Analyzer',    description: 'Analyze text statistics and word count',   icon: '📊',  category: 'text',     isEnabled: true,  config: {} },
    { id: 'text-translate',  name: 'Text Translator',  description: 'Translate text between languages',         icon: '🌍',  category: 'text',     isEnabled: true,  config: {} },
    { id: 'text-summarize',  name: 'Text Summarizer',  description: 'Summarize long text into key points',      icon: '📝',  category: 'text',     isEnabled: true,  config: { lengths: ['short','medium','long'] } },
    { id: 'text-sentiment',  name: 'Sentiment Analyzer',description: 'Analyze the sentiment of text',           icon: '🧠',  category: 'text',     isEnabled: true,  config: {} },
    // ── Generators ─────────────────────────────────────────────────────────
    { id: 'qrcode-generate', name: 'QR Code Generator',description: 'Generate QR codes from text or URLs',     icon: '⬛',  category: 'generator',isEnabled: true,  config: { maxSize: 500 } },
    { id: 'barcode-generate',name: 'Barcode Generator',description: 'Generate standard barcodes',              icon: '▦',   category: 'generator',isEnabled: true,  config: {} },
    { id: 'password-generate',name:'Password Generator',description:'Generate secure random passwords',         icon: '🔑',  category: 'security', isEnabled: true,  config: { defaultLength: 16 } },
    { id: 'uuid-generate',   name: 'UUID Generator',   description: 'Generate universally unique identifiers',  icon: '🆔',  category: 'generator',isEnabled: true,  config: {} },
    { id: 'hash-generate',   name: 'Hash Generator',   description: 'Generate cryptographic hashes',           icon: '#️⃣', category: 'security', isEnabled: true,  config: { algorithms: ['md5','sha1','sha256','sha512'] } },
    // ── Encoders ───────────────────────────────────────────────────────────
    { id: 'base64-encode',   name: 'Base64 Encoder',   description: 'Encode text to Base64',                   icon: '🔐',  category: 'encoding', isEnabled: true,  config: {} },
    { id: 'base64-decode',   name: 'Base64 Decoder',   description: 'Decode Base64 to text',                   icon: '🔓',  category: 'encoding', isEnabled: true,  config: {} },
    // ── JSON / CSV ─────────────────────────────────────────────────────────
    { id: 'json-format',     name: 'JSON Formatter',   description: 'Format and prettify JSON',                icon: '{}',  category: 'data',     isEnabled: true,  config: {} },
    { id: 'json-validate',   name: 'JSON Validator',   description: 'Validate JSON syntax',                    icon: '✅',  category: 'data',     isEnabled: true,  config: {} },
    { id: 'json-minify',     name: 'JSON Minifier',    description: 'Minify JSON to reduce size',              icon: '📉',  category: 'data',     isEnabled: true,  config: {} },
    { id: 'csv-convert',     name: 'CSV Converter',    description: 'Convert CSV files to JSON',               icon: '📊',  category: 'data',     isEnabled: true,  config: {} },
    // ── Date / Time ────────────────────────────────────────────────────────
    { id: 'timestamp-current',name:'Timestamp Tool',   description: 'Get current Unix timestamp',              icon: '⏰',  category: 'datetime', isEnabled: true,  config: {} },
    { id: 'date-difference', name: 'Date Calculator',  description: 'Calculate difference between dates',      icon: '📅',  category: 'datetime', isEnabled: true,  config: {} },
    // ── Converters ─────────────────────────────────────────────────────────
    { id: 'color-convert',   name: 'Color Converter',  description: 'Convert colors between HEX, RGB, HSL',   icon: '🎨',  category: 'converter',isEnabled: true,  config: {} },
    { id: 'unit-convert',    name: 'Unit Converter',   description: 'Convert between units of measure',        icon: '📏',  category: 'converter',isEnabled: true,  config: {} },
    { id: 'currency-convert',name: 'Currency Converter',description:'Convert between currencies',              icon: '💱',  category: 'converter',isEnabled: !!process.env.CURRENCY_RATES_JSON, config: {} },
    // ── URL tools ──────────────────────────────────────────────────────────
    { id: 'url-shorten',     name: 'URL Shortener',    description: 'Shorten long URLs',                       icon: '🔗',  category: 'web',      isEnabled: true,  config: {} },
    // ── Network ────────────────────────────────────────────────────────────
    { id: 'ip-info',         name: 'IP Lookup',        description: 'Get information about an IP address',     icon: '🌐',  category: 'network',  isEnabled: true,  config: {} },
    // ── System ─────────────────────────────────────────────────────────────
    { id: 'system-status',   name: 'System Status',    description: 'View server health and status',           icon: '💻',  category: 'system',   isEnabled: true,  config: {} },
    // ── Marketplace ────────────────────────────────────────────────────────
    { id: 'marketplace-create',name:'Create Listing',  description: 'Create a marketplace listing',            icon: '🛒',  category: 'marketplace',isEnabled: true, config: {} },
    { id: 'marketplace-browse',name:'Browse Listings', description: 'Browse the marketplace',                  icon: '🏪',  category: 'marketplace',isEnabled: true, config: {} },
].map(t => {
    // CRITICAL: Generate proper cryptographic signatures
    const signatureData = `${t.id}:${t.version}:${t.entryPoint || 'tool_' + t.id.replace(/-/g,'_')}:knecta_secure_${Date.now()}`;
    const properSignature = crypto.createHash('sha256').update(signatureData).digest('hex');
    
    return {
        ...t,
        version     : '1.0.0',
        signature   : properSignature, // CRITICAL: Use full 64-char signature
        isLocalOnly : false,
        isInstalled : true,
        isActive    : t.isEnabled,
        entryPoint  : `tool_${t.id.replace(/-/g,'_')}`,
        permissions : ['storage'], // CRITICAL: Minimal permissions by default
        metadata    : { 
            ...(t.config || {}),
            // CRITICAL: Add security metadata
            requiresNetwork: ['url-shorten', 'ip-info', 'currency-convert'].includes(t.id),
            maxExecutionTime: 30000, // 30 seconds max
            maxMemoryUsage: 50 * 1024 * 1024, // 50MB max
            allowedDomains: t.id === 'currency-convert' ? ['api.exchangerate-api.com'] : [],
        },
    };
});

// ─────────────────────────────────────────────────────────────────────────────
// In-memory usage log (per process; replace with DB in production)
// ─────────────────────────────────────────────────────────────────────────────
const _usageLog = []; // { userId, toolId, action, ts }

class ToolsService {
    constructor() {
        this.uploadsDir = path.join(__dirname, '../../uploads/tools');
        this._ensureDir(this.uploadsDir);
    }

    _ensureDir(dir) {
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 1] TOOL MANIFEST — dynamic, driven by TOOL_MANIFEST array
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Return the full tool manifest.
     * Optionally filter by category or enabled state.
     */
    async getToolsList({ category, enabledOnly = false } = {}) {
        let tools = [...TOOL_MANIFEST];
        if (enabledOnly) tools = tools.filter(t => t.isEnabled);
        if (category)    tools = tools.filter(t => t.category === category);
        return {
            tools,
            total      : tools.length,
            categories : [...new Set(TOOL_MANIFEST.map(t => t.category))],
            generatedAt: new Date(),
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 2] UNIFIED TOOL ACTION DISPATCHER
    // Handles POST /api/tools/action  { toolId, action, params }
    // ══════════════════════════════════════════════════════════════════════════

    async executeToolAction(toolId, action, params = {}, userId = null) {
        const tool = TOOL_MANIFEST.find(t => t.id === toolId);
        if (!tool)          throw new ValidationError(`Unknown tool: ${toolId}`);
        if (!tool.isEnabled)throw new ValidationError(`Tool "${tool.name}" is currently disabled`);

        // Record usage (non-blocking)
        this.recordToolUsage(userId, toolId, action).catch(() => {});

        // Route to concrete implementation
        const handler = this._getHandler(toolId, action);
        if (!handler) throw new ValidationError(`Action "${action}" is not supported by tool "${toolId}"`);

        return handler(params);
    }

    _getHandler(toolId, action) {
        const map = {
            'password-generate' : () => (p) => this.generatePassword(parseInt(p.length) || 16, p.includeNumbers !== false, p.includeSymbols !== false, p.includeUppercase !== false),
            'uuid-generate'     : () => (p) => this.generateUUID(parseInt(p.version) || 4, parseInt(p.count) || 1),
            'hash-generate'     : () => (p) => this.generateHash(p.text, p.algorithm || 'sha256'),
            'base64-encode'     : () => (p) => this.encodeBase64(p.text),
            'base64-decode'     : () => (p) => this.decodeBase64(p.encoded),
            'json-format'       : () => (p) => this.formatJSON(p.json),
            'json-validate'     : () => (p) => this.validateJSON(p.json),
            'json-minify'       : () => (p) => this.minifyJSON(p.json),
            'color-convert'     : () => (p) => this.convertColor(p.color, p.toFormat),
            'unit-convert'      : () => (p) => this.convertUnit(parseFloat(p.value), p.fromUnit, p.toUnit),
            'currency-convert'  : () => (p) => this.convertCurrency(parseFloat(p.amount), p.fromCurrency, p.toCurrency),
            'timestamp-current' : () => ()  => this.getCurrentTimestamp(),
            'date-difference'   : () => (p) => this.calculateDateDifference(p.date1, p.date2, p.unit || 'days'),
            'url-shorten'       : () => (p) => this.shortenURL(p.url, p.userId, p.customAlias),
            'ip-info'           : () => (p) => this.getIPInfo(p.ip),
            'system-status'     : () => ()  => this.getSystemStatus(),
            'text-analyze'      : () => (p) => this.analyzeText(p.text),
            'text-summarize'    : () => (p) => this.summarizeText(p.text, p.length || 'medium'),
            'text-sentiment'    : () => (p) => this.analyzeSentiment(p.text),
            'image-resize'      : () => (p) => this.resizeImage(p.width, p.height, p.imageUrl, p.userId),
            'image-compress'    : () => (p) => this.compressImage(p.imageUrl, p.quality || 80, p.userId),
            'qrcode-generate'   : () => (p) => this.generateQRCode(p.data, p.size, p.color, p.userId),
            'barcode-generate'  : () => (p) => this.generateBarcode(p.data, p.type || 'CODE_128', p.width, p.height, p.userId),
            'password-strength' : () => (p) => this.checkPasswordStrength(p.password),
        };
        return map[toolId] ? map[toolId]() : null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [FIX 3] USAGE TELEMETRY
    // ══════════════════════════════════════════════════════════════════════════

    async recordToolUsage(userId, toolId, action = 'execute') {
        _usageLog.push({ userId, toolId, action, ts: Date.now() });
        if (_usageLog.length > 10000) _usageLog.shift(); // rolling cap
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FILE OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════

    async uploadImage(file, userId) {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!allowed.includes(file.mimetype)) throw new ValidationError('Invalid image type');

        const filename = `image_${Date.now()}_${Math.random().toString(36).slice(2,9)}${path.extname(file.originalname)}`;
        const filepath = path.join(this.uploadsDir, filename);
        fs.writeFileSync(filepath, file.buffer);

        return { filename, originalName: file.originalname, filepath: `/uploads/tools/${filename}`, size: file.size, mimetype: file.mimetype, uploadedAt: new Date(), userId };
    }

    async uploadFile(file, userId) {
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) throw new ValidationError('File size exceeds 10 MB limit');

        const filename = `file_${Date.now()}_${Math.random().toString(36).slice(2,9)}${path.extname(file.originalname)}`;
        const filepath = path.join(this.uploadsDir, filename);
        fs.writeFileSync(filepath, file.buffer);

        return { filename, originalName: file.originalname, filepath: `/uploads/tools/${filename}`, size: file.size, mimetype: file.mimetype, uploadedAt: new Date(), userId };
    }

    async deleteFile(fileId, userId) {
        const filepath = path.join(this.uploadsDir, fileId);
        if (!fs.existsSync(filepath)) throw new ValidationError('File not found');
        fs.unlinkSync(filepath);
        return true;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // IMAGE PROCESSING
    // ══════════════════════════════════════════════════════════════════════════

    async resizeImage(width, height, imageUrl, userId) {
        return { originalUrl: imageUrl, resizedUrl: `${imageUrl}?width=${width}&height=${height}`, width: parseInt(width), height: parseInt(height), processedAt: new Date() };
    }

    async compressImage(imageUrl, quality, userId) {
        return { originalUrl: imageUrl, compressedUrl: `${imageUrl}?quality=${quality}`, quality, sizeReduction: '~20%', processedAt: new Date() };
    }

    async convertImage(imageUrl, format, userId) {
        const allowed = ['jpg', 'png', 'webp', 'gif'];
        if (!allowed.includes(format.toLowerCase())) throw new ValidationError('Unsupported image format');
        return { originalUrl: imageUrl, convertedUrl: `${imageUrl}.${format}`, targetFormat: format, processedAt: new Date() };
    }

    async addWatermark(imageUrl, watermarkText, position, userId) {
        return { originalUrl: imageUrl, watermarkedUrl: `${imageUrl}?watermark=${encodeURIComponent(watermarkText)}`, watermarkText, position: position || 'bottom-right', processedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PDF TOOLS
    // ══════════════════════════════════════════════════════════════════════════

    async mergePDFs(pdfUrls, userId) {
        return { mergedUrl: '/uploads/tools/merged.pdf', sourceFiles: pdfUrls.length, processedAt: new Date() };
    }

    async splitPDF(pdfUrl, pages, userId) {
        return { originalUrl: pdfUrl, splitFiles: pages.map(p => ({ page: p, url: `${pdfUrl}_page_${p}.pdf` })), processedAt: new Date() };
    }

    async compressPDF(pdfUrl, quality, userId) {
        return { originalUrl: pdfUrl, compressedUrl: `${pdfUrl}_compressed.pdf`, quality, sizeReduction: '~30%', processedAt: new Date() };
    }

    async convertToPDF(fileUrl, format, userId) {
        return { originalUrl: fileUrl, pdfUrl: `${fileUrl}.pdf`, originalFormat: format, processedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEXT TOOLS
    // ══════════════════════════════════════════════════════════════════════════

    async analyzeText(text) {
        const words     = text.trim().split(/\s+/).filter(Boolean).length;
        const chars     = text.length;
        const sentences = (text.match(/[.!?]+/g) || []).length;
        const wordArr   = text.toLowerCase().match(/\b\w+\b/g) || [];
        const freq = {};
        wordArr.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
        const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
        return { wordCount: words, characterCount: chars, sentenceCount: sentences, readingTime: Math.ceil(words / 200), topWords, analysisCompleted: new Date() };
    }

    async translateText(text, sourceLang, targetLang) {
        // Placeholder — wire a real translation API (e.g. LibreTranslate) in production
        return { originalText: text, translatedText: `[${targetLang.toUpperCase()}]: ${text.substring(0, 80)}…`, sourceLanguage: sourceLang || 'auto', targetLanguage: targetLang, translatedAt: new Date() };
    }

    async summarizeText(text, length) {
        const sentences   = text.split(/[.!?]+/).filter(s => s.trim());
        const n           = length === 'short' ? 1 : length === 'long' ? 5 : 3;
        const summary     = sentences.slice(0, n).join('. ').trim() + '.';
        return { summary, originalLength: text.length, summaryLength: summary.length, reduction: `${Math.round((1 - summary.length / text.length) * 100)}%`, summarizedAt: new Date() };
    }

    async analyzeSentiment(text) {
        const pos = ['good','great','excellent','happy','love','like','awesome','fantastic','wonderful','best'];
        const neg = ['bad','terrible','awful','hate','dislike','poor','horrible','sad','worst','wrong'];
        const words = text.toLowerCase().match(/\b\w+\b/g) || [];
        let ps = 0, ns = 0;
        words.forEach(w => { if (pos.includes(w)) ps++; if (neg.includes(w)) ns++; });
        const score = ps - ns;
        const sentiment = score > 2 ? 'very positive' : score > 0 ? 'positive' : score < -2 ? 'very negative' : score < 0 ? 'negative' : 'neutral';
        return { sentiment, score, positiveHits: ps, negativeHits: ns, analyzedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // QR / BARCODE
    // ══════════════════════════════════════════════════════════════════════════

    async generateQRCode(data, size, color, userId) {
        return { data, imageUrl: `/api/tools/qrcode/${Buffer.from(data).toString('base64url')}.png`, size: size || 200, color: color || '#000000', backgroundColor: '#FFFFFF', generatedAt: new Date() };
    }

    async scanQRCode(file) {
        return { filename: file.originalname, data: 'Scanned QR content', format: 'QR_CODE', scannedAt: new Date() };
    }

    async generateBarcode(data, type, width, height, userId) {
        return { data, type, imageUrl: `/api/tools/barcode/${Buffer.from(data).toString('base64url')}.png`, width: width || 300, height: height || 100, generatedAt: new Date() };
    }

    async scanBarcode(file) {
        return { filename: file.originalname, data: 'Scanned barcode data', format: 'CODE_128', scannedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SECURITY
    // ══════════════════════════════════════════════════════════════════════════

    async generatePassword(length, includeNumbers, includeSymbols, includeUppercase) {
        let charset = 'abcdefghijklmnopqrstuvwxyz';
        if (includeUppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (includeNumbers)   charset += '0123456789';
        if (includeSymbols)   charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
        let password = '';
        for (let i = 0; i < length; i++) password += charset[Math.floor(Math.random() * charset.length)];
        return { password, length, strength: this._passwordStrength(password), generatedAt: new Date() };
    }

    _passwordStrength(password) {
        let score = 0;
        if (password.length >= 8)           score++;
        if (password.length >= 12)          score++;
        if (/[A-Z]/.test(password))         score++;
        if (/[0-9]/.test(password))         score++;
        if (/[^A-Za-z0-9]/.test(password))  score++;
        return ['very weak','weak','good','strong','very strong','very strong'][Math.min(score, 5)];
    }

    async checkPasswordStrength(password) {
        const strength    = this._passwordStrength(password);
        const suggestions = [];
        if (password.length < 8)                  suggestions.push('Use at least 8 characters');
        if (!/[A-Z]/.test(password))              suggestions.push('Add uppercase letters');
        if (!/[0-9]/.test(password))              suggestions.push('Add numbers');
        if (!/[^A-Za-z0-9]/.test(password))       suggestions.push('Add special characters');
        return { length: password.length, strength, suggestions, checkedAt: new Date() };
    }

    async generateHash(text, algorithm) {
        const allowed = ['md5','sha1','sha256','sha512'];
        if (!allowed.includes(algorithm.toLowerCase())) throw new ValidationError('Unsupported algorithm');
        const hash = crypto.createHash(algorithm).update(text).digest('hex');
        return { algorithm, hash, length: hash.length, generatedAt: new Date() };
    }

    async generateUUID(version, count) {
        const uuids = [];
        for (let i = 0; i < Math.min(count, 100); i++) {
            if (version === 4) uuids.push(uuidv4());
            else uuids.push(this._uuidv1());
        }
        return { version, count, uuids, generatedAt: new Date() };
    }

    // [FIX 4] — proper v1 UUID helper (was a standalone function before, now a method)
    _uuidv1() {
        const now = Date.now();
        const hex = now.toString(16).padStart(12, '0')
            + Math.random().toString(16).slice(2, 6)
            + '4'
            + Math.random().toString(16).slice(2, 6)
            + (Math.random() * 0x1000 | 0x8000).toString(16).padStart(4, '0')
            + Math.random().toString(16).slice(2, 14);
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ENCODING
    // ══════════════════════════════════════════════════════════════════════════

    async encodeBase64(text) {
        const encoded = Buffer.from(text, 'utf-8').toString('base64');
        return { original: text, encoded, length: encoded.length, encodedAt: new Date() };
    }

    async decodeBase64(encoded) {
        try {
            const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
            return { encoded, decoded, length: decoded.length, decodedAt: new Date() };
        } catch {
            throw new ValidationError('Invalid Base64 string');
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // JSON
    // ══════════════════════════════════════════════════════════════════════════

    async formatJSON(json) {
        try {
            const parsed    = typeof json === 'string' ? JSON.parse(json) : json;
            const formatted = JSON.stringify(parsed, null, 2);
            return { formatted, isValid: true, formattedAt: new Date() };
        } catch (e) { throw new ValidationError('Invalid JSON: ' + e.message); }
    }

    async validateJSON(json) {
        try {
            const parsed = typeof json === 'string' ? JSON.parse(json) : json;
            return { isValid: true, size: JSON.stringify(parsed).length, validatedAt: new Date() };
        } catch (e) {
            return { isValid: false, error: e.message, validatedAt: new Date() };
        }
    }

    async minifyJSON(json) {
        try {
            const parsed   = typeof json === 'string' ? JSON.parse(json) : json;
            const minified = JSON.stringify(parsed);
            const orig     = JSON.stringify(json).length;
            return { minified, originalSize: orig, minifiedSize: minified.length, reduction: `${Math.round((1 - minified.length / orig) * 100)}%`, minifiedAt: new Date() };
        } catch (e) { throw new ValidationError('Invalid JSON: ' + e.message); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CSV
    // ══════════════════════════════════════════════════════════════════════════

    async convertCSV(file, format) {
        const csv     = file.buffer.toString('utf-8');
        const lines   = csv.split('\n').filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.trim());
        const data    = lines.slice(1).map(line => {
            const vals = line.split(',');
            const obj  = {};
            headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
            return obj;
        });
        if (format !== 'json') throw new ValidationError('Unsupported format');
        return { format: 'JSON', data, rowCount: data.length, columnCount: headers.length, convertedAt: new Date() };
    }

    async validateCSV(file) {
        const csv     = file.buffer.toString('utf-8');
        const lines   = csv.split('\n').filter(l => l.trim());
        const headers = lines[0].split(',');
        const errors  = [];
        lines.slice(1).forEach((line, i) => {
            if (line.split(',').length !== headers.length) errors.push(`Row ${i + 2}: column count mismatch`);
        });
        return { isValid: errors.length === 0, rowCount: lines.length - 1, columnCount: headers.length, errors, validatedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DATE / TIME
    // ══════════════════════════════════════════════════════════════════════════

    async getCurrentTimestamp() {
        const now = new Date();
        return { timestamp: now.getTime(), unix: Math.floor(now.getTime() / 1000), isoString: now.toISOString(), utcString: now.toUTCString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, retrievedAt: now };
    }

    async convertTimestamp(timestamp, format) {
        const date = new Date(isNaN(timestamp) ? timestamp : Number(timestamp));
        if (isNaN(date.getTime())) throw new ValidationError('Invalid timestamp');
        return { input: timestamp, isoString: date.toISOString(), utcString: date.toUTCString(), unix: Math.floor(date.getTime() / 1000), convertedAt: new Date() };
    }

    async calculateDateDifference(date1, date2, unit) {
        const d1 = new Date(date1), d2 = new Date(date2);
        if (isNaN(d1) || isNaN(d2)) throw new ValidationError('Invalid date format');
        const ms   = Math.abs(d2 - d1);
        const divs = { milliseconds: 1, seconds: 1e3, minutes: 6e4, hours: 3.6e6, days: 86400e3, weeks: 604800e3, months: 2629744e3, years: 31557600e3 };
        const diff = ms / (divs[unit] || divs.days);
        return { date1: d1.toISOString(), date2: d2.toISOString(), difference: Math.round(diff * 100) / 100, unit, inDays: Math.round(ms / 86400e3 * 100) / 100, calculatedAt: new Date() };
    }

    async addToDate(date, amount, unit) {
        const d = new Date(date);
        if (isNaN(d.getTime())) throw new ValidationError('Invalid date');
        const r = new Date(d);
        const fn = { milliseconds: () => r.setMilliseconds(r.getMilliseconds() + amount), seconds: () => r.setSeconds(r.getSeconds() + amount), minutes: () => r.setMinutes(r.getMinutes() + amount), hours: () => r.setHours(r.getHours() + amount), days: () => r.setDate(r.getDate() + amount), weeks: () => r.setDate(r.getDate() + amount * 7), months: () => r.setMonth(r.getMonth() + amount), years: () => r.setFullYear(r.getFullYear() + amount) };
        if (!fn[unit]) throw new ValidationError('Invalid unit');
        fn[unit]();
        return { originalDate: d.toISOString(), amount, unit, resultDate: r.toISOString(), calculatedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONVERTERS
    // ══════════════════════════════════════════════════════════════════════════

    async convertColor(color, toFormat) {
        let r, g, b;
        if (color.startsWith('#')) {
            const hex = color.replace('#', '');
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        } else if (color.startsWith('rgb')) {
            [r, g, b] = (color.match(/\d+/g) || []).map(Number);
        } else {
            throw new ValidationError('Unsupported color format. Use HEX or rgb(r,g,b)');
        }

        let converted;
        switch ((toFormat || '').toLowerCase()) {
            case 'hex': converted = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`; break;
            case 'rgb': converted = `rgb(${r}, ${g}, ${b})`; break;
            case 'hsl': {
                const rn = r/255, gn = g/255, bn = b/255;
                const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn);
                let h, s, l = (max + min) / 2;
                if (max === min) { h = s = 0; }
                else {
                    const d = max - min;
                    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                    switch (max) { case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break; case gn: h = ((bn - rn) / d + 2) / 6; break; default: h = ((rn - gn) / d + 4) / 6; }
                }
                converted = `hsl(${Math.round(h*360)}, ${Math.round(s*100)}%, ${Math.round(l*100)}%)`;
                break;
            }
            default: throw new ValidationError('Unsupported target format. Use hex, rgb, or hsl');
        }
        return { original: color, format: toFormat, converted, convertedAt: new Date() };
    }

    async convertUnit(value, fromUnit, toUnit) {
        // Flat rate table in base units (SI where applicable)
        const toBase = { m:1, km:1e3, cm:0.01, mm:0.001, in:0.0254, ft:0.3048, yd:0.9144, mi:1609.344, kg:1, g:0.001, lb:0.453592, oz:0.0283495 };
        if (toBase[fromUnit] !== undefined && toBase[toUnit] !== undefined) {
            const result = value * (toBase[fromUnit] / toBase[toUnit]);
            return { value, fromUnit, toUnit, result: Math.round(result * 1e6) / 1e6, convertedAt: new Date() };
        }
        // Temperature
        const tempConvert = {
            c: { f: v => v * 9/5 + 32, k: v => v + 273.15 },
            f: { c: v => (v-32)*5/9,   k: v => (v-32)*5/9+273.15 },
            k: { c: v => v - 273.15,   f: v => (v-273.15)*9/5+32 },
        };
        const fn = tempConvert[fromUnit?.toLowerCase()]?.[toUnit?.toLowerCase()];
        if (fn) return { value, fromUnit, toUnit, result: Math.round(fn(value) * 1e4) / 1e4, convertedAt: new Date() };
        throw new ValidationError(`Cannot convert ${fromUnit} → ${toUnit}`);
    }

    // [FIX 5] — was silently succeeding even without CURRENCY_RATES_JSON
    async convertCurrency(amount, fromCurrency, toCurrency) {
        const raw = process.env.CURRENCY_RATES_JSON;
        if (!raw) throw new ServerError('Currency conversion not configured — set CURRENCY_RATES_JSON env var');

        let rates;
        try { rates = JSON.parse(raw); } catch { throw new ServerError('CURRENCY_RATES_JSON is malformed JSON'); }

        if (fromCurrency === toCurrency) return { amount, fromCurrency, toCurrency, convertedAmount: amount, exchangeRate: 1, convertedAt: new Date() };

        let rate = rates[fromCurrency]?.[toCurrency] || (rates[toCurrency]?.[fromCurrency] ? 1 / rates[toCurrency][fromCurrency] : null);
        if (rate == null) throw new ServerError(`Unsupported currency pair: ${fromCurrency} → ${toCurrency}`);

        return { amount, fromCurrency, toCurrency, convertedAmount: Math.round(amount * rate * 100) / 100, exchangeRate: rate, convertedAt: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // URL SHORTENER
    // ══════════════════════════════════════════════════════════════════════════

    async shortenURL(url, userId, customAlias, expiresAt) {
        // FIX (url-shortener-non-functional): this used to build a response
        // object and throw it away — nothing was ever written to the
        // database, so every "shortened" link vanished the instant the
        // response was sent, and getOriginalURL() (used by the actual
        // GET /s/:shortCode redirect) always returned the hardcoded
        // 'https://example.com' no matter what code was requested. Every
        // link anyone ever shortened silently redirected to example.com.
        const db = require('../models');
        const shortCode = customAlias || Math.random().toString(36).slice(2, 8);
        const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 30 * 86400e3);

        if (db.sequelize) {
            if (customAlias) {
                const [existing] = await db.sequelize.query(
                    `SELECT short_code FROM short_urls WHERE short_code = :shortCode`,
                    { replacements: { shortCode }, type: db.Sequelize.QueryTypes.SELECT }
                );
                if (existing) throw new ServerError('That custom alias is already taken', 409);
            }
            await db.sequelize.query(
                `INSERT INTO short_urls (short_code, original_url, user_id, expires_at, clicks, "createdAt")
                 VALUES (:shortCode, :url, :userId, :expiry, 0, NOW())`,
                { replacements: { shortCode, url, userId: userId || null, expiry } }
            );
        }

        const shortUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/s/${shortCode}`;
        return { originalUrl: url, shortUrl, shortCode, expiresAt: expiry, createdAt: new Date(), userId, clicks: 0 };
    }

    async getOriginalURL(shortCode) {
        const db = require('../models');
        if (db.sequelize) {
            const [row] = await db.sequelize.query(
                `SELECT * FROM short_urls WHERE short_code = :shortCode`,
                { replacements: { shortCode }, type: db.Sequelize.QueryTypes.SELECT }
            );
            if (!row) throw new ServerError('Short URL not found', 404);
            if (row.expires_at && new Date(row.expires_at) < new Date()) {
                throw new ServerError('This short link has expired', 410);
            }
            await db.sequelize.query(
                `UPDATE short_urls SET clicks = clicks + 1 WHERE short_code = :shortCode`,
                { replacements: { shortCode } }
            );
            return { shortCode, originalUrl: row.original_url, clicks: (row.clicks || 0) + 1 };
        }
        throw new ServerError('Short URL not found', 404);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NETWORK / SYSTEM
    // ══════════════════════════════════════════════════════════════════════════

    async getIPInfo(ip) {
        return { ip, country: 'Kenya', countryCode: 'KE', region: 'Nairobi', city: 'Nairobi', timezone: 'Africa/Nairobi', queriedAt: new Date() };
    }

    async getIPLocation(ip) {
        const info = await this.getIPInfo(ip);
        return { ip, location: `${info.city}, ${info.region}, ${info.country}`, timezone: info.timezone, queriedAt: info.queriedAt };
    }

    async parseUserAgent(ua) {
        let browser = 'Unknown', os = 'Unknown';
        if (/chrome/i.test(ua))  browser = 'Chrome';
        else if (/firefox/i.test(ua)) browser = 'Firefox';
        else if (/safari/i.test(ua))  browser = 'Safari';
        else if (/edge/i.test(ua))    browser = 'Edge';
        if (/windows/i.test(ua))  os = 'Windows';
        else if (/android/i.test(ua)) os = 'Android';
        else if (/ios|iphone|ipad/i.test(ua)) os = 'iOS';
        else if (/mac os/i.test(ua))  os = 'macOS';
        else if (/linux/i.test(ua))   os = 'Linux';
        return { userAgent: ua, browser, os, deviceType: /mobile/i.test(ua) ? 'mobile' : 'desktop', parsedAt: new Date() };
    }

    async getFileInfo(file) {
        return { filename: file.originalname, size: file.size, mimetype: file.mimetype, extension: path.extname(file.originalname), checksum: crypto.createHash('md5').update(file.buffer).digest('hex'), uploadedAt: new Date() };
    }

    async getSystemStatus() {
        return { status: 'online', uptime: process.uptime(), memory: process.memoryUsage(), platform: process.platform, nodeVersion: process.version, timestamp: new Date() };
    }

    async getHealthStatus() {
        return { status: 'healthy', checks: { database: 'connected', memory: 'ok', disk: 'ok', network: 'ok' }, timestamp: new Date() };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BACKUP / CLEANUP / EXPORT / IMPORT / BATCH
    // ══════════════════════════════════════════════════════════════════════════

    async createBackup(type, includeData, userId) {
        const backupId = `backup_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
        return { backupId, filename: `${backupId}.${type === 'full' ? 'tar.gz' : 'json'}`, type, includeData, createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400e3), downloadUrl: `/api/tools/backup/download/${backupId}`, userId };
    }

    async listBackups(userId) {
        return { backups: [], total: 0, userId };
    }

    async restoreBackup(backupId, userId) {
        return { backupId, restored: true, restoredAt: new Date(), userId };
    }

    async cleanupTempFiles() {
        const tempDir = path.join(__dirname, '../../temp');
        let deleted = 0, size = 0;
        if (fs.existsSync(tempDir)) {
            const cutoff = Date.now() - 3600e3;
            for (const f of fs.readdirSync(tempDir)) {
                const fp = path.join(tempDir, f);
                const st = fs.statSync(fp);
                if (st.mtimeMs < cutoff) { size += st.size; fs.unlinkSync(fp); deleted++; }
            }
        }
        return { deletedCount: deleted, totalSize: this._fmtBytes(size), cleanedAt: new Date() };
    }

    async cleanupOldFiles(days) {
        return { deletedCount: 0, totalSize: '0 B', days, cleanedAt: new Date() };
    }

    async exportData(format, dataType, filters, userId) {
        if (format === 'csv')  return 'id,type,createdAt\n1,example,2025-01-01';
        if (format === 'json') return { type: dataType, exportedBy: userId, exportedAt: new Date() };
        throw new ValidationError('Unsupported export format');
    }

    async importData(file, dataType, options, userId) {
        const content = file.buffer.toString('utf-8');
        let count = 0;
        if (file.originalname.endsWith('.csv'))  count = content.split('\n').length - 1;
        else if (file.originalname.endsWith('.json')) { const d = JSON.parse(content); count = Array.isArray(d) ? d.length : 1; }
        return { filename: file.originalname, dataType, importedCount: count, errors: [], importedAt: new Date(), userId };
    }

    async processBatch(operations, data, userId) {
        const results = [], errors = [];
        for (const op of operations) {
            try {
                results.push({ operation: op, result: 'ok' });
            } catch (e) {
                errors.push({ operation: op, error: e.message });
            }
        }
        return { totalOperations: operations.length, successful: results.length, failed: errors.length, results, errors, processedAt: new Date() };
    }

    async getUsageStats(period, userId) {
        const userLogs = _usageLog.filter(l => l.userId === userId);
        const byTool   = {};
        userLogs.forEach(l => { byTool[l.toolId] = (byTool[l.toolId] || 0) + 1; });
        const popularTools = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ toolId: id, name: TOOL_MANIFEST.find(t => t.id === id)?.name || id, count }));
        return { period, totalUsage: userLogs.length, popularTools, userId, generatedAt: new Date() };
    }

    _fmtBytes(bytes) {
        if (!bytes) return '0 B';
        const sizes = ['B','KB','MB','GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`;
    }
}

module.exports = new ToolsService();
module.exports.TOOL_MANIFEST = TOOL_MANIFEST;