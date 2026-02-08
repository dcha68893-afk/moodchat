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
}

module.exports = new ToolsController();