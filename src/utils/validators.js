const mongoose = require('mongoose');
const { ValidationError } = require('./errors');

/**
 * Validation utilities for input sanitization and validation
 */
class Validators {
  /**
   * Validate email format
   * @param {string} email - Email to validate
   * @returns {boolean} True if valid
   */
  static validateEmail(email) {
    if (!email || typeof email !== 'string') return false;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  }

  /**
   * Validate password strength
   * @param {string} password - Password to validate
   * @returns {Object} Validation result with isValid and message
   */
  static validatePassword(password) {
    if (!password || typeof password !== 'string') {
      return { isValid: false, message: 'Password is required' };
    }

    const trimmedPassword = password.trim();

    // Minimum length check
    if (trimmedPassword.length < 8) {
      return { isValid: false, message: 'Password must be at least 8 characters long' };
    }

    // Complexity checks
    const hasUpperCase = /[A-Z]/.test(trimmedPassword);
    const hasLowerCase = /[a-z]/.test(trimmedPassword);
    const hasNumbers = /\d/.test(trimmedPassword);
    const hasSpecialChar = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(trimmedPassword);

    if (!hasUpperCase) {
      return { isValid: false, message: 'Password must contain at least one uppercase letter' };
    }

    if (!hasLowerCase) {
      return { isValid: false, message: 'Password must contain at least one lowercase letter' };
    }

    if (!hasNumbers) {
      return { isValid: false, message: 'Password must contain at least one number' };
    }

    if (!hasSpecialChar) {
      return { isValid: false, message: 'Password must contain at least one special character' };
    }

    return { isValid: true, message: 'Password is valid' };
  }

  /**
   * Validate username
   * @param {string} username - Username to validate
   * @returns {Object} Validation result
   */
  static validateUsername(username) {
    if (!username || typeof username !== 'string') {
      return { isValid: false, message: 'Username is required' };
    }

    const trimmedUsername = username.trim();

    // Length check
    if (trimmedUsername.length < 3 || trimmedUsername.length > 30) {
      return { isValid: false, message: 'Username must be between 3 and 30 characters' };
    }

    // Character check (alphanumeric, underscore, hyphen)
    const usernameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!usernameRegex.test(trimmedUsername)) {
      return {
        isValid: false,
        message: 'Username can only contain letters, numbers, underscores, and hyphens',
      };
    }

