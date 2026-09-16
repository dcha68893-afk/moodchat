'use strict';
// Canonical marketplace catalog alias. The dynamic route loader mounts this
// file at /api/marketplace, while marketplace-catalog.js remains available
// for backwards-compatible direct access.
module.exports = require('./marketplace-catalog');
