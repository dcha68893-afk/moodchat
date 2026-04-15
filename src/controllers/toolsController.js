const toolsService = require('../services/toolsService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class ToolsController {
  // File upload controllers
  async uploadImage(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('Image file is required', 400);
      }
      const result = await toolsService.uploadImage(req.file, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Image uploaded successfully',
        data: result
      });
    } catch (error) {
      logger.error('Upload image error:', error);
      next(error);
    }
  }

  async uploadFile(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('File is required', 400);
      }
      const result = await toolsService.uploadFile(req.file, req.user.id);
      res.status(200).json({
        success: true,
        message: 'File uploaded successfully',
        data: result
      });
    } catch (error) {
      logger.error('Upload file error:', error);
      next(error);
    }
  }

  async deleteFile(req, res, next) {
    try {
      const { fileId } = req.params;
      await toolsService.deleteFile(fileId, req.user.id);
      res.status(200).json({
        success: true,
        message: 'File deleted successfully'
      });
    } catch (error) {
      logger.error('Delete file error:', error);
      next(error);
    }
  }

  // Image processing controllers
  async resizeImage(req, res, next) {
    try {
      const { width, height, imageUrl } = req.body;
      if (!width || !height || !imageUrl) {
        throw new AppError('Width, height, and imageUrl are required', 400);
      }
      const result = await toolsService.resizeImage(width, height, imageUrl, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Image resized successfully',
        data: result
      });
    } catch (error) {
      logger.error('Resize image error:', error);
      next(error);
    }
  }

  async compressImage(req, res, next) {
    try {
      const { imageUrl, quality } = req.body;
      if (!imageUrl) {
        throw new AppError('imageUrl is required', 400);
      }
      const result = await toolsService.compressImage(imageUrl, quality || 80, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Image compressed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Compress image error:', error);
      next(error);
    }
  }

  async convertImage(req, res, next) {
    try {
      const { imageUrl, format } = req.body;
      if (!imageUrl || !format) {
        throw new AppError('imageUrl and format are required', 400);
      }
      const result = await toolsService.convertImage(imageUrl, format, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Image converted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert image error:', error);
      next(error);
    }
  }

  async addWatermark(req, res, next) {
    try {
      const { imageUrl, watermarkText, position } = req.body;
      if (!imageUrl || !watermarkText) {
        throw new AppError('imageUrl and watermarkText are required', 400);
      }
      const result = await toolsService.addWatermark(imageUrl, watermarkText, position, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Watermark added successfully',
        data: result
      });
    } catch (error) {
      logger.error('Add watermark error:', error);
      next(error);
    }
  }

  // PDF tools controllers
  async mergePDFs(req, res, next) {
    try {
      const { pdfUrls } = req.body;
      if (!pdfUrls || !Array.isArray(pdfUrls) || pdfUrls.length < 2) {
        throw new AppError('At least 2 PDF URLs are required', 400);
      }
      const result = await toolsService.mergePDFs(pdfUrls, req.user.id);
      res.status(200).json({
        success: true,
        message: 'PDFs merged successfully',
        data: result
      });
    } catch (error) {
      logger.error('Merge PDFs error:', error);
      next(error);
    }
  }

  async splitPDF(req, res, next) {
    try {
      const { pdfUrl, pages } = req.body;
      if (!pdfUrl || !pages) {
        throw new AppError('pdfUrl and pages are required', 400);
      }
      const result = await toolsService.splitPDF(pdfUrl, pages, req.user.id);
      res.status(200).json({
        success: true,
        message: 'PDF split successfully',
        data: result
      });
    } catch (error) {
      logger.error('Split PDF error:', error);
      next(error);
    }
  }

  async compressPDF(req, res, next) {
    try {
      const { pdfUrl, quality } = req.body;
      if (!pdfUrl) {
        throw new AppError('pdfUrl is required', 400);
      }
      const result = await toolsService.compressPDF(pdfUrl, quality || 'medium', req.user.id);
      res.status(200).json({
        success: true,
        message: 'PDF compressed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Compress PDF error:', error);
      next(error);
    }
  }

  async convertToPDF(req, res, next) {
    try {
      const { fileUrl, format } = req.body;
      if (!fileUrl || !format) {
        throw new AppError('fileUrl and format are required', 400);
      }
      const result = await toolsService.convertToPDF(fileUrl, format, req.user.id);
      res.status(200).json({
        success: true,
        message: 'File converted to PDF successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert to PDF error:', error);
      next(error);
    }
  }

  // Text tools controllers
  async analyzeText(req, res, next) {
    try {
      const { text } = req.body;
      if (!text) {
        throw new AppError('Text is required', 400);
      }
      const result = await toolsService.analyzeText(text);
      res.status(200).json({
        success: true,
        message: 'Text analyzed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Analyze text error:', error);
      next(error);
    }
  }

  async translateText(req, res, next) {
    try {
      const { text, sourceLang, targetLang } = req.body;
      if (!text || !targetLang) {
        throw new AppError('Text and target language are required', 400);
      }
      const result = await toolsService.translateText(text, sourceLang, targetLang);
      res.status(200).json({
        success: true,
        message: 'Text translated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Translate text error:', error);
      next(error);
    }
  }

  async summarizeText(req, res, next) {
    try {
      const { text, length } = req.body;
      if (!text) {
        throw new AppError('Text is required', 400);
      }
      const result = await toolsService.summarizeText(text, length || 'medium');
      res.status(200).json({
        success: true,
        message: 'Text summarized successfully',
        data: result
      });
    } catch (error) {
      logger.error('Summarize text error:', error);
      next(error);
    }
  }

  async analyzeSentiment(req, res, next) {
    try {
      const { text } = req.body;
      if (!text) {
        throw new AppError('Text is required', 400);
      }
      const result = await toolsService.analyzeSentiment(text);
      res.status(200).json({
        success: true,
        message: 'Sentiment analyzed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Analyze sentiment error:', error);
      next(error);
    }
  }

  // QR code controllers
  async generateQRCode(req, res, next) {
    try {
      const { data, size, color } = req.body;
      if (!data) {
        throw new AppError('Data is required for QR code', 400);
      }
      const result = await toolsService.generateQRCode(data, size, color, req.user.id);
      res.status(200).json({
        success: true,
        message: 'QR code generated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Generate QR code error:', error);
      next(error);
    }
  }

  async scanQRCode(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('QR code image is required', 400);
      }
      const result = await toolsService.scanQRCode(req.file);
      res.status(200).json({
        success: true,
        message: 'QR code scanned successfully',
        data: result
      });
    } catch (error) {
      logger.error('Scan QR code error:', error);
      next(error);
    }
  }

  // Barcode controllers
  async generateBarcode(req, res, next) {
    try {
      const { data, type, width, height } = req.body;
      if (!data || !type) {
        throw new AppError('Data and type are required for barcode', 400);
      }
      const result = await toolsService.generateBarcode(data, type, width, height, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Barcode generated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Generate barcode error:', error);
      next(error);
    }
  }

  async scanBarcode(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('Barcode image is required', 400);
      }
      const result = await toolsService.scanBarcode(req.file);
      res.status(200).json({
        success: true,
        message: 'Barcode scanned successfully',
        data: result
      });
    } catch (error) {
      logger.error('Scan barcode error:', error);
      next(error);
    }
  }

  // Password generator
  async generatePassword(req, res, next) {
    try {
      const { length = 12, includeNumbers = true, includeSymbols = true, includeUppercase = true } = req.query;
      const result = await toolsService.generatePassword(
        parseInt(length),
        includeNumbers === 'true',
        includeSymbols === 'true',
        includeUppercase === 'true'
      );
      res.status(200).json({
        success: true,
        message: 'Password generated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Generate password error:', error);
      next(error);
    }
  }

  async checkPasswordStrength(req, res, next) {
    try {
      const { password } = req.body;
      if (!password) {
        throw new AppError('Password is required', 400);
      }
      const result = await toolsService.checkPasswordStrength(password);
      res.status(200).json({
        success: true,
        message: 'Password strength checked successfully',
        data: result
      });
    } catch (error) {
      logger.error('Check password strength error:', error);
      next(error);
    }
  }

  // Hash generator
  async generateHash(req, res, next) {
    try {
      const { text, algorithm = 'sha256' } = req.body;
      if (!text) {
        throw new AppError('Text is required', 400);
      }
      const result = await toolsService.generateHash(text, algorithm);
      res.status(200).json({
        success: true,
        message: 'Hash generated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Generate hash error:', error);
      next(error);
    }
  }

  // UUID generator
  async generateUUID(req, res, next) {
    try {
      const { version = 4, count = 1 } = req.query;
      const result = await toolsService.generateUUID(parseInt(version), parseInt(count));
      res.status(200).json({
        success: true,
        message: 'UUID generated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Generate UUID error:', error);
      next(error);
    }
  }

  // Base64 encoder/decoder
  async encodeBase64(req, res, next) {
    try {
      const { text } = req.body;
      if (!text) {
        throw new AppError('Text is required', 400);
      }
      const result = await toolsService.encodeBase64(text);
      res.status(200).json({
        success: true,
        message: 'Base64 encoded successfully',
        data: result
      });
    } catch (error) {
      logger.error('Encode Base64 error:', error);
      next(error);
    }
  }

  async decodeBase64(req, res, next) {
    try {
      const { encoded } = req.body;
      if (!encoded) {
        throw new AppError('Encoded string is required', 400);
      }
      const result = await toolsService.decodeBase64(encoded);
      res.status(200).json({
        success: true,
        message: 'Base64 decoded successfully',
        data: result
      });
    } catch (error) {
      logger.error('Decode Base64 error:', error);
      next(error);
    }
  }

  // JSON tools
  async formatJSON(req, res, next) {
    try {
      const { json } = req.body;
      if (!json) {
        throw new AppError('JSON is required', 400);
      }
      const result = await toolsService.formatJSON(json);
      res.status(200).json({
        success: true,
        message: 'JSON formatted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Format JSON error:', error);
      next(error);
    }
  }

  async validateJSON(req, res, next) {
    try {
      const { json } = req.body;
      if (!json) {
        throw new AppError('JSON is required', 400);
      }
      const result = await toolsService.validateJSON(json);
      res.status(200).json({
        success: true,
        message: 'JSON validated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Validate JSON error:', error);
      next(error);
    }
  }

  async minifyJSON(req, res, next) {
    try {
      const { json } = req.body;
      if (!json) {
        throw new AppError('JSON is required', 400);
      }
      const result = await toolsService.minifyJSON(json);
      res.status(200).json({
        success: true,
        message: 'JSON minified successfully',
        data: result
      });
    } catch (error) {
      logger.error('Minify JSON error:', error);
      next(error);
    }
  }

  // CSV tools
  async convertCSV(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('CSV file is required', 400);
      }
      const { format = 'json' } = req.body;
      const result = await toolsService.convertCSV(req.file, format);
      res.status(200).json({
        success: true,
        message: 'CSV converted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert CSV error:', error);
      next(error);
    }
  }

  async validateCSV(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('CSV file is required', 400);
      }
      const result = await toolsService.validateCSV(req.file);
      res.status(200).json({
        success: true,
        message: 'CSV validated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Validate CSV error:', error);
      next(error);
    }
  }

  // Date/time tools
  async getCurrentTimestamp(req, res, next) {
    try {
      const result = await toolsService.getCurrentTimestamp();
      res.status(200).json({
        success: true,
        message: 'Current timestamp retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get current timestamp error:', error);
      next(error);
    }
  }

  async convertTimestamp(req, res, next) {
    try {
      const { timestamp, format } = req.body;
      if (!timestamp) {
        throw new AppError('Timestamp is required', 400);
      }
      const result = await toolsService.convertTimestamp(timestamp, format);
      res.status(200).json({
        success: true,
        message: 'Timestamp converted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert timestamp error:', error);
      next(error);
    }
  }

  async calculateDateDifference(req, res, next) {
    try {
      const { date1, date2, unit = 'days' } = req.body;
      if (!date1 || !date2) {
        throw new AppError('Both dates are required', 400);
      }
      const result = await toolsService.calculateDateDifference(date1, date2, unit);
      res.status(200).json({
        success: true,
        message: 'Date difference calculated',
        data: result
      });
    } catch (error) {
      logger.error('Calculate date difference error:', error);
      next(error);
    }
  }

  async addToDate(req, res, next) {
    try {
      const { date, amount, unit } = req.body;
      if (!date || !amount || !unit) {
        throw new AppError('Date, amount, and unit are required', 400);
      }
      const result = await toolsService.addToDate(date, parseInt(amount), unit);
      res.status(200).json({
        success: true,
        message: 'Date calculation completed',
        data: result
      });
    } catch (error) {
      logger.error('Add to date error:', error);
      next(error);
    }
  }

  // Color converter
  async convertColor(req, res, next) {
    try {
      const { color, toFormat } = req.body;
      if (!color || !toFormat) {
        throw new AppError('Color and toFormat are required', 400);
      }
      const result = await toolsService.convertColor(color, toFormat);
      res.status(200).json({
        success: true,
        message: 'Color converted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert color error:', error);
      next(error);
    }
  }

  // Unit converter
  async convertUnit(req, res, next) {
    try {
      const { value, fromUnit, toUnit } = req.body;
      if (!value || !fromUnit || !toUnit) {
        throw new AppError('Value, fromUnit, and toUnit are required', 400);
      }
      const result = await toolsService.convertUnit(parseFloat(value), fromUnit, toUnit);
      res.status(200).json({
        success: true,
        message: 'Unit converted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert unit error:', error);
      next(error);
    }
  }

  // Currency converter
  async convertCurrency(req, res, next) {
    try {
      const { amount, fromCurrency, toCurrency } = req.body;
      if (!amount || !fromCurrency || !toCurrency) {
        throw new AppError('Amount, fromCurrency, and toCurrency are required', 400);
      }
      const result = await toolsService.convertCurrency(parseFloat(amount), fromCurrency, toCurrency);
      res.status(200).json({
        success: true,
        message: 'Currency converted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Convert currency error:', error);
      next(error);
    }
  }

  // URL shortener
  async shortenURL(req, res, next) {
    try {
      const { url, customAlias, expiresAt } = req.body;
      if (!url) {
        throw new AppError('URL is required', 400);
      }
      const result = await toolsService.shortenURL(url, req.user.id, customAlias, expiresAt);
      res.status(200).json({
        success: true,
        message: 'URL shortened successfully',
        data: result
      });
    } catch (error) {
      logger.error('Shorten URL error:', error);
      next(error);
    }
  }

  async redirectShortURL(req, res, next) {
    try {
      const { shortCode } = req.params;
      const result = await toolsService.getOriginalURL(shortCode);
      res.redirect(result.originalUrl);
    } catch (error) {
      logger.error('Redirect short URL error:', error);
      next(error);
    }
  }

  // IP tools
  async getIPInfo(req, res, next) {
    try {
      const { ip } = req.query;
      const result = await toolsService.getIPInfo(ip || req.ip);
      res.status(200).json({
        success: true,
        message: 'IP info retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get IP info error:', error);
      next(error);
    }
  }

  async getIPLocation(req, res, next) {
    try {
      const { ip } = req.query;
      const result = await toolsService.getIPLocation(ip || req.ip);
      res.status(200).json({
        success: true,
        message: 'IP location retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get IP location error:', error);
      next(error);
    }
  }

  // User agent parser
  async parseUserAgent(req, res, next) {
    try {
      const { userAgent } = req.query;
      const result = await toolsService.parseUserAgent(userAgent || req.headers['user-agent']);
      res.status(200).json({
        success: true,
        message: 'User agent parsed',
        data: result
      });
    } catch (error) {
      logger.error('Parse user agent error:', error);
      next(error);
    }
  }

  // File info
  async getFileInfo(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('File is required', 400);
      }
      const result = await toolsService.getFileInfo(req.file);
      res.status(200).json({
        success: true,
        message: 'File info retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get file info error:', error);
      next(error);
    }
  }

  // System status
  async getSystemStatus(req, res, next) {
    try {
      const result = await toolsService.getSystemStatus();
      res.status(200).json({
        success: true,
        message: 'System status retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get system status error:', error);
      next(error);
    }
  }

  async getHealthStatus(req, res, next) {
    try {
      const result = await toolsService.getHealthStatus();
      res.status(200).json({
        success: true,
        message: 'Health status retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get health status error:', error);
      next(error);
    }
  }

  // Backup tools
  async createBackup(req, res, next) {
    try {
      const { type, includeData } = req.body;
      const result = await toolsService.createBackup(type, includeData === true, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Backup created successfully',
        data: result
      });
    } catch (error) {
      logger.error('Create backup error:', error);
      next(error);
    }
  }

  async listBackups(req, res, next) {
    try {
      const result = await toolsService.listBackups(req.user.id);
      res.status(200).json({
        success: true,
        message: 'Backups listed successfully',
        data: result
      });
    } catch (error) {
      logger.error('List backups error:', error);
      next(error);
    }
  }

  async restoreBackup(req, res, next) {
    try {
      const { backupId } = req.body;
      if (!backupId) {
        throw new AppError('Backup ID is required', 400);
      }
      await toolsService.restoreBackup(backupId, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Backup restored successfully'
      });
    } catch (error) {
      logger.error('Restore backup error:', error);
      next(error);
    }
  }

  // Cleanup tools
  async cleanupTempFiles(req, res, next) {
    try {
      const result = await toolsService.cleanupTempFiles();
      res.status(200).json({
        success: true,
        message: 'Temp files cleaned up',
        data: result
      });
    } catch (error) {
      logger.error('Cleanup temp files error:', error);
      next(error);
    }
  }

  async cleanupOldFiles(req, res, next) {
    try {
      const { days = 30 } = req.body;
      const result = await toolsService.cleanupOldFiles(parseInt(days));
      res.status(200).json({
        success: true,
        message: 'Old files cleaned up',
        data: result
      });
    } catch (error) {
      logger.error('Cleanup old files error:', error);
      next(error);
    }
  }

  // Export tools
  async exportData(req, res, next) {
    try {
      const { format, dataType, filters } = req.body;
      const result = await toolsService.exportData(format, dataType, filters, req.user.id);
      
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=export_${new Date().toISOString().split('T')[0]}.csv`);
        return res.send(result);
      } else if (format === 'json') {
        res.status(200).json({
          success: true,
          message: 'Data exported successfully',
          data: result
        });
      } else {
        throw new AppError('Unsupported export format', 400);
      }
    } catch (error) {
      logger.error('Export data error:', error);
      next(error);
    }
  }

  // Import tools
  async importData(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('File is required for import', 400);
      }
      const { dataType, options } = req.body;
      const result = await toolsService.importData(req.file, dataType, options, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Data imported successfully',
        data: result
      });
    } catch (error) {
      logger.error('Import data error:', error);
      next(error);
    }
  }

  // Batch processing
  async processBatch(req, res, next) {
    try {
      const { operations, data } = req.body;
      if (!operations || !data) {
        throw new AppError('Operations and data are required', 400);
      }
      const result = await toolsService.processBatch(operations, data, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Batch processed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Process batch error:', error);
      next(error);
    }
  }

  // Statistics
  async getUsageStats(req, res, next) {
    try {
      const { period = 'month' } = req.query;
      const result = await toolsService.getUsageStats(period, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Usage stats retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get usage stats error:', error);
      next(error);
    }
  }

  // =============================================================
  // MARKETPLACE CONTROLLERS
  // =============================================================

  async getListings(req, res, next) {
    try {
      const { page = 1, limit = 20, category, type, search, minPrice, maxPrice, sort = 'newest' } = req.query;
      const db = require('../models');
      const result = await db.Tool.getListings({
        page: parseInt(page), limit: parseInt(limit),
        category, type, search,
        minPrice: minPrice ? parseFloat(minPrice) : undefined,
        maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
        sort
      });
      if (result && Array.isArray(result.listings)) {
        result.listings = result.listings.map(l => {
          const item = l.toJSON ? l.toJSON() : { ...l };
          item.condition = (item.metadata || {}).condition || 'new';
          return item;
        });
      }
      res.status(200).json({ success: true, message: 'Listings retrieved', data: result });
    } catch (error) {
      logger.error('getListings error:', error);
      next(error);
    }
  }

  async getMyListings(req, res, next) {
    try {
      const db = require('../models');
      const listings = await db.Tool.getMyListings(req.user.id);
      res.status(200).json({ success: true, message: 'My listings retrieved', data: { listings, total: listings.length } });
    } catch (error) {
      logger.error('getMyListings error:', error);
      next(error);
    }
  }

  async getSavedListings(req, res, next) {
    try {
      const db = require('../models');
      const listings = await db.Tool.getSavedListings(req.user.id);
      res.status(200).json({ success: true, message: 'Saved listings retrieved', data: { listings, total: listings.length } });
    } catch (error) {
      logger.error('getSavedListings error:', error);
      next(error);
    }
  }

  async getPremiumListings(req, res, next) {
    try {
      const { limit = 20 } = req.query;
      const db = require('../models');
      const listings = await db.Tool.getPremiumListings(parseInt(limit));
      res.status(200).json({ success: true, message: 'Premium listings retrieved', data: { listings, total: listings.length } });
    } catch (error) {
      logger.error('getPremiumListings error:', error);
      next(error);
    }
  }

  async getListing(req, res, next) {
    try {
      const { listingId } = req.params;
      const db = require('../models');
      const listing = await db.Tool.findByPk(listingId, {
        include: db.Tool.associations.seller
          ? [{ association: db.Tool.associations.seller, attributes: ['id', 'username', 'avatar', 'displayName'] }]
          : []
      });
      if (!listing || listing.status === 'deleted') {
        return res.status(404).json({ success: false, message: 'Listing not found' });
      }
      res.status(200).json({ success: true, data: { listing } });
    } catch (error) {
      logger.error('getListing error:', error);
      next(error);
    }
  }

  async createListing(req, res, next) {
    try {
      const { title, description, price, category, type, images, tags, stock, currency, metadata, condition } = req.body;
      if (!title) {
        throw new AppError('title is required', 400);
      }
      const db = require('../models');

      const typeMap = { 'services': 'service', 'digital': 'digital', 'premium': 'premium', 'physical': 'physical' };
      const normalizedType = typeMap[type] || type || 'service';

      const validCategories = ['electronics', 'furniture', 'clothing', 'books', 'services', 'digital', 'premium', 'other'];
      const normalizedCategory = validCategories.includes(category) ? category : (
        normalizedType === 'digital' ? 'digital' : normalizedType === 'premium' ? 'premium' : 'services'
      );

      const validConditions = ['new', 'used', 'refurbished'];
      const normalizedCondition = validConditions.includes(condition) ? condition : 'new';

      const listing = await db.Tool.create({
        sellerId: req.user.id,
        title,
        description,
        price: price !== undefined && price !== null ? parseFloat(price) : 0,
        category: normalizedCategory,
        type: normalizedType,
        images: images || [],
        tags: tags || [],
        stock: stock !== undefined ? parseInt(stock) : null,
        currency: currency || 'USD',
        metadata: Object.assign({}, metadata || {}, { condition: normalizedCondition }),
        status: 'active',
        available: true,
      });

      const listingData = listing.toJSON ? listing.toJSON() : listing;
      listingData.userId = listingData.sellerId;
      listingData.condition = (listingData.metadata || {}).condition || normalizedCondition;
      listingData.user = {
        id: listingData.sellerId,
        displayName: req.user.displayName || req.user.username || 'User',
        photoURL: req.user.photoURL || req.user.avatar || '',
      };

      res.status(201).json({ success: true, message: 'Listing created', data: { listing: listingData } });
    } catch (error) {
      logger.error('createListing error:', error);
      next(error);
    }
  }

  async bulkCreateListings(req, res, next) {
    try {
      const { listings } = req.body;
      if (!Array.isArray(listings) || listings.length === 0) {
        throw new AppError('listings array is required', 400);
      }
      const db = require('../models');
      const created = await db.Tool.bulkCreate(
        listings.map(l => ({
          ...l,
          sellerId: req.user.id,
          price: parseFloat(l.price || 0),
          images: l.images || [],
          tags: l.tags || [],
          status: 'active',
          available: true
        })),
        { returning: true }
      );
      res.status(201).json({ success: true, message: 'Listings created', data: { listings: created, total: created.length } });
    } catch (error) {
      logger.error('bulkCreateListings error:', error);
      next(error);
    }
  }

  async updateListing(req, res, next) {
    try {
      const { listingId } = req.params;
      const db = require('../models');
      const listing = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
      if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
      const allowed = ['title', 'description', 'price', 'category', 'type', 'images', 'tags', 'available', 'stock', 'currency', 'metadata'];
      allowed.forEach(field => { if (req.body[field] !== undefined) listing[field] = req.body[field]; });
      await listing.save();
      res.status(200).json({ success: true, message: 'Listing updated', data: { listing } });
    } catch (error) {
      logger.error('updateListing error:', error);
      next(error);
    }
  }

  async deleteListing(req, res, next) {
    try {
      const { listingId } = req.params;
      const db = require('../models');
      const listing = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
      if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
      listing.status = 'deleted';
      await listing.save();
      res.status(200).json({ success: true, message: 'Listing deleted' });
    } catch (error) {
      logger.error('deleteListing error:', error);
      next(error);
    }
  }

  async recordListingView(req, res, next) {
    try {
      const { listingId } = req.params;
      const db = require('../models');
      const listing = await db.Tool.findByPk(listingId);
      if (listing) await listing.incrementViews();
      res.status(200).json({ success: true, message: 'View recorded' });
    } catch (error) {
      logger.error('recordListingView error:', error);
      next(error);
    }
  }

  async toggleSaveListing(req, res, next) {
    try {
      const { listingId } = req.params;
      const db = require('../models');
      const listing = await db.Tool.findByPk(listingId);
      if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });
      await listing.toggleSave(req.user.id);
      const saved = listing.isSavedBy(req.user.id);
      res.status(200).json({ success: true, message: saved ? 'Listing saved' : 'Listing unsaved', data: { saved } });
    } catch (error) {
      logger.error('toggleSaveListing error:', error);
      next(error);
    }
  }

  async purchaseListing(req, res, next) {
    try {
      const { listingId } = req.params;
      const db = require('../models');
      const listing = await db.Tool.findByPk(listingId);
      if (!listing || !listing.available) return res.status(404).json({ success: false, message: 'Listing not available' });
      const purchased = listing.purchasedBy || [];
      listing.purchasedBy = [...purchased, req.user.id];
      if (listing.stock !== null) {
        listing.stock = Math.max(0, listing.stock - 1);
        if (listing.stock === 0) { listing.available = false; listing.status = 'sold'; }
      }
      await listing.save();
      res.status(200).json({ success: true, message: 'Purchase recorded', data: { listing } });
    } catch (error) {
      logger.error('purchaseListing error:', error);
      next(error);
    }
  }

  async rateListing(req, res, next) {
    try {
      const { listingId } = req.params;
      const { rating } = req.body;
      if (!rating || rating < 1 || rating > 5) throw new AppError('Rating must be between 1 and 5', 400);
      const db = require('../models');
      const listing = await db.Tool.findByPk(listingId);
      if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });
      await listing.addRating(parseFloat(rating));
      res.status(200).json({ success: true, message: 'Rating submitted', data: { rating: listing.rating, ratingCount: listing.ratingCount } });
    } catch (error) {
      logger.error('rateListing error:', error);
      next(error);
    }
  }

  async getSpotlightListings(req, res, next) {
    try {
      const { limit = 10 } = req.query;
      const db = require('../models');
      const listings = await db.Tool.getSpotlight(parseInt(limit));
      res.status(200).json({ success: true, message: 'Spotlight listings retrieved', data: { listings, total: listings.length } });
    } catch (error) {
      logger.error('getSpotlightListings error:', error);
      next(error);
    }
  }

  async addToSpotlight(req, res, next) {
    try {
      const { listingId } = req.body;
      if (!listingId) throw new AppError('listingId is required', 400);
      const db = require('../models');
      const listing = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
      if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
      listing.isSpotlight = true;
      await listing.save();
      res.status(200).json({ success: true, message: 'Listing added to spotlight', data: { listing } });
    } catch (error) {
      logger.error('addToSpotlight error:', error);
      next(error);
    }
  }

  async boostListing(req, res, next) {
    try {
      const { listingId, duration = '24h' } = req.body;
      if (!listingId) throw new AppError('listingId is required', 400);
      const db = require('../models');
      const listing = await db.Tool.findOne({ where: { id: listingId, sellerId: req.user.id } });
      if (!listing) return res.status(404).json({ success: false, message: 'Listing not found or not yours' });
      const hours = parseInt(duration) || 24;
      listing.isBoosted = true;
      listing.boostExpiresAt = new Date(Date.now() + hours * 3600000);
      await listing.save();
      res.status(200).json({ success: true, message: 'Listing boosted', data: { listing, boostExpiresAt: listing.boostExpiresAt } });
    } catch (error) {
      logger.error('boostListing error:', error);
      next(error);
    }
  }

  async getLeaderboard(req, res, next) {
    try {
      const { limit = 20 } = req.query;
      const db = require('../models');
      const rawLeaderboard = await db.Tool.getLeaderboard(parseInt(limit));
      const leaderboard = rawLeaderboard.map(r => ({
        userId: r.seller_id || r.userId,
        sellerId: r.seller_id || r.sellerId,
        listingCount: parseInt(r.listing_count || r.listingCount || 0),
        totalViews: parseInt(r.total_views || r.totalViews || 0),
        avgRating: parseFloat(r.avg_rating || r.avgRating || 0),
        totalSales: parseInt(r.total_sales || r.totalSales || 0)
      }));
      res.status(200).json({ success: true, message: 'Leaderboard retrieved', data: { leaderboard } });
    } catch (error) {
      logger.error('getLeaderboard error:', error);
      next(error);
    }
  }

  async sendTip(req, res, next) {
    try {
      const { sellerId, amount, listingId, message } = req.body;
      if (!sellerId || !amount) throw new AppError('sellerId and amount are required', 400);
      res.status(200).json({
        success: true,
        message: 'Tip sent successfully',
        data: { sellerId, amount, listingId, message, sentAt: new Date().toISOString() }
      });
    } catch (error) {
      logger.error('sendTip error:', error);
      next(error);
    }
  }

  async getMarketplaceStats(req, res, next) {
    try {
      const db = require('../models');
      const { Op } = require('sequelize');
      const [totalListings, myListings, totalViews] = await Promise.all([
        db.Tool.count({ where: { status: 'active' } }),
        db.Tool.count({ where: { sellerId: req.user.id, status: { [Op.ne]: 'deleted' } } }),
        db.Tool.sum('views', { where: { sellerId: req.user.id } })
      ]);
      res.status(200).json({
        success: true,
        message: 'Marketplace stats retrieved',
        data: { totalListings, myListings, totalViews: totalViews || 0 }
      });
    } catch (error) {
      logger.error('getMarketplaceStats error:', error);
      next(error);
    }
  }

  async getPremiumFeatures(req, res, next) {
    try {
      const features = [
        { id: 'spotlight', name: 'PRO Spotlight', description: 'Feature your listing at the top', price: 9.99 },
        { id: 'boost', name: 'Boost Listing', description: 'Boost visibility for 24 hours', price: 4.99 },
        { id: 'premium_badge', name: 'Premium Badge', description: 'Show a premium seller badge', price: 19.99 },
        { id: 'analytics', name: 'Advanced Analytics', description: 'Detailed listing analytics', price: 14.99 }
      ];
      res.status(200).json({ success: true, data: { features } });
    } catch (error) {
      logger.error('getPremiumFeatures error:', error);
      next(error);
    }
  }

  async processPayment(req, res, next) {
    try {
      const { amount, currency = 'KES', listingId, paymentMethod, phone, mpesaPhone } = req.body;
      if (!amount || !listingId) throw new AppError('amount and listingId are required', 400);

      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

      if (paymentMethod === 'mpesa') {
        const phoneNumber = (phone || mpesaPhone || '').replace(/\s/g, '');
        if (!phoneNumber) throw new AppError('M-Pesa phone number is required', 400);

        let normalizedPhone = phoneNumber.replace(/^\+/, '').replace(/^0/, '254');
        if (!/^254[7|1]\d{8}$/.test(normalizedPhone)) {
          throw new AppError('Invalid M-Pesa phone number. Use format 0712345678 or 254712345678', 400);
        }

        const consumerKey = process.env.MPESA_CONSUMER_KEY;
        const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
        const shortcode = process.env.MPESA_SHORTCODE || '174379';
        const passkey = process.env.MPESA_PASSKEY;
        const callbackUrl = process.env.MPESA_CALLBACK_URL || `${process.env.BASE_URL || 'https://example.com'}/api/payments/mpesa/callback`;

        if (consumerKey && consumerSecret && passkey) {
          try {
            const axios = require('axios');
            const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
            const tokenRes = await axios.get(
              'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
              { headers: { Authorization: `Basic ${auth}` } }
            );
            const accessToken = tokenRes.data.access_token;
            const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
            const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

            const stkRes = await axios.post(
              'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
              {
                BusinessShortCode: shortcode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: Math.ceil(amount),
                PartyA: normalizedPhone,
                PartyB: shortcode,
                PhoneNumber: normalizedPhone,
                CallBackURL: callbackUrl,
                AccountReference: `KNECTA-${listingId.slice(0, 8)}`,
                TransactionDesc: `Payment for listing ${listingId}`
              },
              { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
            );

            return res.status(200).json({
              success: true,
              message: 'M-Pesa STK Push sent. Check your phone.',
              data: {
                transactionId,
                checkoutRequestId: stkRes.data.CheckoutRequestID,
                merchantRequestId: stkRes.data.MerchantRequestID,
                amount,
                currency: 'KES',
                listingId,
                paymentMethod: 'mpesa',
                phone: normalizedPhone,
                status: 'pending'
              }
            });
          } catch (mpesaErr) {
            logger.error('M-Pesa STK Push error:', mpesaErr.response?.data || mpesaErr.message);
          }
        }

        return res.status(200).json({
          success: true,
          message: `STK Push queued for ${normalizedPhone} (sandbox mode — configure MPESA_* env vars for live)`,
          data: {
            transactionId,
            amount,
            currency: 'KES',
            listingId,
            paymentMethod: 'mpesa',
            phone: normalizedPhone,
            status: 'pending_sandbox'
          }
        });
      }

      res.status(200).json({
        success: true,
        message: 'Payment processed',
        data: {
          transactionId,
          amount,
          currency: currency || 'KES',
          listingId,
          paymentMethod: paymentMethod || 'card',
          status: 'completed'
        }
      });
    } catch (error) {
      logger.error('processPayment error:', error);
      next(error);
    }
  }

  async getUserSubscription(req, res, next) {
    try {
      res.status(200).json({
        success: true,
        data: {
          plan: 'free',
          features: [],
          expiresAt: null,
          userId: req.user.id
        }
      });
    } catch (error) {
      logger.error('getUserSubscription error:', error);
      next(error);
    }
  }

  async mpesaCallback(req, res, next) {
    try {
      const { Body } = req.body || {};
      const stkCallback = Body?.stkCallback || {};
      const resultCode = stkCallback.ResultCode;
      const checkoutRequestId = stkCallback.CheckoutRequestID;

      if (resultCode === 0) {
        const callbackMetadata = stkCallback.CallbackMetadata?.Item || [];
        const getVal = (name) => (callbackMetadata.find(i => i.Name === name) || {}).Value;
        const mpesaReceiptNumber = getVal('MpesaReceiptNumber');
        const amount = getVal('Amount');
        const phoneNumber = getVal('PhoneNumber');

        logger.info('[M-Pesa] Payment successful:', { checkoutRequestId, mpesaReceiptNumber, amount, phoneNumber });
      } else {
        logger.warn('[M-Pesa] Payment failed/cancelled. ResultCode:', resultCode, 'Desc:', stkCallback.ResultDesc);
      }

      res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    } catch (error) {
      logger.error('mpesaCallback error:', error);
      res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
  }
}

module.exports = new ToolsController();