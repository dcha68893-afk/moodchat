const { body, query, param, validationResult } = require('express-validator');
const validator = require('validator');
const { ValidationError } = require('./errors');

/**
 * Validation middleware for all API endpoints
 */
const authValidation = {
  /**
   * Validate registration input
   */
  register: [
    body('username')
      .trim()
      .notEmpty()
      .withMessage('Username is required')
      .isLength({ min: 3, max: 30 })
      .withMessage('Username must be between 3 and 30 characters')
      .matches(/^[a-zA-Z0-9_-]+$/)
      .withMessage('Username can only contain letters, numbers, underscores, and hyphens'),
    
    body('email')
      .trim()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('Invalid email format')
      .normalizeEmail()
      .custom(async (email) => {
        if (validator.isDisposableEmail(email)) {
          throw new Error('Disposable email addresses are not allowed');
        }
        return true;
      }),
    
    body('password')
      .notEmpty()
      .withMessage('Password is required')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters long')
      .matches(/[A-Z]/)
      .withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/)
      .withMessage('Password must contain at least one lowercase letter')
      .matches(/\d/)
      .withMessage('Password must contain at least one number')
      .matches(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/)
      .withMessage('Password must contain at least one special character'),
    
    body('firstName')
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage('First name cannot exceed 50 characters'),
    
    body('lastName')
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage('Last name cannot exceed 50 characters'),
  ],

  /**
   * Validate login input
   */
  login: [
    body('identifier')
      .trim()
      .notEmpty()
      .withMessage('Email or username is required'),
    
    body('password')
      .notEmpty()
      .withMessage('Password is required'),
  ],

  /**
   * Validate refresh token
   */
  refreshToken: [
    body('refreshToken')
      .notEmpty()
      .withMessage('Refresh token is required'),
  ],

  /**
   * Validate logout
   */
  logout: [
    body('refreshToken')
      .optional()
      .notEmpty()
      .withMessage('Refresh token cannot be empty if provided'),
  ],

  /**
   * Validate password reset request
   */
  requestPasswordReset: [
    body('email')
      .trim()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('Invalid email format')
      .normalizeEmail(),
  ],

  /**
   * Validate password reset
   */
  resetPassword: [
    body('token')
      .notEmpty()
      .withMessage('Reset token is required'),
    
    body('newPassword')
      .notEmpty()
      .withMessage('New password is required')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters long')
      .matches(/[A-Z]/)
      .withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/)
      .withMessage('Password must contain at least one lowercase letter')
      .matches(/\d/)
      .withMessage('Password must contain at least one number')
      .matches(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/)
      .withMessage('Password must contain at least one special character'),
  ],

  /**
   * Validate email verification
   */
  verifyEmail: [
    query('token')
      .notEmpty()
      .withMessage('Verification token is required'),
  ],
};

/**
 * Friend validation
 */
const friendValidation = {
  sendRequest: [
    body('receiverId')
      .notEmpty()
      .withMessage('Receiver ID is required')
      .isMongoId()
      .withMessage('Invalid receiver ID format'),
  ],

  respondToRequest: [
    param('requestId')
      .notEmpty()
      .withMessage('Request ID is required')
      .isMongoId()
      .withMessage('Invalid request ID format'),
    
    body('action')
      .notEmpty()
      .withMessage('Action is required')
      .isIn(['accept', 'reject', 'cancel'])
      .withMessage('Action must be accept, reject, or cancel'),
  ],

  removeFriend: [
    param('friendId')
      .notEmpty()
      .withMessage('Friend ID is required')
      .isMongoId()
      .withMessage('Invalid friend ID format'),
  ],
};

/**
 * Chat validation
 */
const chatValidation = {
  createDirectChat: [
    body('participantId')
      .notEmpty()
      .withMessage('Participant ID is required')
      .isMongoId()
      .withMessage('Invalid participant ID format'),
  ],

  createGroupChat: [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Group name is required')
      .isLength({ min: 3, max: 100 })
      .withMessage('Group name must be between 3 and 100 characters'),
    
    body('participantIds')
      .isArray()
      .withMessage('Participant IDs must be an array')
      .custom((ids) => ids.length >= 1)
      .withMessage('At least one participant is required')
      .custom((ids) => ids.every(id => validator.isMongoId(id)))
      .withMessage('All participant IDs must be valid'),
  ],

  updateGroup: [
    param('chatId')
      .notEmpty()
      .withMessage('Chat ID is required')
      .isMongoId()
      .withMessage('Invalid chat ID format'),
    
    body('name')
      .optional()
      .trim()
      .isLength({ min: 3, max: 100 })
      .withMessage('Group name must be between 3 and 100 characters'),
    
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description cannot exceed 500 characters'),
  ],
};

