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

// (The old web-push POST /test was removed: it was registered first, shadowed the FCM test below, and the
//  web-push service has no FCM path - so /api/push/test never reached the phone.)

const nativePush=require('../services/pushService');
router.post('/fcm-token',asyncHandler(async(req,res)=>{const userId=req.user?.id||req.user?.userId||req.user?.sub;const {token,platform,userAgent}=req.body||{};if(!userId||!token)return res.status(400).json({status:'error',message:'token is required'});await nativePush.registerToken(userId,token,{platform,userAgent});res.json({status:'success',message:'FCM device registered'});}));
router.delete('/fcm-token',asyncHandler(async(req,res)=>{const userId=req.user?.id||req.user?.userId||req.user?.sub;if(!userId)return res.status(401).json({status:'error',message:'Authentication required'});await nativePush.unregisterToken(userId,req.body?.token||req.query?.token||null);res.json({status:'success',message:'FCM device removed'});}));
router.get('/status',asyncHandler(async(req,res)=>{const userId=req.user?.id||req.user?.userId||req.user?.sub;res.json({status:'success',data:await nativePush.getStatus(userId)});}));
router.post('/test',asyncHandler(async(req,res)=>{
  const userId=req.user?.id||req.user?.userId||req.user?.sub;
  const status=await nativePush.getStatus(userId);
  if(!status.configured)return res.status(503).json({status:'error',message:'Firebase is not configured on the server',data:status});
  if(!status.deviceCount)return res.status(409).json({status:'error',message:'No device is registered for this account. Open the app once while logged in (and allow notifications).',data:status});
  // type 'message' + no chatId: goes through the same data-only path real chat pushes use.
  const result=await nativePush.sendToUsers([userId],{title:'Necpra',body:'Push notifications are working.'},{type:'message',chatId:'0',messageId:'0',senderId:'0',url:'/chat.html'},{category:'messages'});
  res.json({status:'success',data:{...result,...status}});
}));
module.exports=router;