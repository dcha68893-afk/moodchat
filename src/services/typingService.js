// typingService.js
// FIX (Forensic Audit P1): This file was a dead stub (startTyping/stopTyping both empty).
// The real implementation is typingIndicatorService.js — re-export it here so any
// future code that requires 'typingService' gets the real service, not empty functions.
// This prevents the "double-fire typing stop" race condition caused by dual service paths.
module.exports = require('./typingIndicatorService');
