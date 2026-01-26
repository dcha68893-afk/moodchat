// src/routes/health.js
const router = require('express').Router();
const asyncHandler = require('express-async-handler');

console.log('✅ Health routes initialized');

/**
 * Health check endpoint
 * GET /health
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

// Optional: Add a simple ping endpoint for quick health checks
router.get(
  '/ping',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, route: "health", timestamp: new Date().toISOString() });
  })
);

module.exports = router;