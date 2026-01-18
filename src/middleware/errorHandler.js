const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  // Ensure we have a valid error object
  if (!err) {
    err = new Error('Unknown error occurred');
  }

  // Log the error
  logger.error('Error:', {
    message: err.message || 'Unknown error',
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    user: req.user ? req.user.id : 'anonymous',
  });

  // Default error response
  const response = {
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message || 'Unknown error',
    timestamp: new Date().toISOString(),
  };

  // Add stack trace in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  // Handle specific error types safely
  if (err.name === 'ValidationError') {
    response.message = 'Validation failed';
    response.errors = err.errors || err.details || [];
    return res.status(400).json(response);
  }

  if (err.name === 'SequelizeValidationError') {
    response.message = 'Database validation failed';
    response.errors = (err.errors || []).map(e => ({
      field: e.path || 'unknown',
      message: e.message || 'Validation error',
    }));
    return res.status(400).json(response);
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    response.message = 'Duplicate entry';
    response.errors = (err.errors || []).map(e => ({
      field: e.path || 'unknown',
      message: `${e.path || 'Field'} already exists`,
    }));
    return res.status(409).json(response);
  }

  if (err.name === 'JsonWebTokenError') {
    response.message = 'Invalid token';
    return res.status(401).json(response);
  }

  if (err.name === 'TokenExpiredError') {
    response.message = 'Token expired';
    return res.status(401).json(response);
  }

  if (err.name === 'UnauthorizedError' || err.message?.includes('Unauthorized')) {
    response.message = 'Unauthorized';
    return res.status(401).json(response);
  }

  if (err.name === 'ForbiddenError' || err.message?.includes('Forbidden')) {
    response.message = 'Forbidden';
    return res.status(403).json(response);
  }

  if (err.name === 'NotFoundError' || err.message?.includes('Not found')) {
    response.message = 'Resource not found';
    return res.status(404).json(response);
  }

  // Handle rate limit errors
  if (err.status === 429) {
    response.message = 'Too many requests';
    return res.status(429).json(response);
  }

  // Handle Sequelize database errors
  if (err.name?.startsWith('Sequelize')) {
    response.message = 'Database error occurred';
    return res.status(500).json(response);
  }

  // Handle bcrypt errors
  if (err.message?.includes('bcrypt') || err.message?.includes('password')) {
    response.message = 'Password processing error';
    return res.status(500).json(response);
  }

  // Handle CORS errors
  if (err.message?.includes('CORS')) {
    response.message = 'CORS error: ' + err.message;
    response.allowedOrigins = process.env.NODE_ENV === 'development' ? 'ALL (*)' : 'restricted';
    return res.status(403).json(response);
  }

  // Default to 500 internal server error
  res.status(err.status || 500).json(response);
};

// Custom error classes
class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    Error.captureStackTrace(this, this.constructor);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Authorization failed') {
    super(message, 403);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', errors = []) {
    super(message, 400);
    this.errors = errors;
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409);
  }
}

module.exports = {
  errorHandler,
  AppError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};