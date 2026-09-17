const express = require('express');
const { Op } = require('sequelize');
const db = require('../models');

const router = express.Router();
const Friend = db.models.Friend;
const Users = db.models.Users;

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

async function getPair(userId, otherId, transaction) {
  return Friend.findOne({
    where: {
      [Op.or]: [
        { requesterId: userId, addresseeId: otherId },
        { requesterId: otherId, addresseeId: userId }
      ]
    },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined
  });
}

function relationship(row, userId) {
  if (!row) return { status: 'none', requestId: null, direction: null };
  if (row.status === 'accepted') return { status: 'accepted', requestId: row.id, direction: null };
  if (row.requesterId === userId) return { status: row.status === 'rejected' ? 'rejected' : 'pending', requestId: row.id, direction: 'outgoing' };
  return { status: row.status === 'rejected' ? 'rejected' : 'pending', requestId: row.id, direction: 'incoming' };
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

router.get('/', async (req, res) => {
  try {
    const userId = idOf(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid authenticated user ID' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows, count } = await Friend.findAndCountAll({
      where: { status: 'accepted', [Op.or]: [{ requesterId: userId }, { addresseeId: userId }] },
      order: [['updatedAt', 'DESC']], limit, offset
    });
    const ids = rows.map(row => Number(row.requesterId) === userId ? row.addresseeId : row.requesterId);
    const byId = await usersByIds(ids);
    const friends = rows.map(row => publicUser(byId.get(Number(row.requesterId) === userId ? Number(row.addresseeId) : Number(row.requesterId)))).filter(Boolean);
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
    const rows = await Friend.findAll({ where: { addresseeId: userId, status: 'pending' }, order: [['createdAt', 'DESC']], limit: 100 });
    const byId = await usersByIds(rows.map(r => r.requesterId));
    return res.json({ success: true, requests: rows.map(r => ({ id: r.id, createdAt: r.createdAt, user: publicUser(byId.get(Number(r.requesterId))) })).filter(r => r.user) });
  } catch (error) {
    console.error('[Friends] incoming failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load incoming requests' });
  }
});

router.get('/requests/outgoing', async (req, res) => {
  try {
    const userId = idOf(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Invalid authenticated user ID' });
    const rows = await Friend.findAll({ where: { requesterId: userId, status: 'pending' }, order: [['createdAt', 'DESC']], limit: 100 });
    const byId = await usersByIds(rows.map(r => r.addresseeId));
    return res.json({ success: true, requests: rows.map(r => ({ id: r.id, createdAt: r.createdAt, user: publicUser(byId.get(Number(r.addresseeId))) })).filter(r => r.user) });
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
  const transaction = await db.sequelize.transaction();
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
    const target = await Users.findOne({ where: { id: targetId, isActive: true }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    if (!target) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'User not found' }); }
    let row = await getPair(userId, targetId, transaction);
    if (row?.status === 'accepted') { await transaction.rollback(); return res.status(409).json({ success: false, message: 'You are already friends' }); }
    if (row?.status === 'pending') {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: row.requesterId === userId ? 'Friend request already sent' : 'This user has already sent you a request', requestId: row.id });
    }
    if (row) {
      row.requesterId = userId; row.addresseeId = targetId; row.status = 'pending';
      await row.save({ transaction });
    } else {
      row = await Friend.create({ requesterId: userId, addresseeId: targetId, status: 'pending' }, { transaction });
    }
    await transaction.commit();
    return res.status(201).json({ success: true, request: { id: row.id, status: row.status, requesterId: row.requesterId, addresseeId: row.addresseeId } });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    if (error.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ success: false, message: 'A friendship request already exists' });
    console.error('[Friends] create request failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to send friend request' });
  }
});

async function changeRequest(req, res, action) {
  const transaction = await db.sequelize.transaction();
  try {
    const userId = idOf(req);
    const requestId = Number(req.params.requestId);
    if (!userId || !Number.isInteger(requestId) || requestId <= 0) { await transaction.rollback(); return res.status(400).json({ success: false, message: 'Invalid request ID' }); }
    const row = await Friend.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Friend request not found' }); }
    if (action === 'accept' || action === 'reject') {
      if (row.addresseeId !== userId || row.status !== 'pending') { await transaction.rollback(); return res.status(403).json({ success: false, message: 'Only the recipient can act on a pending request' }); }
      row.status = action === 'accept' ? 'accepted' : 'rejected';
    } else if (action === 'cancel') {
      if (row.requesterId !== userId || row.status !== 'pending') { await transaction.rollback(); return res.status(403).json({ success: false, message: 'Only the sender can cancel a pending request' }); }
      await row.destroy({ transaction });
      await transaction.commit();
      return res.json({ success: true, message: 'Friend request canceled' });
    }
    await row.save({ transaction });
    await transaction.commit();
    return res.json({ success: true, request: { id: row.id, status: row.status } });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    console.error(`[Friends] ${action} failed:`, error.message);
    return res.status(500).json({ success: false, message: `Unable to ${action} friend request` });
  }
}

router.post('/requests/:requestId/accept', (req, res) => changeRequest(req, res, 'accept'));
router.post('/requests/:requestId/reject', (req, res) => changeRequest(req, res, 'reject'));
router.delete('/requests/:requestId', (req, res) => changeRequest(req, res, 'cancel'));

router.delete('/:userId', async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const userId = idOf(req); const otherId = Number(req.params.userId);
    if (!userId || !Number.isInteger(otherId) || otherId <= 0 || userId === otherId) { await transaction.rollback(); return res.status(400).json({ success: false, message: 'Invalid friend ID' }); }
    const row = await getPair(userId, otherId, transaction);
    if (!row || row.status !== 'accepted') { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Friendship not found' }); }
    await row.destroy({ transaction }); await transaction.commit();
    return res.json({ success: true, message: 'Friend removed' });
  } catch (error) {
    await transaction.rollback().catch(() => {});
    console.error('[Friends] remove failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to remove friend' });
  }
});

module.exports = router;
