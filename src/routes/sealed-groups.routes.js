/**
 * sealed-groups.routes.js — Backend routes for sealed group membership
 *
 * Phase 4: Server-side sealed group infrastructure
 *
 * The server stores:
 *   - A SHA-256 hash commitment of sorted member IDs (not the list itself)
 *   - Delivery tokens per (group, member) — opaque routing identifiers
 *   - Encrypted invite blobs (server can't read them without the link fragment key)
 *
 * Routes:
 *   POST /api/groups/:groupId/sealed/commitment      — publish membership commitment hash
 *   GET  /api/groups/:groupId/sealed/commitment      — fetch current commitment
 *   POST /api/groups/:groupId/sealed/rotate-tokens   — rotate delivery tokens
 *   POST /api/groups/:groupId/sealed/invite          — store encrypted invite blob
 *   GET  /api/groups/sealed/invite/:token            — fetch invite blob by token
 *   GET  /api/groups/:groupId/sealed/member-count    — padded member count
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const crypto       = require('crypto');
const asyncHandler = require('express-async-handler');

// ── DB helpers ─────────────────────────────────────────────────────────────────
function getSequelize() {
  return require('../config/database').getSequelize?.() ||
         require('../models/index').sequelize;
}

// ── Auto-create sealed group tables ────────────────────────────────────────────
let _tablesReady = false;

async function _ensureTables(seq) {
  if (_tablesReady) return;
  await seq.query(`
    CREATE TABLE IF NOT EXISTS group_commitments (
      id          SERIAL PRIMARY KEY,
      "groupId"   INTEGER NOT NULL,
      commitment  TEXT NOT NULL,
      "memberCount" INTEGER NOT NULL DEFAULT 0,
      "publishedBy" INTEGER NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, { type: seq.QueryTypes.RAW });

  await seq.query(`
    CREATE INDEX IF NOT EXISTS idx_group_commitments_group ON group_commitments("groupId","createdAt" DESC)
  `, { type: seq.QueryTypes.RAW });

  await seq.query(`
    CREATE TABLE IF NOT EXISTS group_delivery_tokens (
      id          SERIAL PRIMARY KEY,
      "groupId"   INTEGER NOT NULL,
      "userId"    INTEGER NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE("groupId","userId")
    )
  `, { type: seq.QueryTypes.RAW });

  await seq.query(`
    CREATE TABLE IF NOT EXISTS group_sealed_invites (
      id               SERIAL PRIMARY KEY,
      "groupId"        INTEGER NOT NULL,
      token            TEXT NOT NULL UNIQUE,
      "encryptedInvite" TEXT NOT NULL,
      "createdBy"      INTEGER NOT NULL,
      "expiresAt"      TIMESTAMPTZ,
      "useCount"       INTEGER NOT NULL DEFAULT 0,
      "maxUses"        INTEGER NOT NULL DEFAULT 1,
      "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, { type: seq.QueryTypes.RAW });

  _tablesReady = true;
}

// ── Shared membership guard ────────────────────────────────────────────────────
async function assertMember(seq, groupId, userId) {
  const [row] = await seq.query(
    `SELECT 1 FROM "GroupMembers" WHERE "groupId"=:g AND "userId"=:u AND "isActive"=true LIMIT 1`,
    { replacements: { g: groupId, u: userId }, type: seq.QueryTypes.SELECT }
  );
  if (!row) {
    const err = new Error('Not a member of this group');
    err.status = 403;
    throw err;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// POST /api/groups/:groupId/sealed/commitment
// Publish a new membership commitment hash. Must be a group member.
router.post('/:groupId/sealed/commitment', asyncHandler(async (req, res) => {
  const groupId    = parseInt(req.params.groupId, 10);
  const userId     = req.user.id;
  const { commitment, memberCount } = req.body;

  if (!commitment || typeof commitment !== 'string') {
    return res.status(400).json({ success: false, message: 'commitment required' });
  }

  const seq = getSequelize();
  await _ensureTables(seq);
  await assertMember(seq, groupId, userId);

  await seq.query(
    `INSERT INTO group_commitments ("groupId",commitment,"memberCount","publishedBy","createdAt","updatedAt")
     VALUES (:g,:c,:mc,:u,NOW(),NOW())`,
    { replacements: { g: groupId, c: commitment, mc: memberCount || 0, u: userId } }
  );

  res.json({ success: true, message: 'Commitment recorded' });
}));

// GET /api/groups/:groupId/sealed/commitment
// Fetch the most recent commitment for a group.
router.get('/:groupId/sealed/commitment', asyncHandler(async (req, res) => {
  const groupId = parseInt(req.params.groupId, 10);
  const seq     = getSequelize();
  await _ensureTables(seq);
  await assertMember(seq, groupId, req.user.id);

  const [row] = await seq.query(
    `SELECT commitment,"memberCount","createdAt" FROM group_commitments
     WHERE "groupId"=:g ORDER BY "createdAt" DESC LIMIT 1`,
    { replacements: { g: groupId }, type: seq.QueryTypes.SELECT }
  );

  if (!row) {
    return res.json({ success: true, data: null, message: 'No commitment published yet' });
  }

  res.json({ success: true, data: {
    commitment:  row.commitment,
    memberCount: row.memberCount,
    publishedAt: row.createdAt,
  }});
}));

// POST /api/groups/:groupId/sealed/rotate-tokens
// Replace all delivery tokens for this group.
// Body: { tokens: { [userId]: tokenB64 } }
router.post('/:groupId/sealed/rotate-tokens', asyncHandler(async (req, res) => {
  const groupId = parseInt(req.params.groupId, 10);
  const userId  = req.user.id;
  const { tokens } = req.body;

  if (!tokens || typeof tokens !== 'object') {
    return res.status(400).json({ success: false, message: 'tokens object required' });
  }

  const seq = getSequelize();
  await _ensureTables(seq);
  await assertMember(seq, groupId, userId);

  // Verify caller is admin/owner before allowing token rotation for others
  const [role] = await seq.query(
    `SELECT role FROM "GroupMembers" WHERE "groupId"=:g AND "userId"=:u AND "isActive"=true LIMIT 1`,
    { replacements: { g: groupId, u: userId }, type: seq.QueryTypes.SELECT }
  );
  if (!role || !['owner','admin'].includes(role.role)) {
    return res.status(403).json({ success: false, message: 'Only admins can rotate group delivery tokens' });
  }

  // Deactivate old tokens
  await seq.query(
    `UPDATE group_delivery_tokens SET active=false WHERE "groupId"=:g`,
    { replacements: { g: groupId } }
  );

  // Insert new tokens
  for (const [uid, token] of Object.entries(tokens)) {
    await seq.query(
      `INSERT INTO group_delivery_tokens ("groupId","userId",token,active,"createdAt")
       VALUES (:g,:u,:t,true,NOW())
       ON CONFLICT ("groupId","userId") DO UPDATE SET token=EXCLUDED.token, active=true, "createdAt"=NOW()`,
      { replacements: { g: groupId, u: parseInt(uid, 10), t: String(token).slice(0, 64) } }
    );
  }

  res.json({ success: true, message: 'Delivery tokens rotated' });
}));

// GET /api/groups/:groupId/sealed/member-count
// Returns padded member count (next power of 2 ≥ actual count).
router.get('/:groupId/sealed/member-count', asyncHandler(async (req, res) => {
  const groupId = parseInt(req.params.groupId, 10);
  const seq     = getSequelize();
  await assertMember(seq, groupId, req.user.id);

  const [row] = await seq.query(
    `SELECT COUNT(*) AS cnt FROM "GroupMembers" WHERE "groupId"=:g AND "isActive"=true`,
    { replacements: { g: groupId }, type: seq.QueryTypes.SELECT }
  );

  const actual = parseInt(row?.cnt || 0, 10);
  let padded = 1;
  while (padded < actual) padded <<= 1;

  res.json({ success: true, data: { paddedCount: padded } });
}));

// POST /api/groups/:groupId/sealed/invite
// Store an encrypted invite blob; return an opaque token.
// Body: { encryptedInvite: string (base64), maxUses?: number, expiresInHours?: number }
router.post('/:groupId/sealed/invite', asyncHandler(async (req, res) => {
  const groupId = parseInt(req.params.groupId, 10);
  const userId  = req.user.id;
  const { encryptedInvite, maxUses = 1, expiresInHours = 72 } = req.body;

  if (!encryptedInvite) {
    return res.status(400).json({ success: false, message: 'encryptedInvite required' });
  }

  const seq = getSequelize();
  await _ensureTables(seq);
  await assertMember(seq, groupId, userId);

  // Only admins/owners can create invite links
  const [role] = await seq.query(
    `SELECT role FROM "GroupMembers" WHERE "groupId"=:g AND "userId"=:u AND "isActive"=true LIMIT 1`,
    { replacements: { g: groupId, u: userId }, type: seq.QueryTypes.SELECT }
  );
  if (!role || !['owner','admin','moderator'].includes(role.role)) {
    return res.status(403).json({ success: false, message: 'Only admins can create invite links' });
  }

  const token     = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000);

  await seq.query(
    `INSERT INTO group_sealed_invites ("groupId",token,"encryptedInvite","createdBy","expiresAt","maxUses","createdAt")
     VALUES (:g,:t,:inv,:u,:exp,:mu,NOW())`,
    { replacements: { g: groupId, t: token, inv: encryptedInvite, u: userId, exp: expiresAt, mu: maxUses } }
  );

  res.json({ success: true, token, expiresAt });
}));

// GET /api/groups/sealed/invite/:token — fetch encrypted invite by opaque token
// NOTE: must be mounted BEFORE the /:groupId routes to avoid param collision
router.get('/sealed/invite/:token', asyncHandler(async (req, res) => {
  const { token } = req.params;
  const seq = getSequelize();
  await _ensureTables(seq);

  const [row] = await seq.query(
    `SELECT "encryptedInvite","expiresAt","useCount","maxUses"
     FROM group_sealed_invites WHERE token=:t LIMIT 1`,
    { replacements: { t: token }, type: seq.QueryTypes.SELECT }
  );

  if (!row) return res.status(404).json({ success: false, message: 'Invite not found or expired' });
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    return res.status(410).json({ success: false, message: 'Invite link has expired' });
  }
  if (row.useCount >= row.maxUses) {
    return res.status(410).json({ success: false, message: 'Invite link has reached its usage limit' });
  }

  // Increment use count
  await seq.query(
    `UPDATE group_sealed_invites SET "useCount"="useCount"+1 WHERE token=:t`,
    { replacements: { t: token } }
  );

  // Return the encrypted blob — server cannot read the contents
  res.json({ success: true, encryptedInvite: row.encryptedInvite });
}));

module.exports = router;
