'use strict';

const express = require('express');
const { Op } = require('sequelize');
const db = require('../models');

const router = express.Router();
const Users = db.models.Users;
const sequelize = db.sequelize;

// Friends is deliberately read/written with explicit SQL against the
// canonical production columns. This prevents Sequelize from ever emitting
// legacy receiverId/requesterId column names for this module.
const FRIEND_COLUMNS = '"id", "requester_id", "receiver_id", "status", "createdAt", "updatedAt", "accepted_at", "blocked_at"';

const idOf = (req) => {
  const raw = req.user?.userId ?? req.user?.id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const publicUser = (user) => {
  if (!user) return null;
  const first = user.firstName || '';
  const last = user.lastName || '';
  return {
    id: user.id,
    username: user.username,
    displayName: `${first} ${last}`.trim() || user.username,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    avatar: user.avatar || null,
    bio: user.bio || null,
    isVerified: Boolean(user.isVerified),
    status: user.status || 'offline',
    lastSeen: user.lastSeen || null
  };
};

function mapFriend(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    requesterId: Number(row.requester_id),
    addresseeId: Number(row.receiver_id),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acceptedAt: row.accepted_at || null,
    blockedAt: row.blocked_at || null
  };
}

async function getPair(userId, otherId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT ${FRIEND_COLUMNS}
       FROM "friends"
      WHERE ("requester_id" = :userId AND "receiver_id" = :otherId)
         OR ("requester_id" = :otherId AND "receiver_id" = :userId)
      ORDER BY "updatedAt" DESC, "id" DESC
      LIMIT 1${transaction ? ' FOR UPDATE' : ''}`,
    { replacements: { userId, otherId }, transaction }
  );
  return mapFriend(rows[0]);
}

async function usersByIds(ids) {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return new Map();
  const users = await Users.findAll({
    where: { id: unique },
    attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio', 'isVerified', 'status', 'lastSeen']
  });
  return new Map(users.map(user => [Number(user.id), user]));
}

function relationship(row, userId) {
  if (!row) return { status: 'none', requestId: null, direction: null };
  if (row.status === 'accepted') return { status: 'accepted', requestId: row.id, direction: null };
  return {
    status: row.status === 'rejected' ? 'rejected' : row.status,
    requestId: row.id,
    direction: Number(row.requesterId) === Number(userId) ? 'outgoing' : 'incoming'
  };
}

router.get('/', async (req, res) => {
  try {
    const userId = idOf(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid authenticated user ID' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows] = await sequelize.query(
      `SELECT ${FRIEND_COLUMNS}
         FROM "friends"
        WHERE "status" = 'accepted'
          AND ("requester_id" = :userId OR "receiver_id" = :userId)
        ORDER BY "updatedAt" DESC, "id" DESC
        LIMIT :limit OFFSET :offset`,
      { replacements: { userId, limit, offset } }
    );
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*)::integer AS count
         FROM "friends"
        WHERE "status" = 'accepted'
          AND ("requester_id" = :userId OR "receiver_id" = :userId)`,
      { replacements: { userId } }
    );
    const count = Number(countRows[0]?.count || 0);
    const mapped = rows.map(mapFriend);
    const ids = mapped.map(row => row.requesterId === userId ? row.addresseeId : row.requesterId);
    const byId = await usersByIds(ids);
    const friends = mapped.map(row => publicUser(byId.get(row.requesterId === userId ? row.addresseeId : row.requesterId))).filter(Boolean);
    return res.json({ success: true, friends, pagination: { total: count, limit, offset, hasMore: offset + rows.length < count } });
  } catch (error) {
    console.error('[Friends] list failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load friends' });
  }
});

