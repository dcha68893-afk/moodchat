const { body, param, query, validationResult } = require('express-validator');
const validator = require('validator');

// Validation error formatter
const formatValidationErrors = (errors) => {
  return errors.array().map(err => ({
    field: err.path,
    message: err.msg,
  }));
};

// Common validation function
const validate = validations => {
  return async (req, res, next) => {
    // Run all validations
    for (let validation of validations) {
      const result = await validation.run(req);
      if (result.errors.length) break;
    }

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    // Return JSON response with validation errors
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: formatValidationErrors(errors),
    });
  };
};

// Password validation helper
const isValidPassword = (value) => {
  // At least 8 characters
  if (value.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  
  // At least one uppercase letter
  if (!/[A-Z]/.test(value)) {
    throw new Error('Password must contain at least one uppercase letter');
  }
  
  // At least one lowercase letter
  if (!/[a-z]/.test(value)) {
    throw new Error('Password must contain at least one lowercase letter');
  }
  
  // At least one number
  if (!/[0-9]/.test(value)) {
    throw new Error('Password must contain at least one number');
  }
  
  // At least one special character
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) {
    throw new Error('Password must contain at least one special character');
  }
  
  return true;
};

// Email validation helper
const isValidEmail = (value) => {
  if (!validator.isEmail(value)) {
    throw new Error('Invalid email format');
  }
  
  // Check for common disposable email domains
  const disposableDomains = [
    'tempmail.com',
    'throwaway.com',
    'fakeinbox.com',
    'guerrillamail.com',
    'mailinator.com',
    'sharklasers.com',
    'yopmail.com',
    '10minutemail.com',
    'tempmailaddress.com'
  ];
  
  const domain = value.split('@')[1];
  if (disposableDomains.includes(domain)) {
    throw new Error('Disposable email addresses are not allowed');
  }
  
  return true;
};

// ========== AUTH VALIDATION ==========
const authValidation = {
  register: validate([
    // Username validation
    body('username')
      .notEmpty()
      .withMessage('Username is required')
      .trim()
      .isLength({ min: 3, max: 30 })
      .withMessage('Username must be 3-30 characters')
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage('Username can only contain letters, numbers, and underscores'),
    
    // Email validation
    body('email')
      .notEmpty()
      .withMessage('Email is required')
      .trim()
      .toLowerCase()
      .custom(isValidEmail)
      .withMessage('Invalid email format'),
    
    // Password validation
    body('password')
      .notEmpty()
      .withMessage('Password is required')
      .custom(isValidPassword)
      .withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character'),
    
    // Confirm password validation (optional but must match if present)
    body('confirmPassword')
      .optional()
      .custom((value, { req }) => {
        if (value && value !== req.body.password) {
          throw new Error('Passwords do not match');
        }
        return true;
      })
      .withMessage('Passwords do not match')
  ]),

  login: validate([
    // Identifier validation (email or username)
    body('identifier')
      .notEmpty()
      .withMessage('Email or username is required')
      .trim()
      .custom((value) => {
        // Check if it's an email
        if (validator.isEmail(value)) {
          return true;
        }
        
        // Check if it's a valid username
        if (/^[a-zA-Z0-9_]{3,30}$/.test(value)) {
          return true;
        }
        
        throw new Error('Identifier must be a valid email or username (3-30 characters, letters, numbers, underscores)');
      })
      .withMessage('Invalid identifier format'),
    
    // Password validation
    body('password')
      .notEmpty()
      .withMessage('Password is required')
  ]),

  refreshToken: validate([
    body('refreshToken')
      .notEmpty()
      .withMessage('Refresh token is required')
      .isString()
      .withMessage('Refresh token must be a string')
      .isLength({ min: 10 })
      .withMessage('Invalid refresh token')
  ]),
};

// ========== USER VALIDATION ==========
const userValidation = {
  updateProfile: validate([
    body('firstName')
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage('First name too long'),
    
    body('lastName')
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage('Last name too long'),
    
    body('bio')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Bio too long'),
    
    body('phone')
      .optional()
      .trim()
      .isMobilePhone()
      .withMessage('Invalid phone number'),
  ]),

  changePassword: validate([
    body('currentPassword')
      .notEmpty()
      .withMessage('Current password is required'),
    
    body('newPassword')
      .notEmpty()
      .withMessage('New password is required')
      .custom(isValidPassword)
      .withMessage('New password must be at least 8 characters with uppercase, lowercase, number, and special character'),
    
    body('confirmNewPassword')
      .notEmpty()
      .withMessage('Confirm new password is required')
      .custom((value, { req }) => value === req.body.newPassword)
      .withMessage('Passwords do not match'),
  ]),
};

// ========== FRIEND VALIDATION ==========
const friendValidation = {
  sendRequest: validate([
    body('receiverId')
      .notEmpty()
      .withMessage('Receiver ID is required')
      .isInt()
      .withMessage('Receiver ID must be an integer'),
  ]),

  respondRequest: validate([
    body('requestId')
      .notEmpty()
      .withMessage('Request ID is required')
      .isInt()
      .withMessage('Request ID must be an integer'),
    
    body('action')
      .notEmpty()
      .withMessage('Action is required')
      .isIn(['accept', 'reject'])
      .withMessage('Action must be either accept or reject'),
  ]),
};

// ========== CHAT VALIDATION ==========
const chatValidation = {
  createChat: validate([
    body('participantIds')
      .isArray({ min: 1 })
      .withMessage('At least one participant is required')
      .custom(ids => ids.every(id => Number.isInteger(id)))
      .withMessage('All participant IDs must be integers'),
    
    body('type')
      .optional()
      .isIn(['direct', 'group'])
      .withMessage('Invalid chat type'),
    
    body('name')
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Chat name too long'),
  ]),
};

// ========== MESSAGE VALIDATION ==========
const messageValidation = {
  sendMessage: validate([
    body('chatId')
      .notEmpty()
      .withMessage('Chat ID is required')
      .isInt()
      .withMessage('Chat ID must be an integer'),
    
    body('content')
      .optional()
      .trim()
      .isLength({ max: 5000 })
      .withMessage('Message too long'),
    
    body('type')
      .notEmpty()
      .withMessage('Message type is required')
      .isIn(['text', 'image', 'video', 'audio', 'file'])
      .withMessage('Invalid message type'),
  ]),
};

// ========== MOOD VALIDATION ==========
const moodValidation = {
  createMood: validate([
    body('mood')
      .notEmpty()
      .withMessage('Mood is required')
      .isIn(['happy', 'sad', 'angry', 'excited', 'calm', 'anxious', 'tired', 'energetic'])
      .withMessage('Invalid mood value'),
    
    body('intensity')
      .optional()
      .isInt({ min: 1, max: 10 })
      .withMessage('Intensity must be between 1 and 10'),
    
    body('note')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Note too long'),
  ]),
};

// ========== PAGINATION VALIDATION ==========
const paginationValidation = validate([
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
]);

module.exports = {
  validate,
  authValidation,
  userValidation,
  friendValidation,
  chatValidation,
  messageValidation,
  moodValidation,
  paginationValidation,
  isValidPassword,
  isValidEmail,
};