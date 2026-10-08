/**
 * group-suggestions.js — group discovery endpoints (FIXED).
 *
 * What was wrong:
 *  - GET / returned a flat array, but the app (js/group-discover.js) expects
 *    { nearby: [], friends: [], public: [] }, so every tab was always empty.
 *  - The `q` (search) query parameter was ignored.
 *  - /:id/join and /:id/visibility did not exist (join always 404'd).
 *  - /manage returned suggestions instead of the groups the user administers.
 *  - The Chats table has no visibility column, so EVERY group (even private
 *    ones) was treated as public. Discoverability is now opt-in and stored in
 *    chats.metadata.discoverability = 'private' | 'friends' | 'public'
 *    (default: private). No migration needed (metadata is JSONB).
 */
'use strict';

const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const db = require('../models');

const VIS = ['private', 'friends', 'public'];

function auth(req, res, next) {
  const u = req.user || {};
  const id = Number(u.id || u.userId || u.sub || req.userId);
  if (!Number.isFinite(id) || id <= 0) return res.status(401).json({ success: false, message: 'Authentication required' });
  req.__uid = id;
  next();
}
const M = () => ({ Chat: db.Chats || db.Chat, CP: db.ChatParticipant, Friend: db.Friend });
const limitOf = (req) => { const n = parseInt(req.query.limit, 10); return Math.min(100, Math.max(1, Number.isFinite(n) ? n : 30)); };
const visOf = (g) => { const v = String((g.metadata && g.metadata.discoverability) || 'private').toLowerCase(); return VIS.includes(v) ? v : 'private'; };
const plain = (g) => (g.toJSON ? g.toJSON() : g);

function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function friendIdsOf(uid) {
  const { Friend } = M();
  if (!Friend) return [];
  const rows = await Friend.findAll({
    where: { status: 'accepted', [Op.or]: [{ requesterId: uid }, { addresseeId: uid }] },
    attributes: ['requesterId', 'addresseeId'], raw: true
  });
  return rows.map((r) => (Number(r.requesterId) === uid ? Number(r.addresseeId) : Number(r.requesterId)));
}

