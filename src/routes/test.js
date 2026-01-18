const express = require('express');
const router = express.Router();

// Simple test DB endpoint
router.get('/db', async (req, res) => {
  try {
    // Use your sequelize connection
    const { sequelize } = require('../server'); // Ensure sequelize is exported from server.js
    const [result] = await sequelize.query('SELECT NOW()');
    res.json({ success: true, result: result[0] });
  } catch (err) {
    console.error('Test DB error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simple test endpoint
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Test route working',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;