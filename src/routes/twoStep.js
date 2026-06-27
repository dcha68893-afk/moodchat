// src/routes/twoStep.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX-8 Backend: Two-step verification (registration-lock PIN)
//
// Mount in src/server.js:
//   app.use('/api/auth/two-step', require('./routes/twoStep'));
//
// Requires a `twoStepPin` and `twoStepHint` column on the Users model:
//   await queryInterface.addColumn('Users', 'twoStepPin',  { type: DataTypes.STRING, allowNull: true });
//   await queryInterface.addColumn('Users', 'twoStepHint', { type: DataTypes.STRING, allowNull: true });
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');

const { authenticate }   = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { asyncHandler }   = require('../middleware/asyncHandler');

// GET /api/auth/two-step/status
router.get('/status', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const User = require('../models/User');
  const user = await User.findByPk(req.user.id, { attributes: ['id', 'twoStepPin', 'twoStepHint'] });
  if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
  res.json({
    status: 'success',
    data: {
      enabled: !!user.twoStepPin,
      hasHint:  !!(user.twoStepPin && user.twoStepHint),
    },
  });
}));

// POST /api/auth/two-step/enable
router.post('/enable', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const { pin, hint } = req.body;
  if (!pin || !/^\d{6}$/.test(pin)) {
    return res.status(400).json({ status: 'error', message: 'PIN must be exactly 6 digits' });
  }
  const User = require('../models/User');
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });

  const hashed = await bcrypt.hash(pin, 12);
  try {
    await user.update({ twoStepPin: hashed, twoStepHint: hint ? hint.slice(0, 60) : null });
  } catch (_colErr) {
    // Column doesn't exist yet — remind to run migration
    return res.status(500).json({ status: 'error', message: 'Run migration: add twoStepPin and twoStepHint to Users table.' });
  }
  res.json({ status: 'success', message: 'Two-step verification enabled' });
}));

// POST /api/auth/two-step/disable
router.post('/disable', authenticate, apiRateLimiter, asyncHandler(async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ status: 'error', message: 'PIN required' });
  const User = require('../models/User');
  const user = await User.findByPk(req.user.id, { attributes: ['id', 'twoStepPin'] });
  if (!user || !user.twoStepPin) {
    return res.status(400).json({ status: 'error', message: 'Two-step verification is not enabled' });
  }
  const match = await bcrypt.compare(pin, user.twoStepPin);
  if (!match) return res.status(401).json({ status: 'error', message: 'Incorrect PIN' });
  await user.update({ twoStepPin: null, twoStepHint: null });
  res.json({ status: 'success', message: 'Two-step verification disabled' });
}));

// POST /api/auth/two-step/verify — used during login to check PIN
router.post('/verify', asyncHandler(async (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ status: 'error', message: 'userId and pin required' });
  const User = require('../models/User');
  const user = await User.findByPk(userId, { attributes: ['id', 'twoStepPin', 'twoStepHint'] });
  if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
  if (!user.twoStepPin) return res.json({ status: 'success', required: false });
  const match = await bcrypt.compare(String(pin), user.twoStepPin);
  if (!match) {
    return res.status(401).json({ status: 'error', required: true, message: 'Incorrect PIN', hint: user.twoStepHint || null });
  }
  res.json({ status: 'success', required: true, verified: true });
}));

// GET /api/auth/two-step/hint/:userId — hint visible before PIN entry (no auth)
router.get('/hint/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
  const User = require('../models/User');
  const user = await User.findByPk(req.params.userId, { attributes: ['twoStepPin', 'twoStepHint'] });
  if (!user || !user.twoStepPin) return res.json({ status: 'success', data: { enabled: false } });
  res.json({ status: 'success', data: { enabled: true, hint: user.twoStepHint || null } });
}));

module.exports = router;
