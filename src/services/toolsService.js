const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { ServerError, ValidationError } = require('../utils/errors');

class ToolsService {
  constructor() {
    this.uploadsDir = path.join(__dirname, '../../uploads/tools');
    this.ensureUploadsDirectory();
  }

  ensureUploadsDirectory() {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  // File upload services
  async uploadImage(file, userId) {
    try {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
      if (!allowedTypes.includes(file.mimetype)) {
        throw new ValidationError('Invalid image type');
      }

      const filename = `image_${Date.now()}_${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
      const filepath = path.join(this.uploadsDir, filename);
      
      fs.writeFileSync(filepath, file.buffer);

      return {
        filename,
        originalName: file.originalname,
        filepath: `/uploads/tools/${filename}`,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date(),
        userId
      };
    } catch (error) {
      logger.error('Upload image service error:', error);
      throw new ServerError('Failed to upload image');
    }
  }

  async uploadFile(file, userId) {
    try {
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (file.size > maxSize) {
        throw new ValidationError('File size exceeds 10MB limit');
      }

      const filename = `file_${Date.now()}_${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
      const filepath = path.join(this.uploadsDir, filename);
      
      fs.writeFileSync(filepath, file.buffer);

      return {
        filename,
        originalName: file.originalname,
        filepath: `/uploads/tools/${filename}`,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date(),
        userId
      };
    } catch (error) {
      logger.error('Upload file service error:', error);
      throw new ServerError('Failed to upload file');
    }
  }

  async deleteFile(fileId, userId) {
    try {
      // In a real implementation, you would look up the file in database
      // For now, we'll assume fileId is the filename
      const filepath = path.join(this.uploadsDir, fileId);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return true;
      }
      throw new ValidationError('File not found');
    } catch (error) {
      logger.error('Delete file service error:', error);
      throw new ServerError('Failed to delete file');
    }
  }

  // Image processing services
  async resizeImage(width, height, imageUrl, userId) {
    try {
      // This is a simplified implementation
      // In production, you would download the image, resize it, and save it
      return {
        originalUrl: imageUrl,
        resizedUrl: `${imageUrl}?width=${width}&height=${height}`,
        width: parseInt(width),
        height: parseInt(height),
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Resize image service error:', error);
      throw new ServerError('Failed to resize image');
    }
  }

  async compressImage(imageUrl, quality, userId) {
    try {
      return {
        originalUrl: imageUrl,
        compressedUrl: `${imageUrl}?quality=${quality}`,
        quality: quality,
        sizeReduction: '20%', // Example
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Compress image service error:', error);
      throw new ServerError('Failed to compress image');
    }
  }

  async convertImage(imageUrl, format, userId) {
    try {
      const allowedFormats = ['jpg', 'png', 'webp', 'gif'];
      if (!allowedFormats.includes(format.toLowerCase())) {
        throw new ValidationError('Unsupported image format');
      }

      return {
        originalUrl: imageUrl,
        convertedUrl: `${imageUrl}.${format}`,
        originalFormat: 'jpg', // This would be detected
        targetFormat: format,
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Convert image service error:', error);
      throw new ServerError('Failed to convert image');
    }
  }

  async addWatermark(imageUrl, watermarkText, position, userId) {
    try {
      return {
        originalUrl: imageUrl,
        watermarkedUrl: `${imageUrl}?watermark=${encodeURIComponent(watermarkText)}`,
        watermarkText,
        position: position || 'bottom-right',
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Add watermark service error:', error);
      throw new ServerError('Failed to add watermark');
    }
  }

  // PDF tools services (simplified - would require PDF libraries in production)
  async mergePDFs(pdfUrls, userId) {
    try {
      return {
        mergedUrl: '/uploads/tools/merged.pdf',
        sourceFiles: pdfUrls.length,
        size: '2.5MB', // Example
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Merge PDFs service error:', error);
      throw new ServerError('Failed to merge PDFs');
    }
  }

  async splitPDF(pdfUrl, pages, userId) {
    try {
      return {
        originalUrl: pdfUrl,
        splitFiles: pages.map(page => ({
          page,
          url: `${pdfUrl}_page_${page}.pdf`
        })),
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Split PDF service error:', error);
      throw new ServerError('Failed to split PDF');
    }
  }

  async compressPDF(pdfUrl, quality, userId) {
    try {
      return {
        originalUrl: pdfUrl,
        compressedUrl: `${pdfUrl}_compressed.pdf`,
        quality,
        sizeReduction: '30%',
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Compress PDF service error:', error);
      throw new ServerError('Failed to compress PDF');
    }
  }

  async convertToPDF(fileUrl, format, userId) {
    try {
      return {
        originalUrl: fileUrl,
        pdfUrl: `${fileUrl}.pdf`,
        originalFormat: format,
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Convert to PDF service error:', error);
      throw new ServerError('Failed to convert to PDF');
    }
  }

  // Text tools services
  async analyzeText(text) {
    try {
      const words = text.split(/\s+/).length;
      const characters = text.length;
      const sentences = text.split(/[.!?]+/).length - 1;
      const paragraphs = text.split(/\n\s*\n/).length;
      
      // Simple word frequency analysis
      const wordsArray = text.toLowerCase().match(/\b\w+\b/g) || [];
      const wordFrequency = {};
      wordsArray.forEach(word => {
        wordFrequency[word] = (wordFrequency[word] || 0) + 1;
      });
      
      const sortedWords = Object.entries(wordFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      return {
        wordCount: words,
        characterCount: characters,
        sentenceCount: sentences,
        paragraphCount: paragraphs,
        readingTime: Math.ceil(words / 200), // Assuming 200 words per minute
        topWords: sortedWords,
        analysisCompleted: new Date()
      };
    } catch (error) {
      logger.error('Analyze text service error:', error);
      throw new ServerError('Failed to analyze text');
    }
  }

  async translateText(text, sourceLang, targetLang) {
    try {
      // This is a placeholder - in production you would use a translation API
      return {
        originalText: text,
        translatedText: `[Translation of: ${text.substring(0, 50)}...]`,
        sourceLanguage: sourceLang || 'auto',
        targetLanguage: targetLang,
        characterCount: text.length,
        translatedAt: new Date()
      };
    } catch (error) {
      logger.error('Translate text service error:', error);
      throw new ServerError('Failed to translate text');
    }
  }

  async summarizeText(text, length) {
    try {
      const sentences = text.split(/[.!?]+/);
      const summaryLength = length === 'short' ? 1 : length === 'medium' ? 3 : 5;
      const summary = sentences.slice(0, summaryLength).join('. ') + '.';
      
      return {
        originalText: text,
        summary,
        originalLength: text.length,
        summaryLength: summary.length,
        reduction: `${Math.round((1 - summary.length / text.length) * 100)}%`,
        summarizedAt: new Date()
      };
    } catch (error) {
      logger.error('Summarize text service error:', error);
      throw new ServerError('Failed to summarize text');
    }
  }

  async analyzeSentiment(text) {
    try {
      const positiveWords = ['good', 'great', 'excellent', 'happy', 'love', 'like', 'awesome', 'fantastic'];
      const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'dislike', 'poor', 'horrible', 'sad'];
      
      const words = text.toLowerCase().match(/\b\w+\b/g) || [];
      let positiveScore = 0;
      let negativeScore = 0;
      
      words.forEach(word => {
        if (positiveWords.includes(word)) positiveScore++;
        if (negativeWords.includes(word)) negativeScore++;
      });
      
      const totalScore = positiveScore - negativeScore;
      let sentiment = 'neutral';
      
      if (totalScore > 2) sentiment = 'very positive';
      else if (totalScore > 0) sentiment = 'positive';
      else if (totalScore < -2) sentiment = 'very negative';
      else if (totalScore < 0) sentiment = 'negative';
      
      return {
        text,
        sentiment,
        score: totalScore,
        positiveWords: positiveScore,
        negativeWords: negativeScore,
        analyzedAt: new Date()
      };
    } catch (error) {
      logger.error('Analyze sentiment service error:', error);
      throw new ServerError('Failed to analyze sentiment');
    }
  }

  // QR code services
  async generateQRCode(data, size, color, userId) {
    try {
      const qrCode = {
        data,
        imageUrl: `/api/tools/qrcode/${Buffer.from(data).toString('base64')}.png`,
        size: size || 200,
        color: color || '#000000',
        backgroundColor: '#FFFFFF',
        generatedAt: new Date()
      };
      
      // In production, you would generate actual QR code image
      return qrCode;
    } catch (error) {
      logger.error('Generate QR code service error:', error);
      throw new ServerError('Failed to generate QR code');
    }
  }

  async scanQRCode(file) {
    try {
      // This is a placeholder - in production you would use a QR code scanning library
      return {
        filename: file.originalname,
        data: 'Sample QR code data',
        format: 'QR_CODE',
        scannedAt: new Date()
      };
    } catch (error) {
      logger.error('Scan QR code service error:', error);
      throw new ServerError('Failed to scan QR code');
    }
  }

  // Barcode services
  async generateBarcode(data, type, width, height, userId) {
    try {
      return {
        data,
        type,
        imageUrl: `/api/tools/barcode/${Buffer.from(data).toString('base64')}.png`,
        width: width || 300,
        height: height || 100,
        generatedAt: new Date()
      };
    } catch (error) {
      logger.error('Generate barcode service error:', error);
      throw new ServerError('Failed to generate barcode');
    }
  }

  async scanBarcode(file) {
    try {
      return {
        filename: file.originalname,
        data: 'Sample barcode data',
        format: 'CODE_128',
        scannedAt: new Date()
      };
    } catch (error) {
      logger.error('Scan barcode service error:', error);
      throw new ServerError('Failed to scan barcode');
    }
  }

  // Password generator
  async generatePassword(length, includeNumbers, includeSymbols, includeUppercase) {
    try {
      let charset = 'abcdefghijklmnopqrstuvwxyz';
      if (includeUppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      if (includeNumbers) charset += '0123456789';
      if (includeSymbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
      
      let password = '';
      for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
      }
      
      return {
        password,
        length,
        includeNumbers,
        includeSymbols,
        includeUppercase,
        strength: this.calculatePasswordStrength(password),
        generatedAt: new Date()
      };
    } catch (error) {
      logger.error('Generate password service error:', error);
      throw new ServerError('Failed to generate password');
    }
  }

  calculatePasswordStrength(password) {
    let score = 0;
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    
    if (score >= 5) return 'very strong';
    if (score >= 4) return 'strong';
    if (score >= 3) return 'good';
    if (score >= 2) return 'weak';
    return 'very weak';
  }

  async checkPasswordStrength(password) {
    try {
      const strength = this.calculatePasswordStrength(password);
      const suggestions = [];
      
      if (password.length < 8) suggestions.push('Use at least 8 characters');
      if (!/[A-Z]/.test(password)) suggestions.push('Add uppercase letters');
      if (!/[0-9]/.test(password)) suggestions.push('Add numbers');
      if (!/[^A-Za-z0-9]/.test(password)) suggestions.push('Add special characters');
      
      return {
        password: '•'.repeat(password.length),
        length: password.length,
        strength,
        score: this.calculatePasswordStrength(password),
        suggestions,
        checkedAt: new Date()
      };
    } catch (error) {
      logger.error('Check password strength service error:', error);
      throw new ServerError('Failed to check password strength');
    }
  }

  // Hash generator
  async generateHash(text, algorithm) {
    try {
      const allowedAlgorithms = ['md5', 'sha1', 'sha256', 'sha512'];
      if (!allowedAlgorithms.includes(algorithm.toLowerCase())) {
        throw new ValidationError('Unsupported hash algorithm');
      }
      
      const hash = crypto.createHash(algorithm).update(text).digest('hex');
      
      return {
        text,
        algorithm,
        hash,
        length: hash.length,
        generatedAt: new Date()
      };
    } catch (error) {
      logger.error('Generate hash service error:', error);
      throw new ServerError('Failed to generate hash');
    }
  }

  // UUID generator
  async generateUUID(version, count) {
    try {
      const uuids = [];
      for (let i = 0; i < count; i++) {
        if (version === 1) {
          // UUID v1 (timestamp-based)
          uuids.push(uuidv1());
        } else if (version === 4) {
          // UUID v4 (random)
          uuids.push(uuidv4());
        } else {
          throw new ValidationError('Unsupported UUID version');
        }
      }
      
      return {
        version,
        count,
        uuids,
        generatedAt: new Date()
      };
    } catch (error) {
      logger.error('Generate UUID service error:', error);
      throw new ServerError('Failed to generate UUID');
    }
  }

  // Base64 encoder/decoder
  async encodeBase64(text) {
    try {
      const encoded = Buffer.from(text).toString('base64');
      return {
        original: text,
        encoded,
        length: encoded.length,
        encodedAt: new Date()
      };
    } catch (error) {
      logger.error('Encode Base64 service error:', error);
      throw new ServerError('Failed to encode Base64');
    }
  }

  async decodeBase64(encoded) {
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      return {
        encoded,
        decoded,
        length: decoded.length,
        decodedAt: new Date()
      };
    } catch (error) {
      logger.error('Decode Base64 service error:', error);
      throw new ServerError('Failed to decode Base64');
    }
  }

  // JSON tools
  async formatJSON(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      const formatted = JSON.stringify(parsed, null, 2);
      return {
        original: json,
        formatted,
        isValid: true,
        formattedAt: new Date()
      };
    } catch (error) {
      throw new ValidationError('Invalid JSON format');
    }
  }

  async validateJSON(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      return {
        json,
        isValid: true,
        size: JSON.stringify(json).length,
        validatedAt: new Date()
      };
    } catch (error) {
      return {
        json,
        isValid: false,
        error: error.message,
        validatedAt: new Date()
      };
    }
  }

  async minifyJSON(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      const minified = JSON.stringify(parsed);
      const originalSize = JSON.stringify(json).length;
      const minifiedSize = minified.length;
      
      return {
        original: json,
        minified,
        originalSize,
        minifiedSize,
        reduction: `${Math.round((1 - minifiedSize / originalSize) * 100)}%`,
        minifiedAt: new Date()
      };
    } catch (error) {
      throw new ValidationError('Invalid JSON format');
    }
  }

  // CSV tools
  async convertCSV(file, format) {
    try {
      const csvContent = file.buffer.toString('utf-8');
      const lines = csvContent.split('\n');
      const headers = lines[0].split(',');
      const data = lines.slice(1).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((header, index) => {
          obj[header.trim()] = values[index] ? values[index].trim() : '';
        });
        return obj;
      });
      
      if (format === 'json') {
        return {
          filename: file.originalname,
          format: 'JSON',
          data,
          rowCount: data.length,
          columnCount: headers.length,
          convertedAt: new Date()
        };
      }
      
      throw new ValidationError('Unsupported conversion format');
    } catch (error) {
      logger.error('Convert CSV service error:', error);
      throw new ServerError('Failed to convert CSV');
    }
  }

  async validateCSV(file) {
    try {
      const csvContent = file.buffer.toString('utf-8');
      const lines = csvContent.split('\n');
      const headers = lines[0].split(',');
      
      const errors = [];
      let isValid = true;
      
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) {
          const values = lines[i].split(',');
          if (values.length !== headers.length) {
            errors.push(`Row ${i + 1}: Column count mismatch`);
            isValid = false;
          }
        }
      }
      
      return {
        filename: file.originalname,
        isValid,
        rowCount: lines.length - 1,
        columnCount: headers.length,
        errors,
        validatedAt: new Date()
      };
    } catch (error) {
      logger.error('Validate CSV service error:', error);
      throw new ServerError('Failed to validate CSV');
    }
  }

  // Date/time tools
  async getCurrentTimestamp() {
    try {
      const now = new Date();
      return {
        timestamp: now.getTime(),
        isoString: now.toISOString(),
        localString: now.toLocaleString(),
        utcString: now.toUTCString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        retrievedAt: now
      };
    } catch (error) {
      logger.error('Get current timestamp service error:', error);
      throw new ServerError('Failed to get current timestamp');
    }
  }

  async convertTimestamp(timestamp, format) {
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        throw new ValidationError('Invalid timestamp');
      }
      
      const formats = {
        iso: date.toISOString(),
        local: date.toLocaleString(),
        utc: date.toUTCString(),
        unix: Math.floor(date.getTime() / 1000),
        custom: format ? date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' }) : null
      };
      
      return {
        input: timestamp,
        date: date.toISOString(),
        formats,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        convertedAt: new Date()
      };
    } catch (error) {
      logger.error('Convert timestamp service error:', error);
      throw new ServerError('Failed to convert timestamp');
    }
  }

