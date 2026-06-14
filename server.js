/**
 * server.js — Root-level entry point shim
 *
 * The actual server implementation lives in src/server.js with correct
 * relative paths (src/services/*, src/middleware/*, src/models/*, etc.).
 *
 * This file was previously a copy of src/server.js with broken relative
 * paths (e.g. require('./services/authService') resolved to /services/
 * which doesn't exist at root). Now it simply delegates.
 *
 * package.json start script: "node src/server.js"
 * This file is only executed if someone runs `node server.js` from root.
 */
require('./src/server');