async function build(uid, req) {
  const { Chat, CP } = M();
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = limitOf(req);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  const mine = (await CP.findAll({ where: { userId: uid }, attributes: ['chatId'], raw: true })).map((x) => Number(x.chatId));
  const where = { type: 'group', isActive: true };
  if (mine.length) where.id = { [Op.notIn]: mine };
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q.replace(/[%_]/g, '\\$&')}%` } }, { description: { [Op.iLike]: `%${q.replace(/[%_]/g, '\\$&')}%` } }];

  const rows = (await Chat.findAll({ where, order: [['updatedAt', 'DESC']], limit: 300 })).map(plain).filter((g) => visOf(g) !== 'private');
  if (!rows.length) return { nearby: [], friends: [], public: [] };

  const ids = rows.map((g) => g.id);
  const parts = await CP.findAll({ where: { chatId: { [Op.in]: ids } }, attributes: ['chatId', 'userId'], raw: true });
  const members = new Map();
  parts.forEach((p) => { const k = Number(p.chatId); if (!members.has(k)) members.set(k, new Set()); members.get(k).add(Number(p.userId)); });
  const friends = new Set(await friendIdsOf(uid));

  const shape = (g) => {
    const set = members.get(Number(g.id)) || new Set();
    const fc = [...set].filter((id) => friends.has(id)).length;
    return { id: g.id, name: g.name || 'Group', description: g.description || '', avatar: g.avatar || null,
      memberCount: set.size, friendsCount: fc, visibility: visOf(g), _loc: g.metadata && g.metadata.location };
  };
  const all = rows.map(shape);
  const clean = (list) => list.slice(0, limit).map(({ _loc, ...x }) => x);

  const pub = all.filter((g) => g.visibility === 'public');
  const fr = all.filter((g) => g.friendsCount > 0).sort((a, b) => b.friendsCount - a.friendsCount);
  let near = [];
  if (here) {
    near = pub.filter((g) => g._loc && Number.isFinite(g._loc.lat) && Number.isFinite(g._loc.lng))
      .map((g) => ({ g, d: km(here, g._loc) })).filter((x) => x.d <= 50).sort((a, b) => a.d - b.d).map((x) => x.g);
  }
  return { nearby: clean(near), friends: clean(fr), public: clean(pub.sort((a, b) => b.memberCount - a.memberCount)) };
}

router.get('/', auth, async (req, res) => {
  try { const data = await build(req.__uid, req); res.json({ success: true, data }); }
  catch (e) { console.error('[GroupSuggestions] list failed:', e); res.status(500).json({ success: false, message: 'Failed to load group suggestions', code: 'GROUP_SUGGESTIONS_FAILED' }); }
});

// Groups the caller administers (so they can choose who may discover each one).
router.get('/manage', auth, async (req, res) => {
  try {
    const { Chat, CP } = M();
    const adm = await CP.findAll({ where: { userId: req.__uid, role: 'admin' }, attributes: ['chatId'], raw: true });
    const ids = adm.map((x) => Number(x.chatId));
    if (!ids.length) return res.json({ success: true, data: [] });
    const groups = (await Chat.findAll({ where: { id: { [Op.in]: ids }, type: 'group' }, order: [['updatedAt', 'DESC']] })).map(plain);
    res.json({ success: true, data: groups.map((g) => ({ id: g.id, name: g.name || 'Group', avatar: g.avatar || null, visibility: visOf(g) })) });
  } catch (e) { console.error('[GroupSuggestions] manage failed:', e); res.status(500).json({ success: false, message: 'Failed to load your groups', code: 'GROUP_SUGGESTIONS_MANAGE_FAILED' }); }
});

router.put('/:id/visibility', auth, async (req, res) => {
  try {
    const { Chat, CP } = M();
    const id = Number(req.params.id), v = String((req.body && req.body.visibility) || '').toLowerCase();
    if (!Number.isFinite(id) || !VIS.includes(v)) return res.status(400).json({ success: false, message: 'visibility must be private, friends or public' });
    const adm = await CP.findOne({ where: { chatId: id, userId: req.__uid, role: 'admin' } });
    if (!adm) return res.status(403).json({ success: false, message: 'Only group admins can change this' });
    const g = await Chat.findOne({ where: { id, type: 'group' } });
    if (!g) return res.status(404).json({ success: false, message: 'Group not found' });
    g.metadata = { ...(g.metadata || {}), discoverability: v };
    g.changed('metadata', true);
    await g.save();
    res.json({ success: true, data: { id, visibility: v } });
  } catch (e) { console.error('[GroupSuggestions] visibility failed:', e); res.status(500).json({ success: false, message: 'Could not change this' }); }
});

async function joinGroup(uid, id) {
  const { Chat, CP } = M();
  const g = Number.isFinite(id) ? await Chat.findOne({ where: { id, type: 'group', isActive: true } }) : null;
  if (!g) return { code: 404, body: { success: false, message: 'Group not found' } };
  if (await CP.findOne({ where: { chatId: id, userId: uid } })) return { code: 200, body: { success: true, data: { joined: true, already: true } } };
  const vis = visOf(g);
  if (vis === 'private') return { code: 403, body: { success: false, message: 'This group is invite only' } };
  if (vis === 'friends') {
    const friends = new Set(await friendIdsOf(uid));
    const m = await CP.findAll({ where: { chatId: id }, attributes: ['userId'], raw: true });
    if (!m.some((x) => friends.has(Number(x.userId)))) return { code: 403, body: { success: false, message: 'This group is only open to friends of its members' } };
  }
  if (g.settings && g.settings.requireAdminApproval) {
    const reqs = Array.isArray(g.metadata && g.metadata.joinRequests) ? g.metadata.joinRequests : [];
    if (!reqs.includes(uid)) { g.metadata = { ...(g.metadata || {}), joinRequests: [...reqs, uid] }; g.changed('metadata', true); await g.save(); }
    return { code: 200, body: { success: true, data: { pending: true } } };
  }
  await CP.create({ chatId: id, userId: uid, role: 'member', joinedAt: new Date() });
  return { code: 200, body: { success: true, data: { joined: true } } };
}

router.post('/:id/join', auth, async (req, res) => {
  try { const r = await joinGroup(req.__uid, Number(req.params.id)); res.status(r.code).json(r.body); }
  catch (e) { console.error('[GroupSuggestions] join failed:', e); res.status(500).json({ success: false, message: 'Could not join this group' }); }
});

// Legacy endpoint kept for older clients.
router.post('/manage', auth, async (req, res) => {
  const groupId = Number(req.body && req.body.groupId), action = String((req.body && req.body.action) || '').toLowerCase();
  if (!Number.isFinite(groupId) || !['join', 'dismiss', 'hide'].includes(action)) return res.status(400).json({ success: false, message: 'groupId and action (join, dismiss or hide) are required' });
  if (action !== 'join') return res.json({ success: true, action, groupId });
  try { const r = await joinGroup(req.__uid, groupId); res.status(r.code).json(r.body); }
  catch (e) { console.error('[GroupSuggestions] legacy join failed:', e); res.status(500).json({ success: false, message: 'Could not join this group' }); }
});

module.exports = router;