router.get('/requests/incoming', async (req, res) => {
  try {
    const userId = idOf(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid authenticated user ID' });
    const [rows] = await sequelize.query(
      `SELECT ${FRIEND_COLUMNS}
         FROM "friends"
        WHERE "receiver_id" = :userId AND "status" = 'pending'
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 100`,
      { replacements: { userId } }
    );
    const mapped = rows.map(mapFriend);
    const byId = await usersByIds(mapped.map(row => row.requesterId));
    return res.json({ success: true, requests: mapped.map(row => ({ id: row.id, createdAt: row.createdAt, user: publicUser(byId.get(row.requesterId)) })).filter(item => item.user) });
  } catch (error) {
    console.error('[Friends] incoming failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load incoming requests' });
  }
});

router.get('/requests/outgoing', async (req, res) => {
  try {
    const userId = idOf(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid authenticated user ID' });
    const [rows] = await sequelize.query(
      `SELECT ${FRIEND_COLUMNS}
         FROM "friends"
        WHERE "requester_id" = :userId AND "status" = 'pending'
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 100`,
      { replacements: { userId } }
    );
    const mapped = rows.map(mapFriend);
    const byId = await usersByIds(mapped.map(row => row.addresseeId));
    return res.json({ success: true, requests: mapped.map(row => ({ id: row.id, createdAt: row.createdAt, user: publicUser(byId.get(row.addresseeId)) })).filter(item => item.user) });
  } catch (error) {
    console.error('[Friends] outgoing failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load outgoing requests' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const userId = idOf(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid authenticated user ID' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, users: [] });
    const safe = q.replace(/[%_]/g, '\\$&');
    const users = await Users.findAll({
      where: { id: { [Op.ne]: userId }, isActive: true, [Op.or]: [
        { username: { [Op.iLike]: `%${safe}%` } },
        { firstName: { [Op.iLike]: `%${safe}%` } },
        { lastName: { [Op.iLike]: `%${safe}%` } }
      ] },
      attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio', 'isVerified', 'status', 'lastSeen'],
      order: [['username', 'ASC']], limit: 20
    });
    const results = [];
    for (const user of users) {
      const row = await getPair(userId, user.id);
      results.push({ ...publicUser(user), relationship: relationship(row, userId) });
    }
    return res.json({ success: true, users: results });
  } catch (error) {
    console.error('[Friends] search failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to search users' });
  }
});

router.get('/status/:userId', async (req, res) => {
  try {
    const userId = idOf(req);
    const otherId = Number(req.params.userId);
    if (!userId || !Number.isInteger(otherId) || otherId <= 0) return res.status(400).json({ success: false, message: 'Invalid user ID' });
    if (userId === otherId) return res.json({ success: true, relationship: { status: 'self', requestId: null, direction: null } });
    const row = await getPair(userId, otherId);
    return res.json({ success: true, relationship: relationship(row, userId) });
  } catch (error) {
    console.error('[Friends] status failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to check friendship status' });
  }
});

router.post('/requests', async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const userId = idOf(req);
    const targetId = Number(req.body?.userId);
    if (!userId || !Number.isInteger(targetId) || targetId <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'A valid target user ID is required' });
    }
    if (userId === targetId) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'You cannot send a friend request to yourself' });
    }

    const [targetRows] = await sequelize.query(
      'SELECT "id" FROM "Users" WHERE "id" = :targetId AND "isActive" = true LIMIT 1 FOR UPDATE',
      { replacements: { targetId }, transaction }
    );
    if (!targetRows[0]) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const row = await getPair(userId, targetId, transaction);
    if (row?.status === 'accepted') {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: 'You are already friends' });
    }
    if (row?.status === 'pending') {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: row.requesterId === userId ? 'Friend request already sent' : 'This user has already sent you a request', requestId: row.id });
    }

    let saved;
    if (row) {
      const [updated] = await sequelize.query(
        `UPDATE "friends"
            SET "requester_id" = :userId,
                "receiver_id" = :targetId,
                "status" = 'pending',
                "updatedAt" = NOW()
          WHERE "id" = :id
          RETURNING ${FRIEND_COLUMNS}`,
        { replacements: { userId, targetId, id: row.id }, transaction }
      );
      saved = mapFriend(updated[0]);
    } else {
      const [created] = await sequelize.query(
        `INSERT INTO "friends" ("requester_id", "receiver_id", "status", "createdAt", "updatedAt")
         VALUES (:userId, :targetId, 'pending', NOW(), NOW())
         RETURNING ${FRIEND_COLUMNS}`,
        { replacements: { userId, targetId }, transaction }
      );
      saved = mapFriend(created[0]);
    }

    await transaction.commit();
    return res.status(201).json({ success: true, request: { id: saved.id, status: saved.status, requesterId: saved.requesterId, addresseeId: saved.addresseeId } });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    if (error.name === 'SequelizeUniqueConstraintError' || error.parent?.code === '23505') return res.status(409).json({ success: false, message: 'A friendship request already exists' });
    console.error('[Friends] create request failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to send friend request' });
  }
});

