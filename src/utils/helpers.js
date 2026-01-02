const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const logger = require('./logger');

class Helpers {
  /**
   * Generate a random string of specified length
   */
  static generateRandomString(length = 32) {
    return crypto
      .randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length);
  }

  /**
   * Generate a unique ID
   */
  static generateId(prefix = '') {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `${prefix}${timestamp}${random}`.toUpperCase();
  }

  /**
   * Hash a string using bcrypt
   */
  static async hashString(string, saltRounds = 12) {
    try {
      const salt = await bcrypt.genSalt(saltRounds);
      const hash = await bcrypt.hash(string, salt);
      return hash;
    } catch (error) {
      logger.error('Hash string error:', error);
      throw error;
    }
  }

  /**
   * Compare a string with a hash
   */
  static async compareHash(string, hash) {
    try {
      return await bcrypt.compare(string, hash);
    } catch (error) {
      logger.error('Compare hash error:', error);
      throw error;
    }
  }

  /**
   * Generate a verification code (e.g., for email verification)
   */
  static generateVerificationCode(length = 6) {
    const digits = '0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += digits.charAt(Math.floor(Math.random() * digits.length));
    }
    return code;
  }

  /**
   * Format a date to ISO string
   */
  static formatDate(date = new Date()) {
    return date.toISOString();
  }

  /**
   * Format a date to human-readable string
   */
  static formatDateHuman(date = new Date()) {
    const options = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    return date.toLocaleDateString('en-US', options);
  }

  /**
   * Calculate time difference in human-readable format
   */
  static timeDifference(fromDate, toDate = new Date()) {
    const diff = Math.abs(toDate - fromDate);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years > 0) return `${years} year${years > 1 ? 's' : ''} ago`;
    if (months > 0) return `${months} month${months > 1 ? 's' : ''} ago`;
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
  }

  /**
   * Truncate a string to specified length
   */
  static truncateString(str, length = 100, suffix = '...') {
    if (str.length <= length) return str;
    return str.substring(0, length - suffix.length) + suffix;
  }

  /**
   * Sanitize user input
   */
  static sanitizeInput(input) {
    if (typeof input === 'string') {
      return validator.escape(validator.trim(input));
    }
    if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    }
    if (typeof input === 'object' && input !== null) {
      const sanitized = {};
      for (const key in input) {
        sanitized[key] = this.sanitizeInput(input[key]);
      }
      return sanitized;
    }
    return input;
  }

  /**
   * Validate email address
   */
  static isValidEmail(email) {
    return validator.isEmail(email) && email.length <= 100;
  }

  /**
   * Validate phone number
   */
  static isValidPhone(phone) {
    return validator.isMobilePhone(phone, 'any', { strictMode: false });
  }

  /**
   * Validate URL
   */
  static isValidUrl(url) {
    return validator.isURL(url, {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_valid_protocol: true,
    });
  }

  /**
   * Generate a slug from a string
   */
  static generateSlug(str) {
    return str
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Extract mentions from text
   */
  static extractMentions(text) {
    const mentionRegex = /@(\w+)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      mentions.push(match[1]);
    }
    return [...new Set(mentions)]; // Remove duplicates
  }

  /**
   * Extract hashtags from text
   */
  static extractHashtags(text) {
    const hashtagRegex = /#(\w+)/g;
    const hashtags = [];
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtags.push(match[1]);
    }
    return [...new Set(hashtags)]; // Remove duplicates
  }

  /**
   * Parse JSON safely
   */
  static safeJsonParse(str, defaultValue = {}) {
    try {
      return JSON.parse(str);
    } catch (error) {
      logger.warn('JSON parse error:', error);
      return defaultValue;
    }
  }

  /**
   * Stringify JSON safely
   */
  static safeJsonStringify(obj, defaultValue = '{}') {
    try {
      return JSON.stringify(obj);
    } catch (error) {
      logger.warn('JSON stringify error:', error);
      return defaultValue;
    }
  }

  /**
   * Deep clone an object
   */
  static deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Merge objects deeply
   */
  static deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  /**
   * Check if value is an object
   */
  static isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Create a delay promise
   */
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retry a function with exponential backoff
   */
  static async retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (i < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, i);
          logger.warn(`Retry ${i + 1}/${maxRetries} after ${delay}ms`);
          await this.delay(delay);
        }
      }
    }
    throw lastError;
  }

  /**
   * Generate pagination metadata
   */
  static generatePagination(total, page, limit) {
    const totalPages = Math.ceil(total / limit);
    return {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Calculate file size in human-readable format
   */
  static formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Get file extension from filename
   */
  static getFileExtension(filename) {
    return filename.slice(((filename.lastIndexOf('.') - 1) >>> 0) + 2);
  }

  /**
   * Get MIME type from filename
   */
  static getMimeType(filename) {
    const ext = this.getFileExtension(filename).toLowerCase();
    const mimeTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Send email (mock implementation - would integrate with email service)
   */
  static async sendEmail(emailData) {
    logger.info('Sending email:', {
      to: emailData.to,
      subject: emailData.subject,
      template: emailData.template,
    });

    // In production, this would integrate with an email service like SendGrid, AWS SES, etc.
    return {
      success: true,
      messageId: `mock-email-${Date.now()}`,
    };
  }

  /**
   * Send SMS (mock implementation - would integrate with SMS service)
   */
  static async sendSMS(phone, message) {
    logger.info('Sending SMS:', { phone, messageLength: message.length });

    // In production, this would integrate with an SMS service like Twilio, AWS SNS, etc.
    return {
      success: true,
      messageId: `mock-sms-${Date.now()}`,
    };
  }
}

module.exports = Helpers;
