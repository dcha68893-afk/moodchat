const { body, param, query, validationResult } = require('express-validator');
const { isValidEmail, isValidPassword } = require('../utils/validators');

const validate = validations => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    const errorMessages = errors.array().map(err => ({
      field: err.path,
      message: err.msg,
    }));

    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errorMessages,
    });
  };
};

// Common validation rules
const authValidation = {
  register: validate([
    body('username')
      .notEmpty()
      .withMessage('Username is required')
      .isLength({ min: 3, max: 30 })
      .withMessage('Username must be 3-30 characters')
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage('Username can only contain letters, numbers, and underscores'),

    body('email')
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('Invalid email format')
      .custom(isValidEmail)
      .withMessage('Email domain is not allowed'),

    body('password')
      .notEmpty()
      .withMessage('Password is required')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .custom(isValidPassword)
      .withMessage(
        'Password must contain at least one uppercase, one lowercase, one number, and one special character'
      ),

    body('confirmPassword')
      .optional()
      .custom((value, { req }) => value === req.body.password)
      .withMessage('Passwords do not match'),
  ]),

  login: validate([
    body('identifier')
      .notEmpty()
      .withMessage('Email or username is required')
      .custom(value => {
        const isValidEmail = required('validator').isEmail(value);
        const isUsername = /^[a-zA-Z0-9_]+$/.test(value);
        if (!isValidEmail && !isUsername) {
          throw new Error('Identifier must be a valid email or username');
        }
        return true;
      }),
    body('password').notEmpty().withMessage('Password is required'),
  ]),

  refreshToken: validate([
    body('refreshToken').notEmpty().withMessage('Refresh token is required'),
  ]),
};

const userValidation = {
  updateProfile: validate([
    body('firstName').optional().isLength({ max: 50 }).withMessage('First name too long'),
    body('lastName').optional().isLength({ max: 50 }).withMessage('Last name too long'),
    body('bio').optional().isLength({ max: 500 }).withMessage('Bio too long'),
    body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  ]),

  changePassword: validate([
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .notEmpty()
      .withMessage('New password is required')
      .isLength({ min: 8 })
      .withMessage('New password must be at least 8 characters')
      .custom(isValidPassword)
      .withMessage(
        'New password must contain at least one uppercase, one lowercase, one number, and one special character'
      ),
    body('confirmNewPassword')
      .notEmpty()
      .withMessage('Confirm new password is required')
      .custom((value, { req }) => value === req.body.newPassword)
      .withMessage('Passwords do not match'),
  ]),
};

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

const chatValidation = {
  createChat: validate([
    body('participantIds')
      .isArray({ min: 1 })
      .withMessage('At least one participant is required')
      .custom(ids => ids.every(id => Number.isInteger(id)))
      .withMessage('All participant IDs must be integers'),
    body('type').optional().isIn(['direct', 'group']).withMessage('Invalid chat type'),
    body('name').optional().isLength({ max: 100 }).withMessage('Chat name too long'),
  ]),
};

const messageValidation = {
  sendMessage: validate([
    body('chatId')
      .notEmpty()
      .withMessage('Chat ID is required')
      .isInt()
      .withMessage('Chat ID must be an integer'),
    body('content').optional().isLength({ max: 5000 }).withMessage('Message too long'),
    body('type')
      .notEmpty()
      .withMessage('Message type is required')
      .isIn(['text', 'image', 'video', 'audio', 'file'])
      .withMessage('Invalid message type'),
  ]),
};

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
    body('note').optional().isLength({ max: 500 }).withMessage('Note too long'),
  ]),
};

const paginationValidation = validate([
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
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
};