async function changeRequest(req, res, action) {
  const transaction = await sequelize.transaction();
  try {
    const userId = idOf(req);
    const requestId = Number(req.params.requestId);
    if (!userId || !Number.isInteger(requestId) || requestId <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Invalid request ID' });
    }
    const row = await getPairById(requestId, transaction);
    if (!row) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Friend request not found' });
    }
    if (action === 'accept' || action === 'reject') {
      if (row.addresseeId !== userId || row.status !== 'pending') {
        await transaction.rollback();
        return res.status(403).json({ success: false, message: 'Only the recipient can act on a pending request' });
      }
      const next = action === 'accept' ? 'accepted' : 'rejected';
      const [updated] = await sequelize.query(
        `UPDATE "friends"
            SET "status" = :status,
                "accepted_at" = CASE WHEN :status = 'accepted' THEN NOW() ELSE "accepted_at" END,
                "updatedAt" = NOW()
          WHERE "id" = :id
          RETURNING ${FRIEND_COLUMNS}`,
        { replacements: { status: next, id: requestId }, transaction }
      );
      await transaction.commit();
      const saved = mapFriend(updated[0]);
      return res.json({ success: true, request: { id: saved.id, status: saved.status } });
    }
    if (action === 'cancel') {
      if (row.requesterId !== userId || row.status !== 'pending') {
        await transaction.rollback();
        return res.status(403).json({ success: false, message: 'Only the sender can cancel a pending request' });
      }
      await sequelize.query('DELETE FROM "friends" WHERE "id" = :id', { replacements: { id: requestId }, transaction });
      await transaction.commit();
      return res.json({ success: true, message: 'Friend request canceled' });
    }
    await transaction.rollback();
    return res.status(400).json({ success: false, message: 'Unsupported friend request action' });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    console.error(`[Friends] ${action} failed:`, error.message);
    return res.status(500).json({ success: false, message: `Unable to ${action} friend request` });
  }
}

async function getPairById(id, transaction) {
  const [rows] = await sequelize.query(
    `SELECT ${FRIEND_COLUMNS} FROM "friends" WHERE "id" = :id LIMIT 1${transaction ? ' FOR UPDATE' : ''}`,
    { replacements: { id }, transaction }
  );
  return mapFriend(rows[0]);
}

router.post('/requests/:requestId/accept', (req, res) => changeRequest(req, res, 'accept'));
router.post('/requests/:requestId/reject', (req, res) => changeRequest(req, res, 'reject'));
router.delete('/requests/:requestId', (req, res) => changeRequest(req, res, 'cancel'));

router.delete('/:userId', async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const userId = idOf(req);
    const otherId = Number(req.params.userId);
    if (!userId || !Number.isInteger(otherId) || otherId <= 0 || userId === otherId) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Invalid friend ID' });
    }
    const row = await getPair(userId, otherId, transaction);
    if (!row || row.status !== 'accepted') {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Friendship not found' });
    }
    await sequelize.query('DELETE FROM "friends" WHERE "id" = :id', { replacements: { id: row.id }, transaction });
    await transaction.commit();
    return res.json({ success: true, message: 'Friend removed' });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    console.error('[Friends] remove failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to remove friend' });
  }
});

module.exports = router;
