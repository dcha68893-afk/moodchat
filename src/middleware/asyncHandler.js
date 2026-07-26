// middleware/asyncHandler.js
//
// FIX: routes/privacy.js and routes/twoStep.js both do
//   const { asyncHandler } = require('../middleware/asyncHandler');
// but this file never existed anywhere in the repo, so both route files threw
// "Cannot find module '../middleware/asyncHandler'" at require time and
// neither /api/privacy nor /api/auth/two-step ever mounted in production.
//
// Wraps an async route handler so rejected promises / thrown errors are
// forwarded to next(err) instead of crashing the process or hanging the
// request.

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
