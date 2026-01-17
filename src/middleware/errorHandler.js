const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  // Log the error
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    user: req.user ? req.user.id : 'anonymous',
  });

  // Default error response
  const response = {
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    timestamp: new Date().toISOString(),
  };

  // Add stack trace in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  // Handle specific error types
  if (err.name === 'ValidationError') {
    response.message = 'Validation failed';
    response.errors = err.errors || err.details;
    return res.status(400).json(response);
  }

  if (err.name === 'SequelizeValidationError') {
    response.message = 'Database validation failed';
    response.errors = err.errors.map(e => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json(response);
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    response.message = 'Duplicate entry';
    response.errors = err.errors.map(e => ({
      field: e.path,
      message: `${e.path} already exists`,
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

  if (err.name === 'UnauthorizedError') {
    response.message = 'Unauthorized';
    return res.status(401).json(response);
  }

  if (err.name === 'ForbiddenError') {
    response.message = 'Forbidden';
    return res.status(403).json(response);
  }

  if (err.name === 'NotFoundError') {
    response.message = 'Resource not found';
    return res.status(404).json(response);
  }

  // Handle rate limit errors
  if (err.status === 429) {
    response.message = 'Too many requests';
    return res.status(429).json(response);
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
  AuthenticationError,  // Added for calls.js
  AuthorizationError,   // Added for calls.js
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};