/**
 * Message validation
 */
const messageValidation = {
  sendMessage: [
    param('chatId')
      .notEmpty()
      .withMessage('Chat ID is required')
      .isMongoId()
      .withMessage('Invalid chat ID format'),
    
    body('content')
      .trim()
      .notEmpty()
      .withMessage('Message content is required')
      .isLength({ max: 5000 })
      .withMessage('Message content cannot exceed 5000 characters'),
    
    body('type')
      .optional()
      .isIn(['text', 'image', 'file', 'system'])
      .withMessage('Message type must be text, image, file, or system'),
  ],

  updateMessage: [
    param('messageId')
      .notEmpty()
      .withMessage('Message ID is required')
      .isMongoId()
      .withMessage('Invalid message ID format'),
    
    body('content')
      .trim()
      .notEmpty()
      .withMessage('Message content is required')
      .isLength({ max: 5000 })
      .withMessage('Message content cannot exceed 5000 characters'),
  ],
};

/**
 * Mood validation
 */
const moodValidation = {
  trackMood: [
    body('mood')
      .notEmpty()
      .withMessage('Mood is required')
      .isIn(['happy', 'sad', 'neutral', 'angry', 'anxious', 'excited', 'tired', 'stressed'])
      .withMessage('Invalid mood value'),
    
    body('intensity')
      .optional()
      .isInt({ min: 1, max: 10 })
      .withMessage('Intensity must be between 1 and 10'),
    
    body('notes')
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Notes cannot exceed 1000 characters'),
  ],

  getMoodHistory: [
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be in ISO format'),
    
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be in ISO format'),
  ],
};

/**
 * Pagination validation
 */
const paginationValidation = {
  paginate: [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer')
      .toInt(),
    
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
      .toInt(),
    
    query('sortBy')
      .optional()
      .isString()
      .withMessage('Sort by must be a string'),
    
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc'),
  ],
};

/**
 * User validation
 */
const userValidation = {
  updateProfile: [
    body('firstName')
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage('First name cannot exceed 50 characters'),
    
    body('lastName')
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage('Last name cannot exceed 50 characters'),
    
    body('bio')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Bio cannot exceed 500 characters'),
    
    body('phone')
      .optional()
      .trim()
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage('Invalid phone number format'),
    
    body('status')
      .optional()
      .isIn(['online', 'away', 'busy', 'offline', 'custom'])
      .withMessage('Invalid status value'),
    
    body('customStatus')
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Custom status cannot exceed 100 characters'),
  ],

  updateSettings: [
    body('settings')
      .isObject()
      .withMessage('Settings must be an object'),
    
    body('settings.notifications')
      .optional()
      .isObject()
      .withMessage('Notifications must be an object'),
    
    body('settings.privacy')
      .optional()
      .isObject()
      .withMessage('Privacy must be an object'),
    
    body('settings.theme')
      .optional()
      .isIn(['light', 'dark', 'auto'])
      .withMessage('Theme must be light, dark, or auto'),
  ],
};

/**
 * Async-safe validation handler
 */
const validate = (validations) => {
  return async (req, res, next) => {
    try {
      // Run all validations
      await Promise.all(validations.map(validation => validation.run(req)));

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const errorMessages = errors.array().map(err => ({
          field: err.path,
          message: err.msg
        }));

        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errorMessages
        });
      }

      next();
    } catch (error) {
      console.error('Validation middleware error:', error);
      return res.status(500).json({
        success: false,
        message: 'Validation error occurred'
      });
    }
  };
};

/**
 * Manual validation helper for use outside middleware
 */
const manualValidate = async (data, validations) => {
  const req = { body: data };
  
  for (const validation of validations) {
    await validation.run(req);
  }
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => ({
      field: err.path,
      message: err.msg
    }));
    throw new ValidationError('Validation failed', errorMessages);
  }
  
  return true;
};

module.exports = {
  authValidation,
  friendValidation,
  chatValidation,
  messageValidation,
  moodValidation,
  paginationValidation,
  userValidation,
  validate,
  manualValidate,
};