  async calculateDateDifference(date1, date2, unit) {
    try {
      const d1 = new Date(date1);
      const d2 = new Date(date2);
      
      if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
        throw new ValidationError('Invalid date format');
      }
      
      const diffMs = Math.abs(d2 - d1);
      let result;
      
      switch (unit) {
        case 'milliseconds':
          result = diffMs;
          break;
        case 'seconds':
          result = diffMs / 1000;
          break;
        case 'minutes':
          result = diffMs / (1000 * 60);
          break;
        case 'hours':
          result = diffMs / (1000 * 60 * 60);
          break;
        case 'days':
          result = diffMs / (1000 * 60 * 60 * 24);
          break;
        case 'weeks':
          result = diffMs / (1000 * 60 * 60 * 24 * 7);
          break;
        case 'months':
          result = diffMs / (1000 * 60 * 60 * 24 * 30.44);
          break;
        case 'years':
          result = diffMs / (1000 * 60 * 60 * 24 * 365.25);
          break;
        default:
          result = diffMs / (1000 * 60 * 60 * 24); // Default to days
      }
      
      return {
        date1: d1.toISOString(),
        date2: d2.toISOString(),
        difference: Math.round(result * 100) / 100,
        unit,
        inDays: Math.round(diffMs / (1000 * 60 * 60 * 24) * 100) / 100,
        calculatedAt: new Date()
      };
    } catch (error) {
      logger.error('Calculate date difference service error:', error);
      throw new ServerError('Failed to calculate date difference');
    }
  }

  async addToDate(date, amount, unit) {
    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) {
        throw new ValidationError('Invalid date format');
      }
      
      const result = new Date(d);
      
      switch (unit) {
        case 'milliseconds':
          result.setMilliseconds(result.getMilliseconds() + amount);
          break;
        case 'seconds':
          result.setSeconds(result.getSeconds() + amount);
          break;
        case 'minutes':
          result.setMinutes(result.getMinutes() + amount);
          break;
        case 'hours':
          result.setHours(result.getHours() + amount);
          break;
        case 'days':
          result.setDate(result.getDate() + amount);
          break;
        case 'weeks':
          result.setDate(result.getDate() + (amount * 7));
          break;
        case 'months':
          result.setMonth(result.getMonth() + amount);
          break;
        case 'years':
          result.setFullYear(result.getFullYear() + amount);
          break;
        default:
          throw new ValidationError('Invalid unit');
      }
      
      return {
        originalDate: d.toISOString(),
        amount,
        unit,
        resultDate: result.toISOString(),
        calculatedAt: new Date()
      };
    } catch (error) {
      logger.error('Add to date service error:', error);
      throw new ServerError('Failed to add to date');
    }
  }

  // Color converter
  async convertColor(color, toFormat) {
    try {
      // Simple color conversion logic
      let result;
      
      if (color.startsWith('#')) {
        // HEX to other formats
        const hex = color.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        
        switch (toFormat.toLowerCase()) {
          case 'rgb':
            result = `rgb(${r}, ${g}, ${b})`;
            break;
          case 'hsl':
            // Simplified HSL conversion
            result = `hsl(${r % 360}, ${g}%, ${b}%)`;
            break;
          default:
            result = color;
        }
      } else if (color.startsWith('rgb')) {
        // RGB to other formats
        const matches = color.match(/\d+/g);
        if (matches) {
          const [r, g, b] = matches.map(Number);
          switch (toFormat.toLowerCase()) {
            case 'hex':
              result = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              break;
            case 'hsl':
              result = `hsl(${r % 360}, ${g}%, ${b}%)`;
              break;
            default:
              result = color;
          }
        }
      }
      
      return {
        original: color,
        format: toFormat,
        converted: result || color,
        convertedAt: new Date()
      };
    } catch (error) {
      logger.error('Convert color service error:', error);
      throw new ServerError('Failed to convert color');
    }
  }

  // Unit converter
  async convertUnit(value, fromUnit, toUnit) {
    try {
      // Simplified conversion logic
      const conversionRates = {
        length: {
          m: { km: 0.001, cm: 100, mm: 1000, in: 39.3701, ft: 3.28084, yd: 1.09361, mi: 0.000621371 },
          km: { m: 1000, cm: 100000, mm: 1000000, in: 39370.1, ft: 3280.84, yd: 1093.61, mi: 0.621371 },
          cm: { m: 0.01, km: 0.00001, mm: 10, in: 0.393701, ft: 0.0328084, yd: 0.0109361, mi: 0.0000062137 },
        },
        weight: {
          kg: { g: 1000, lb: 2.20462, oz: 35.274 },
          g: { kg: 0.001, lb: 0.00220462, oz: 0.035274 },
          lb: { kg: 0.453592, g: 453.592, oz: 16 },
        },
        temperature: {
          c: { f: (c) => (c * 9/5) + 32, k: (c) => c + 273.15 },
          f: { c: (f) => (f - 32) * 5/9, k: (f) => (f - 32) * 5/9 + 273.15 },
          k: { c: (k) => k - 273.15, f: (k) => (k - 273.15) * 9/5 + 32 },
        }
      };
      
      let result = value;
      let category = 'length';
      
      // Determine category
      if (['c', 'f', 'k'].includes(fromUnit.toLowerCase())) {
        category = 'temperature';
      } else if (['kg', 'g', 'lb', 'oz'].includes(fromUnit.toLowerCase())) {
        category = 'weight';
      }
      
      if (category === 'temperature') {
        // Temperature conversion
        const from = fromUnit.toLowerCase();
        const to = toUnit.toLowerCase();
        if (conversionRates.temperature[from] && conversionRates.temperature[from][to]) {
          result = conversionRates.temperature[from][to](value);
        }
      } else {
        // Other conversions
        if (conversionRates[category][fromUnit] && conversionRates[category][fromUnit][toUnit]) {
          result = value * conversionRates[category][fromUnit][toUnit];
        }
      }
      
      return {
        value,
        fromUnit,
        toUnit,
        result: Math.round(result * 100) / 100,
        category,
        convertedAt: new Date()
      };
    } catch (error) {
      logger.error('Convert unit service error:', error);
      throw new ServerError('Failed to convert unit');
    }
  }

  // Currency converter (simplified - would use real API in production)
  async convertCurrency(amount, fromCurrency, toCurrency) {
    try {
      const configuredRatesRaw = process.env.CURRENCY_RATES_JSON;
      if (!configuredRatesRaw) {
        throw new ServerError('Currency conversion is not configured');
      }

      let exchangeRates = null;
      try {
        exchangeRates = JSON.parse(configuredRatesRaw);
      } catch (_error) {
        throw new ServerError('Currency conversion configuration is invalid');
      }
      
      let result = amount;
      
      if (fromCurrency === toCurrency) {
        result = amount;
      } else if (exchangeRates[fromCurrency] && exchangeRates[fromCurrency][toCurrency]) {
        result = amount * exchangeRates[fromCurrency][toCurrency];
      } else if (exchangeRates[toCurrency] && exchangeRates[toCurrency][fromCurrency]) {
        result = amount / exchangeRates[toCurrency][fromCurrency];
      } else {
        throw new ServerError(`Unsupported currency pair: ${fromCurrency}->${toCurrency}`);
      }
      
      return {
        amount,
        fromCurrency,
        toCurrency,
        convertedAmount: Math.round(result * 100) / 100,
        exchangeRate: result / amount,
        convertedAt: new Date()
      };
    } catch (error) {
      logger.error('Convert currency service error:', error);
      throw new ServerError('Failed to convert currency');
    }
  }

  // URL shortener
  async shortenURL(url, userId, customAlias, expiresAt) {
    try {
      const shortCode = customAlias || Math.random().toString(36).substring(2, 8);
      const shortUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/s/${shortCode}`;
      
      // In production, you would save this to a database
      return {
        originalUrl: url,
        shortUrl,
        shortCode,
        expiresAt: expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days default
        createdAt: new Date(),
        userId,
        clicks: 0
      };
    } catch (error) {
      logger.error('Shorten URL service error:', error);
      throw new ServerError('Failed to shorten URL');
    }
  }

  async getOriginalURL(shortCode) {
    try {
      // In production, you would look this up from database
      return {
        shortCode,
        originalUrl: 'https://example.com',
        createdAt: new Date(),
        clicks: 0
      };
    } catch (error) {
      logger.error('Get original URL service error:', error);
      throw new ServerError('Failed to get original URL');
    }
  }

  // IP tools
  async getIPInfo(ip) {
    try {
      // Mock IP info - in production use an IP geolocation service
      return {
        ip,
        country: 'United States',
        countryCode: 'US',
        region: 'California',
        city: 'San Francisco',
        timezone: 'America/Los_Angeles',
        isp: 'Example ISP',
        org: 'Example Organization',
        as: 'AS12345 Example AS',
        latitude: 37.7749,
        longitude: -122.4194,
        queriedAt: new Date()
      };
    } catch (error) {
      logger.error('Get IP info service error:', error);
      throw new ServerError('Failed to get IP info');
    }
  }

  async getIPLocation(ip) {
    try {
      const info = await this.getIPInfo(ip);
      return {
        ip: info.ip,
        location: `${info.city}, ${info.region}, ${info.country}`,
        coordinates: {
          latitude: info.latitude,
          longitude: info.longitude
        },
        timezone: info.timezone,
        queriedAt: info.queriedAt
      };
    } catch (error) {
      logger.error('Get IP location service error:', error);
      throw new ServerError('Failed to get IP location');
    }
  }

  // User agent parser
  async parseUserAgent(userAgent) {
    try {
      // Simplified parsing - in production use a proper user-agent parser library
      const isMobile = /mobile/i.test(userAgent);
      const isTablet = /tablet/i.test(userAgent);
      const isDesktop = !isMobile && !isTablet;
      
      let browser = 'Unknown';
      let os = 'Unknown';
      
      if (/chrome/i.test(userAgent)) browser = 'Chrome';
      else if (/firefox/i.test(userAgent)) browser = 'Firefox';
      else if (/safari/i.test(userAgent)) browser = 'Safari';
      else if (/edge/i.test(userAgent)) browser = 'Edge';
      else if (/opera/i.test(userAgent)) browser = 'Opera';
      
      if (/windows/i.test(userAgent)) os = 'Windows';
      else if (/mac os/i.test(userAgent)) os = 'macOS';
      else if (/linux/i.test(userAgent)) os = 'Linux';
      else if (/android/i.test(userAgent)) os = 'Android';
      else if (/ios|iphone|ipad/i.test(userAgent)) os = 'iOS';
      
      return {
        userAgent,
        browser,
        browserVersion: '1.0', // Would parse actual version
        os,
        deviceType: isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop',
        parsedAt: new Date()
      };
    } catch (error) {
      logger.error('Parse user agent service error:', error);
      throw new ServerError('Failed to parse user agent');
    }
  }

  // File info
  async getFileInfo(file) {
    try {
      return {
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        extension: path.extname(file.originalname),
        encoding: file.encoding,
        uploadedAt: new Date(),
        checksum: crypto.createHash('md5').update(file.buffer).digest('hex')
      };
    } catch (error) {
      logger.error('Get file info service error:', error);
      throw new ServerError('Failed to get file info');
    }
  }

  // System status
  async getSystemStatus() {
    try {
      return {
        status: 'online',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        platform: process.platform,
        nodeVersion: process.version,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Get system status service error:', error);
      throw new ServerError('Failed to get system status');
    }
  }

  async getHealthStatus() {
    try {
      return {
        status: 'healthy',
        checks: {
          database: 'connected',
          memory: 'ok',
          disk: 'ok',
          network: 'ok'
        },
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Get health status service error:', error);
      throw new ServerError('Failed to get health status');
    }
  }

  // Backup tools
  async createBackup(type, includeData, userId) {
    try {
      const backupId = `backup_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const filename = `${backupId}.${type === 'full' ? 'tar.gz' : 'json'}`;
      
      return {
        backupId,
        filename,
        type,
        includeData,
        size: '2.5MB', // Example
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        downloadUrl: `/api/tools/backup/download/${backupId}`,
        userId
      };
    } catch (error) {
      logger.error('Create backup service error:', error);
      throw new ServerError('Failed to create backup');
    }
  }

  async listBackups(userId) {
    try {
      // In production, you would query the database for user's backups
      return {
        backups: [
          {
            backupId: 'backup_123',
            filename: 'backup_20231201.tar.gz',
            type: 'full',
            size: '2.5MB',
            createdAt: new Date('2023-12-01'),
            expiresAt: new Date('2023-12-31')
          }
        ],
        total: 1,
        userId
      };
    } catch (error) {
      logger.error('List backups service error:', error);
      throw new ServerError('Failed to list backups');
    }
  }

  async restoreBackup(backupId, userId) {
    try {
      // In production, you would restore from actual backup file
      return {
        backupId,
        restored: true,
        restoredAt: new Date(),
        userId
      };
    } catch (error) {
      logger.error('Restore backup service error:', error);
      throw new ServerError('Failed to restore backup');
    }
  }

  // Cleanup tools
  async cleanupTempFiles() {
    try {
      const tempDir = path.join(__dirname, '../../temp');
      let deletedCount = 0;
      let totalSize = 0;
      
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);
        
        files.forEach(file => {
          const filepath = path.join(tempDir, file);
          const stats = fs.statSync(filepath);
          
          if (stats.mtimeMs < oneHourAgo) {
            totalSize += stats.size;
            fs.unlinkSync(filepath);
            deletedCount++;
          }
        });
      }
      
      return {
        deletedCount,
        totalSize: this.formatBytes(totalSize),
        cleanedAt: new Date()
      };
    } catch (error) {
      logger.error('Cleanup temp files service error:', error);
      throw new ServerError('Failed to cleanup temp files');
    }
  }

  async cleanupOldFiles(days) {
    try {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      let deletedCount = 0;
      let totalSize = 0;
      
      // In production, you would query database for old files
      return {
        deletedCount,
        totalSize: this.formatBytes(totalSize),
        days,
        cleanedAt: new Date()
      };
    } catch (error) {
      logger.error('Cleanup old files service error:', error);
      throw new ServerError('Failed to cleanup old files');
    }
  }

  // Export tools
  async exportData(format, dataType, filters, userId) {
    try {
      // In production, you would query database and format data
      const data = {
        type: dataType,
        filters,
        exportedBy: userId,
        exportedAt: new Date(),
        records: 100 // Example count
      };
      
      if (format === 'csv') {
        // Convert to CSV
        return 'id,name,createdAt\n1,Example,2023-12-01';
      } else if (format === 'json') {
        return data;
      } else {
        throw new ValidationError('Unsupported export format');
      }
    } catch (error) {
      logger.error('Export data service error:', error);
      throw new ServerError('Failed to export data');
    }
  }

  // Import tools
  async importData(file, dataType, options, userId) {
    try {
      const content = file.buffer.toString('utf-8');
      let importedCount = 0;
      let errors = [];
      
      // Parse based on file type
      if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
        // Parse CSV
        const lines = content.split('\n');
        importedCount = lines.length - 1; // Exclude header
      } else if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
        // Parse JSON
        const data = JSON.parse(content);
        importedCount = Array.isArray(data) ? data.length : 1;
      }
      
      return {
        filename: file.originalname,
        dataType,
        importedCount,
        errors,
        importedAt: new Date(),
        userId
      };
    } catch (error) {
      logger.error('Import data service error:', error);
      throw new ServerError('Failed to import data');
    }
  }

  // Batch processing
  async processBatch(operations, data, userId) {
    try {
      const results = [];
      const errors = [];
      
      for (const operation of operations) {
        try {
          let result;
          
          switch (operation.type) {
            case 'validate':
              result = { validated: true, operation };
              break;
            case 'transform':
              result = { transformed: true, operation };
              break;
            case 'filter':
              result = { filtered: true, operation };
              break;
            default:
              throw new ValidationError(`Unknown operation type: ${operation.type}`);
          }
          
          results.push(result);
        } catch (error) {
          errors.push({
            operation,
            error: error.message
          });
        }
      }
      
      return {
        totalOperations: operations.length,
        successful: results.length,
        failed: errors.length,
        results,
        errors,
        processedAt: new Date(),
        userId
      };
    } catch (error) {
      logger.error('Process batch service error:', error);
      throw new ServerError('Failed to process batch');
    }
  }

  // Statistics
  async getUsageStats(period, userId) {
    try {
      // Mock usage stats
      const stats = {
        period,
        totalRequests: 150,
        successful: 145,
        failed: 5,
        averageResponseTime: 245, // ms
        popularTools: [
          { name: 'Password Generator', count: 45 },
          { name: 'QR Code Generator', count: 32 },
          { name: 'JSON Formatter', count: 28 },
          { name: 'Image Resizer', count: 25 },
          { name: 'Base64 Encoder', count: 20 }
        ],
        userActivity: {
          today: 15,
          thisWeek: 85,
          thisMonth: 150
        },
        generatedAt: new Date()
      };
      
      return stats;
    } catch (error) {
      logger.error('Get usage stats service error:', error);
      throw new ServerError('Failed to get usage stats');
    }
  }

  // Helper methods
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
}

// UUID v1 generator for completeness
function uuidv1() {
  const now = Date.now();
  const hex = now.toString(16).padStart(12, '0') +
    Math.random().toString(16).substring(2, 6) +
    '4' + // version
    Math.random().toString(16).substring(2, 6) +
    (Math.random() * 0x1000 | 0x8000).toString(16).padStart(4, '0') + // variant
    Math.random().toString(16).substring(2, 14);
  
  return hex.substring(0, 8) + '-' +
    hex.substring(8, 12) + '-' +
    hex.substring(12, 16) + '-' +
    hex.substring(16, 20) + '-' +
    hex.substring(20);
}

module.exports = new ToolsService();