    return { isValid: true, message: 'Username is valid' };
  }

  /**
   * Validate MongoDB ObjectId
   * @param {string} id - ID to validate
   * @returns {boolean} True if valid ObjectId
   */
  static validateObjectId(id) {
    if (!id || typeof id !== 'string') return false;
    return mongoose.Types.ObjectId.isValid(id) && new mongoose.Types.ObjectId(id).toString() === id;
  }

  /**
   * Sanitize and validate text input
   * @param {string} text - Text to sanitize
   * @param {Object} options - Validation options
   * @returns {string} Sanitized text
   */
  static sanitizeText(text, options = {}) {
    if (!text || typeof text !== 'string') {
      if (options.required) {
        throw new ValidationError(`${options.fieldName || 'Text'} is required`);
      }
      return '';
    }

    let sanitized = text.trim();

    // Remove excessive whitespace
    sanitized = sanitized.replace(/\s+/g, ' ');

    // Apply length constraints
    if (options.maxLength && sanitized.length > options.maxLength) {
      throw new ValidationError(
        `${options.fieldName || 'Text'} cannot exceed ${options.maxLength} characters`
      );
    }

    if (options.minLength && sanitized.length < options.minLength) {
      throw new ValidationError(
        `${options.fieldName || 'Text'} must be at least ${options.minLength} characters`
      );
    }

    // Apply character restrictions if specified
    if (options.allowedPattern) {
      const regex = new RegExp(options.allowedPattern);
      if (!regex.test(sanitized)) {
        throw new ValidationError(`${options.fieldName || 'Text'} contains invalid characters`);
      }
    }

    // Escape HTML if not allowed
    if (!options.allowHTML) {
      sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
    }

    return sanitized;
  }

  /**
   * Validate message content
   * @param {string} content - Message content
   * @param {string} type - Message type (text, image, file, etc.)
   * @returns {Object} Validation result
   */
  static validateMessageContent(content, type = 'text') {
    if (!content) {
      return { isValid: false, message: 'Message content is required' };
    }

    const maxLengths = {
      text: 5000,
      image: 500,
      file: 500,
      system: 1000,
    };

    const maxLength = maxLengths[type] || 5000;

    if (typeof content !== 'string') {
      return { isValid: false, message: 'Content must be a string' };
    }

    if (content.length > maxLength) {
      return { isValid: false, message: `Message content cannot exceed ${maxLength} characters` };
    }

    return { isValid: true, message: 'Content is valid' };
  }

  /**
   * Validate file upload metadata
   * @param {Object} fileData - File metadata
   * @param {Array} allowedTypes - Allowed MIME types
   * @param {number} maxSize - Maximum file size in bytes
   * @returns {Object} Validation result
   */
  static validateFile(fileData, allowedTypes = [], maxSize = 10 * 1024 * 1024) {
    if (!fileData || typeof fileData !== 'object') {
      return { isValid: false, message: 'File data is required' };
    }

    const { originalname, mimetype, size, buffer } = fileData;

    // Check if file has a name
    if (!originalname || typeof originalname !== 'string') {
      return { isValid: false, message: 'Invalid file name' };
    }

    // Check MIME type
    if (allowedTypes.length > 0 && !allowedTypes.includes(mimetype)) {
      return {
        isValid: false,
        message: `File type not allowed. Allowed types: ${allowedTypes.join(', ')}`,
      };
    }

    // Check file size
    if (size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);
      return { isValid: false, message: `File size exceeds maximum of ${maxSizeMB}MB` };
    }

    // Check if buffer exists (for uploaded files)
    if (buffer && (!Buffer.isBuffer(buffer) || buffer.length === 0)) {
      return { isValid: false, message: 'Invalid file data' };
    }

    // Validate file name length and characters
    if (originalname.length > 255) {
      return { isValid: false, message: 'File name too long' };
    }

    const fileNameRegex = /^[a-zA-Z0-9_\-. ]+$/;
    if (!fileNameRegex.test(originalname)) {
      return { isValid: false, message: 'File name contains invalid characters' };
    }

    return { isValid: true, message: 'File is valid' };
  }

  /**
   * Validate date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {Object} options - Validation options
   * @returns {boolean} True if valid
   */
  static validateDateRange(startDate, endDate, options = {}) {
    if (!startDate || !endDate) {
      throw new ValidationError('Both start date and end date are required');
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new ValidationError('Invalid date format');
    }

    if (start > end) {
      throw new ValidationError('Start date must be before end date');
    }

    if (options.maxRangeDays) {
      const diffInDays = (end - start) / (1000 * 60 * 60 * 24);
      if (diffInDays > options.maxRangeDays) {
        throw new ValidationError(`Date range cannot exceed ${options.maxRangeDays} days`);
      }
    }

    return true;
  }

  /**
   * Validate pagination parameters
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @param {Object} options - Validation options
   * @returns {Object} Validated pagination
   */
  static validatePagination(page, limit, options = {}) {
    const defaultPage = options.defaultPage || 1;
    const defaultLimit = options.defaultLimit || 20;
    const maxLimit = options.maxLimit || 100;
    const minLimit = options.minLimit || 1;

    // Convert to numbers
    let pageNum = parseInt(page);
    let limitNum = parseInt(limit);

    // Set defaults if invalid
    if (isNaN(pageNum) || pageNum < 1) {
      pageNum = defaultPage;
    }

    if (isNaN(limitNum) || limitNum < minLimit) {
      limitNum = defaultLimit;
    }

    // Apply maximum limit
    if (limitNum > maxLimit) {
      limitNum = maxLimit;
    }

    return {
      page: pageNum,
      limit: limitNum,
      skip: (pageNum - 1) * limitNum,
    };
  }

  /**
   * Validate URL
   * @param {string} url - URL to validate
   * @param {Object} options - Validation options
   * @returns {boolean} True if valid
   */
  static validateURL(url, options = {}) {
    if (!url || typeof url !== 'string') return false;

    try {
      const urlObj = new URL(url);

      // Validate protocol if specified
      if (options.allowedProtocols && !options.allowedProtocols.includes(urlObj.protocol)) {
        return false;
      }

      // Validate hostname if specified
      if (options.allowedDomains) {
        const domain = urlObj.hostname;
        const isAllowed = options.allowedDomains.some(
          allowedDomain => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`)
        );
        if (!isAllowed) return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate phone number (basic international format)
   * @param {string} phoneNumber - Phone number to validate
   * @returns {boolean} True if valid
   */
  static validatePhoneNumber(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') return false;

    // Basic international phone number validation
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    return phoneRegex.test(phoneNumber.replace(/[\s\-()]/g, ''));
  }

  /**
   * Validate search query
   * @param {string} query - Search query
   * @returns {Object} Validation result
   */
  static validateSearchQuery(query) {
    if (!query || typeof query !== 'string') {
      return { isValid: false, message: 'Search query is required' };
    }

    const trimmedQuery = query.trim();

    if (trimmedQuery.length < 1) {
      return { isValid: false, message: 'Search query cannot be empty' };
    }

    if (trimmedQuery.length > 100) {
      return { isValid: false, message: 'Search query cannot exceed 100 characters' };
    }

    // Prevent potentially malicious patterns
    const maliciousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+=/i,
      /eval\(/i,
      /union.*select/i,
      /drop.*table/i,
      /delete.*from/i,
      /insert.*into/i,
      /update.*set/i,
    ];

    for (const pattern of maliciousPatterns) {
      if (pattern.test(trimmedQuery)) {
        return { isValid: false, message: 'Invalid search query' };
      }
    }

    return { isValid: true, message: 'Search query is valid' };
  }

  /**
   * Validate user status
   * @param {string} status - Status type
   * @param {string} customStatus - Custom status text
   * @returns {Object} Validation result
   */
  static validateUserStatus(status, customStatus = null) {
    const validStatuses = ['online', 'away', 'busy', 'offline', 'custom'];

    if (!status || !validStatuses.includes(status)) {
      return { isValid: false, message: `Status must be one of: ${validStatuses.join(', ')}` };
    }

    if (status === 'custom') {
      if (!customStatus || typeof customStatus !== 'string') {
        return { isValid: false, message: 'Custom status text is required for custom status' };
      }

      const sanitizedCustom = customStatus.trim();
      if (sanitizedCustom.length < 1 || sanitizedCustom.length > 100) {
        return { isValid: false, message: 'Custom status must be between 1 and 100 characters' };
      }
    }

    return { isValid: true, message: 'Status is valid' };
  }

  /**
   * Validate call data
   * @param {Object} callData - Call data
   * @returns {Object} Validation result
   */
  static validateCallData(callData) {
    if (!callData || typeof callData !== 'object') {
      return { isValid: false, message: 'Call data is required' };
    }

    const { callType, isGroupCall } = callData;

    // Validate call type
    const validCallTypes = ['voice', 'video'];
    if (!callType || !validCallTypes.includes(callType)) {
      return { isValid: false, message: `Call type must be one of: ${validCallTypes.join(', ')}` };
    }

    // Validate group call participants if applicable
    if (isGroupCall) {
      const { participantIds } = callData;
      if (!participantIds || !Array.isArray(participantIds)) {
        return { isValid: false, message: 'Group calls require participant IDs array' };
      }

      if (participantIds.length < 2) {
        return { isValid: false, message: 'Group calls require at least 2 participants' };
      }
    } else {
      const { callerId, calleeId } = callData;
      if (!callerId || !calleeId) {
        return { isValid: false, message: 'Individual calls require caller and callee IDs' };
      }

      if (callerId === calleeId) {
        return { isValid: false, message: 'Caller and callee cannot be the same user' };
      }
    }

    return { isValid: true, message: 'Call data is valid' };
  }

  /**
   * Validate group data
   * @param {Object} groupData - Group data
   * @returns {Object} Validation result
   */
  static validateGroupData(groupData) {
    if (!groupData || typeof groupData !== 'object') {
      return { isValid: false, message: 'Group data is required' };
    }

    const { name, creatorId } = groupData;

    if (!name || typeof name !== 'string') {
      return { isValid: false, message: 'Group name is required' };
    }

    if (name.trim().length < 3 || name.trim().length > 100) {
      return { isValid: false, message: 'Group name must be between 3 and 100 characters' };
    }

    if (!creatorId) {
      return { isValid: false, message: 'Creator ID is required' };
    }

    if (!this.validateObjectId(creatorId)) {
      return { isValid: false, message: 'Invalid creator ID format' };
    }

    // Validate member IDs if provided
    if (groupData.memberIds && Array.isArray(groupData.memberIds)) {
      for (const memberId of groupData.memberIds) {
        if (!this.validateObjectId(memberId)) {
          return { isValid: false, message: 'Invalid member ID format' };
        }
      }
    }

    return { isValid: true, message: 'Group data is valid' };
  }

  /**
   * Sanitize and validate user input object
   * @param {Object} input - Input object to sanitize
   * @param {Array} allowedFields - Fields to allow
   * @returns {Object} Sanitized object
   */
  static sanitizeInputObject(input, allowedFields = []) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError('Invalid input format');
    }

    const sanitized = {};

    // Filter only allowed fields
    for (const field of allowedFields) {
      if (input[field] !== undefined) {
        // Deep copy to prevent reference issues
        sanitized[field] = this.deepSanitize(input[field]);
      }
    }

    return sanitized;
  }

  /**
   * Deep sanitize values
   * @private
   * @param {any} value - Value to sanitize
   * @returns {any} Sanitized value
   */
  static deepSanitize(value) {
    if (typeof value === 'string') {
      // Sanitize strings
      return this.sanitizeText(value, { allowHTML: false });
    } else if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        // Sanitize array elements
        return value.map(item => this.deepSanitize(item));
      } else {
        // Sanitize object properties
        const sanitized = {};
        for (const key in value) {
          sanitized[key] = this.deepSanitize(value[key]);
        }
        return sanitized;
      }
    }

    // Return other types as-is (numbers, booleans, null, etc.)
    return value;
  }
}

// Add these helper functions for express-validator
module.exports.isValidEmail = (email) => {
  return Validators.validateEmail(email);
};

module.exports.isValidPassword = (password) => {
  const result = Validators.validatePassword(password);
  return result.isValid;
};

// Also export the Validators class
module.exports.Validators = Validators;

