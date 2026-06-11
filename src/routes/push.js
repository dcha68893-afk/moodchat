/**
 * push.js — Push notification subscription management routes
 *
 * GET  /api/push/vapid-public-key   — Return VAPID public key for SW registration
 * POST /api/push/subscribe           — Save push subscription
 * DELETE /api/push/unsubscribe       — Remove push subscription
 * POST /api/push/test                — Send test notification to self
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('express-async-handler');
const pushService  = require('../services/pushNotificationService');

function getSequelize() { return require('../models/index').sequelize; }

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  const key = pushService.getPublicKey();
  if (!key) return res.status(503).json({ status: 'error', message: 'Push notifications not configured' });
  res.json({ status: 'success', data: { publicKey: key } });
});

// POST /api/push/subscribe
router.post('/subscribe', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { endpoint, p256dh, auth, userAgent } = req.body;

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ status: 'error', message: 'endpoint, p256dh and auth are required' });
  }

  const sequelize = getSequelize();
  await sequelize.query(
    `INSERT INTO push_subscriptions ("userId", endpoint, p256dh, auth, "userAgent", "createdAt", "lastUsedAt")
     VALUES (:userId, :endpoint, :p256dh, :auth, :userAgent, NOW(), NOW())
     ON CONFLICT (endpoint) DO UPDATE
       SET "userId"=:userId, p256dh=:p256dh, auth=:auth, "lastUsedAt"=NOW()`,
    { replacements: { userId, endpoint, p256dh, auth, userAgent: userAgent || null } }
  );

  res.status(201).json({ status: 'success', message: 'Push subscription saved' });
}));

// DELETE /api/push/unsubscribe
router.delete('/unsubscribe', asyncHandler(async (req, res) => {
  const userId   = req.user.id;
  const { endpoint } = req.body;
  const sequelize = getSequelize();

  if (endpoint) {
    await sequelize.query(
      `DELETE FROM push_subscriptions WHERE "userId"=:userId AND endpoint=:endpoint`,
      { replacements: { userId, endpoint } }
    );
  } else {
    // Remove all subscriptions for user (logout)
    await sequelize.query(
      `DELETE FROM push_subscriptions WHERE "userId"=:userId`,
      { replacements: { userId } }
    );
  }
  res.json({ status: 'success', message: 'Unsubscribed' });
}));

// POST /api/push/test — send test notification to self
router.post('/test', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();

  await pushService.sendToUser(userId, 'message:new', {
    senderName: 'Kynecta',
    content:    'Push notifications are working! 🎉',
    chatId:     0,
    messageId:  0,
  }, sequelize);

  res.json({ status: 'success', message: 'Test notification sent' });
}));

module.exports = router;
