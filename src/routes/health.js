// src/routes/health.js
const path = require('path');
const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');

console.log('✅ Health routes initialized');

// FIX: Add CORS headers to health endpoint so browser probes from any origin succeed
// NetworkIntelligenceManager uses no-cors mode now, but this keeps things robust.
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

/**
 * Health check endpoint
 * GET /health
 * HEAD /health  — FIX: Added HEAD support for NetworkIntelligenceManager probe
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const healthStatus = {
        ok: true,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        message: 'Backend is healthy'
      };

      res.status(200).json(healthStatus);
    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({
        ok: false,
        error: 'Internal Server Error'
      });
    }
  })
);

// FIX: HEAD /health — NetworkIntelligenceManager previously used HEAD but only GET existed,
// causing 404/405 responses that triggered false OFFLINE state on WiFi connections.
router.head('/', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).end();
});

// Optional: Add a simple ping endpoint for quick health checks
router.get(
  '/ping',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, route: "health", timestamp: new Date().toISOString() });
  })
);

router.head('/ping', (req, res) => res.status(200).end());

module.exports = router;