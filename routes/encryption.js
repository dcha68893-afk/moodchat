/**
 * encryption.js — Encryption key management routes
 *
 * POST /api/encryption/keys          — Register/update user's public key
 * GET  /api/encryption/keys/:userId  — Fetch a user's public key
 * GET  /api/encryption/keys          — Get own key info
 * DELETE /api/encryption/keys        — Revoke own key (logout/key rotation)
 * GET  /api/encryption/safety/:userId — Get safety numbers with another user
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('express-async-handler');

function getSequelize() { return require('../models/index').sequelize; }

// POST /api/encryption/keys — register or update public key
router.post('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const { publicKey, keyId } = req.body;

  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ status: 'error', message: 'publicKey required' });
  }
  if (!keyId || typeof keyId !== 'string') {
    return res.status(400).json({ status: 'error', message: 'keyId required' });
  }

  const sequelize = getSequelize();

  // Deactivate old keys
  await sequelize.query(
    `UPDATE user_encryption_keys SET "isActive"=false, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );

  // Insert new key
  await sequelize.query(
    `INSERT INTO user_encryption_keys ("userId","publicKey","keyId","algorithm","isActive","createdAt","updatedAt")
     VALUES (:userId,:publicKey,:keyId,'ECDH-P256-AES256GCM',true,NOW(),NOW())
     ON CONFLICT ("userId","keyId") DO UPDATE
       SET "publicKey"=:publicKey, "isActive"=true, "updatedAt"=NOW()`,
    { replacements: { userId, publicKey, keyId } }
  );

  res.status(201).json({ status: 'success', data: { keyId }, message: 'Public key registered' });
}));

// GET /api/encryption/keys — own key info
router.get('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  const rows      = await sequelize.query(
    `SELECT "keyId","publicKey","createdAt" FROM user_encryption_keys
     WHERE "userId"=:userId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.json({ status: 'success', data: null });
  }
  res.json({ status: 'success', data: rows[0] });
}));

// GET /api/encryption/keys/:userId — fetch another user's public key
router.get('/keys/:userId', asyncHandler(async (req, res) => {
  const targetId  = parseInt(req.params.userId, 10);
  if (!targetId)  return res.status(400).json({ status: 'error', message: 'Invalid userId' });

  const sequelize = getSequelize();

  // Verify friendship/chat relationship before exposing key
  const [rel] = await sequelize.query(
    `SELECT 1 FROM chat_participants cp1
     JOIN chat_participants cp2 ON cp2."chatId"=cp1."chatId" AND cp2."userId"=:targetId
     WHERE cp1."userId"=:requesterId LIMIT 1`,
    { replacements: { requesterId: req.user.id, targetId } }
  );
  if (!rel || rel.length === 0) {
    return res.status(403).json({ status: 'error', message: 'No shared conversation' });
  }

  const rows = await sequelize.query(
    `SELECT "keyId","publicKey","createdAt" FROM user_encryption_keys
     WHERE "userId"=:targetId AND "isActive"=true ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { targetId }, type: sequelize.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.json({ status: 'success', data: null, message: 'User has not enabled encryption' });
  }
  res.json({ status: 'success', data: rows[0] });
}));

// DELETE /api/encryption/keys — revoke own key
router.delete('/keys', asyncHandler(async (req, res) => {
  const userId    = req.user.id;
  const sequelize = getSequelize();
  await sequelize.query(
    `UPDATE user_encryption_keys SET "isActive"=false, "updatedAt"=NOW() WHERE "userId"=:userId`,
    { replacements: { userId } }
  );
  res.json({ status: 'success', message: 'Encryption keys revoked' });
}));

// GET /api/encryption/safety/:userId — safety number fingerprint
router.get('/safety/:userId', asyncHandler(async (req, res) => {
  const myId      = req.user.id;
  const theirId   = parseInt(req.params.userId, 10);
  const sequelize = getSequelize();

  const [myKey, theirKey] = await Promise.all([
    sequelize.query(
      `SELECT "publicKey","keyId" FROM user_encryption_keys WHERE "userId"=:uid AND "isActive"=true LIMIT 1`,
      { replacements: { uid: myId }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT "publicKey","keyId" FROM user_encryption_keys WHERE "userId"=:uid AND "isActive"=true LIMIT 1`,
      { replacements: { uid: theirId }, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  if (!myKey?.length || !theirKey?.length) {
    return res.json({ status: 'success', data: null, message: 'One or both users have not enabled encryption' });
  }

  // Deterministic ordering for consistent safety numbers
  const a = myKey[0].publicKey;
  const b = theirKey[0].publicKey;
  const combined = a < b ? a + b : b + a;
  const hash = require('crypto').createHash('sha256').update(combined).digest('hex');
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(hash.slice(i * 4, i * 4 + 4).toUpperCase());

  res.json({ status: 'success', data: { fingerprint: groups.join(' '), hex: hash.toUpperCase() } });
}));

module.exports = router;
