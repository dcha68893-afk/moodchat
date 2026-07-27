class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    // FIX (MISSING-ERROR-CLASSES): this.name previously stayed 'Error' for every
    // subclass, so middleware/errorHandler.js's `err.name === 'ValidationError'`
    // style checks never matched. Set it from the concrete subclass so both
    // name-based and instanceof-based checks work.
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Not authorized') {
    super(message, 403);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409);
  }
}

// FIX (MISSING-ERROR-CLASSES): ValidationError, NotFoundError, ServerError, and
// ForbiddenError were destructured from this module by ~15 service files
// (profileService.js, chatService.js, messageService.js, settingsService.js,
// userStatusService.js, chatParticipantService.js, sharedMoodService.js,
// notesService.js, featuresService.js, messageDeliveryService.js,
// searchService.js, readReceiptService.js, toolsService.js, validators.js) but
// were never defined/exported here. Every destructured binding was `undefined`,
// so `throw new ValidationError(...)` crashed with "not a constructor", and
// `error instanceof ValidationError` in catch blocks crashed with "Right-hand
// side of 'instanceof' is not an object" -- exactly the error masking the real
// failure in profileService.updateProfile and every other caller.
class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

class ServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500);
  }
}

module.exports = {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ServerError,
};
