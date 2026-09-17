const express = require('express');
const { Op } = require('sequelize');
const db = require('../models');

const router = express.Router();
const Users = db.models.Users;
const Friend = db.models.Friend;
const sequelize = db.sequelize || db;

const me = (req) => {
  const id = Number(req.user?.userId ?? req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const publicUser = (u, extra = {}) => ({
  id: u.id,
  username: u.username,
  displayName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username,
  firstName: u.firstName || null,
  lastName: u.lastName || null,
  avatar: u.avatar || null,
  bio: u.bio || null,
  isVerified: Boolean(u.isVerified),
  status: u.status || 'offline',
  lastSeen: u.lastSeen || null,
  ...extra
});

const attrs = ['id','username','firstName','lastName','avatar','bio','isVerified','status','lastSeen'];

async function relationships(userId, users) {
  const ids = users.map(u => Number(u.id)).filter(Number.isInteger);
  if (!ids.length) return new Map();
  const rows = await Friend.findAll({
    where: {
      [Op.and]: [
        { status: { [Op.in]: ['pending', 'accepted'] } },
        { [Op.or]: [
          { requesterId: userId, addresseeId: { [Op.in]: ids } },
          { addresseeId: userId, requesterId: { [Op.in]: ids } }
        ] }
      ]
    },
    attributes: ['id','requesterId','addresseeId','status']
  });
  const map = new Map();
  for (const r of rows) {
    const other = Number(r.requesterId) === userId ? Number(r.addresseeId) : Number(r.requesterId);
    map.set(other, r.status === 'accepted' ? { status: 'accepted', direction: null, requestId: r.id } : {
      status: 'pending', direction: Number(r.requesterId) === userId ? 'outgoing' : 'incoming', requestId: r.id
    });
  }
  return map;
}

async function decorate(userId, users) {
  const rel = await relationships(userId, users);
  return users.map(u => publicUser(u, { relationship: rel.get(Number(u.id)) || { status: 'none', direction: null, requestId: null } }));
}

router.get('/search', async (req, res) => {
  try {
    const userId = me(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: { users: [], total: 0 } });
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const users = await Users.findAll({
      where: { id: { [Op.ne]: userId }, isActive: true, [Op.or]: [
        { username: { [Op.iLike]: `%${q}%` } },
        { firstName: { [Op.iLike]: `%${q}%` } },
        { lastName: { [Op.iLike]: `%${q}%` } }
      ] },
      attributes: attrs,
      order: [['username','ASC']],
      limit
    });
    res.json({ success: true, data: { users: await decorate(userId, users), total: users.length } });
  } catch (error) { console.error('[FriendDiscovery] search', error); res.status(500).json({ success: false, message: 'Unable to search users' }); }
});

router.get('/browse', async (req, res) => {
  try {
    const userId = me(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 60);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const users = await Users.findAll({ where: { id: { [Op.ne]: userId }, isActive: true }, attributes: attrs, order: [['username','ASC']], limit, offset });
    const count = await Users.count({ where: { id: { [Op.ne]: userId }, isActive: true } });
    res.json({ success: true, data: { users: await decorate(userId, users), total: count, offset, limit } });
  } catch (error) { console.error('[FriendDiscovery] browse', error); res.status(500).json({ success: false, message: 'Unable to browse users' }); }
});

router.get('/suggestions', async (req, res) => {
  try {
    const userId = me(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 40);
    const mine = await Friend.findAll({ where: { status: 'accepted', [Op.or]: [{ requesterId: userId }, { addresseeId: userId }] }, attributes: ['requesterId','addresseeId'] });
    const directIds = new Set();
    for (const f of mine) directIds.add(Number(f.requesterId) === userId ? Number(f.addresseeId) : Number(f.requesterId));
    if (!directIds.size) {
      const users = await Users.findAll({ where: { id: { [Op.ne]: userId }, isActive: true }, attributes: attrs, order: [['createdAt','DESC']], limit });
      return res.json({ success: true, data: { users: await decorate(userId, users), reason: 'discover' } });
    }
    const second = await Friend.findAll({ where: { status: 'accepted', [Op.or]: [{ requesterId: { [Op.in]: [...directIds] } }, { addresseeId: { [Op.in]: [...directIds] } }] }, attributes: ['requesterId','addresseeId'] });
    const candidateIds = new Set();
    for (const f of second) {
      const a = Number(f.requesterId), b = Number(f.addresseeId);
      if (directIds.has(a) && b !== userId && !directIds.has(b)) candidateIds.add(b);
      if (directIds.has(b) && a !== userId && !directIds.has(a)) candidateIds.add(a);
    }
    const ids = [...candidateIds].slice(0, limit);
    let users = ids.length ? await Users.findAll({ where: { id: { [Op.in]: ids }, isActive: true }, attributes: attrs }) : [];
    if (!users.length) users = await Users.findAll({ where: { id: { [Op.ne]: userId }, isActive: true }, attributes: attrs, order: [['createdAt','DESC']], limit });
    res.json({ success: true, data: { users: await decorate(userId, users), reason: 'mutuals' } });
  } catch (error) { console.error('[FriendDiscovery] suggestions', error); res.status(500).json({ success: false, message: 'Unable to load suggestions' }); }
});

router.put('/location', async (req, res) => {
  try {
    const userId = me(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    const lat = Number(req.body?.latitude), lng = Number(req.body?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ success: false, message: 'Invalid coordinates' });
    await sequelize.query('UPDATE "Users" SET "latitude" = :lat, "longitude" = :lng, "locationUpdatedAt" = CURRENT_TIMESTAMP WHERE "id" = :id', { replacements: { lat, lng, id: userId } });
    res.json({ success: true, data: { latitude: lat, longitude: lng, updatedAt: new Date().toISOString() } });
  } catch (error) { console.error('[FriendDiscovery] location', error); res.status(500).json({ success: false, message: 'Nearby location is not available yet' }); }
});

router.get('/nearby', async (req, res) => {
  try {
    const userId = me(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    const radius = Math.min(Math.max(Number(req.query.radius) || 25, 1), 100);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ success: false, message: 'Location permission is required for nearby people' });
    const users = await Users.findAll({
      where: { id: { [Op.ne]: userId }, isActive: true, latitude: { [Op.not]: null }, longitude: { [Op.not]: null } },
      attributes: attrs.concat(['latitude','longitude']),
      order: [['username','ASC']],
      limit: 200
    });
    const earth = 6371;
    const withDistance = users.map(u => {
      const la = Number(u.latitude) * Math.PI / 180, lo = Number(u.longitude) * Math.PI / 180;
      const p1 = lat * Math.PI / 180, p2 = lng * Math.PI / 180;
      const dLat = la - p1, dLon = lo - p2;
      const h = Math.sin(dLat/2)**2 + Math.cos(p1)*Math.cos(la)*Math.sin(dLon/2)**2;
      const km = earth * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
      return { user: u, km };
    }).filter(x => x.km <= radius).sort((a,b) => a.km - b.km).slice(0, 60);
    const decorated = await decorate(userId, withDistance.map(x => x.user));
    const byId = new Map(decorated.map(x => [Number(x.id), x]));
    res.json({ success: true, data: { users: withDistance.map(x => ({ ...byId.get(Number(x.user.id)), distanceKm: Math.round(x.km * 10) / 10 })), radiusKm: radius } });
  } catch (error) { console.error('[FriendDiscovery] nearby', error); res.status(500).json({ success: false, message: 'Unable to load nearby users' }); }
});

module.exports = router;
