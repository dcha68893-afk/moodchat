'use strict';

const express = require('express');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const { authenticateToken } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const db = () => require('../models');
const Status = () => db().Status;
const Users = () => db().Users;
const Friend = () => db().Friend;

const VALID_TYPES = new Set(['text', 'image', 'video', 'poll', 'link']);
const VALID_PRIVACY = new Set(['all_contacts', 'contacts_except', 'only_share_with', 'close_friends', 'public', 'private']);
const MAX_TEXT = 4000;
const MAX_TOPICS = 10;

const uid = req => Number(req.user?.userId || req.user?.id);
const cleanList = (value, max = 100) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, max) : [];
const safeUrl = value => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value) ? value.slice(0, 2000) : null;

async function ownerPayload(status) {
  const user = await Users().findByPk(status.userId, { attributes: ['id', 'username', 'displayName', 'avatar'] }).catch(() => null);
  return {
    ...status.toJSON(),
    owner: user ? user.toJSON() : { id: status.userId, username: 'User', displayName: 'User', avatar: null },
  };
}

async function canView(status, viewerId) {
  if (!status || !status.isActive || new Date(status.expiresAt).getTime() <= Date.now()) return false;
  if (status.userId === viewerId) return true;
  if (status.isPublic || status.privacy === 'public') return true;
  if (status.privacy === 'private') return false;
  const list = Array.isArray(status.privacyList) ? status.privacyList.map(Number) : [];
  if (status.privacy === 'only_share_with') return list.includes(viewerId);
  if (status.privacy === 'contacts_except') return !list.includes(viewerId);
  if (status.privacy === 'close_friends') {
    const FriendModel = Friend();
    if (!FriendModel) return false;
    const rows = await FriendModel.getUserFriends(viewerId, 'accepted').catch(() => []);
    const ids = rows.map(f => Number(f.friend?.requesterId) === viewerId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId));
    return ids.includes(Number(status.userId));
  }
  const FriendModel = Friend();
  if (!FriendModel) return false;
  const rows = await FriendModel.getUserFriends(viewerId, 'accepted').catch(() => []);
  const ids = rows.map(f => Number(f.friend?.requesterId) === viewerId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId));
  return ids.includes(Number(status.userId));
}

function normalizeBody(body, userId) {
  const type = VALID_TYPES.has(body.type) ? body.type : 'text';
  const privacy = VALID_PRIVACY.has(body.privacy) ? body.privacy : 'all_contacts';
  const content = typeof body.content === 'string' ? body.content.trim().slice(0, MAX_TEXT) : null;
  const topics = cleanList(body.topics, MAX_TOPICS);
  const durationSeconds = Math.min(Math.max(Number(body.durationSeconds) || 7, 3), 30);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    userId,
    content,
    type,
    mediaUrl: safeUrl(body.mediaUrl),
    mediaPublicId: typeof body.mediaPublicId === 'string' ? body.mediaPublicId.slice(0, 500) : null,
    mediaMime: typeof body.mediaMime === 'string' ? body.mediaMime.slice(0, 120) : null,
    thumbnailUrl: safeUrl(body.thumbnailUrl),
    caption: typeof body.caption === 'string' ? body.caption.trim().slice(0, 2000) : null,
    background: typeof body.background === 'string' ? body.background.slice(0, 120) : null,
    font: typeof body.font === 'string' ? body.font.slice(0, 80) : null,
    musicUrl: safeUrl(body.musicUrl),
    linkUrl: safeUrl(body.linkUrl),
    mentions: cleanList(body.mentions, 50),
    stickers: Array.isArray(body.stickers) ? body.stickers.slice(0, 30) : [],
    topics,
    moodType: typeof body.moodType === 'string' ? body.moodType.slice(0, 60) : null,
    category: typeof body.category === 'string' ? body.category.slice(0, 60) : null,
    intent: typeof body.intent === 'string' ? body.intent.slice(0, 60) : null,
    privacy,
    privacyList: cleanList(body.privacyList, 200),
    durationSeconds,
    allowReplies: body.allowReplies !== false,
    allowReactions: body.allowReactions !== false,
    allowSharing: body.allowSharing !== false,
    isPublic: privacy === 'public',
    isActive: true,
    expiresAt,
  };
}

// Health is public.
router.get('/health', asyncHandler(async (req, res) => {
  const S = Status();
  return res.json({ success: !!S, feature: 'professional-status', version: '5.0.0' });
}));

// Create status.
router.post('/', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  const data = normalizeBody(req.body || {}, userId);
  if (!data.content && !data.mediaUrl && data.type !== 'poll') {
    return res.status(400).json({ success: false, message: 'Status needs text, media, or a poll.' });
  }
  if (data.type === 'video' && data.mediaMime && !data.mediaMime.startsWith('video/')) {
    return res.status(400).json({ success: false, message: 'Invalid video media type.' });
  }
  if (data.type === 'image' && data.mediaMime && !data.mediaMime.startsWith('image/')) {
    return res.status(400).json({ success: false, message: 'Invalid image media type.' });
  }
  const status = await Status().create(data);
  const result = await ownerPayload(status);
  const io = global.__socketIO;
  if (io) {
    io.to('user:' + userId).emit('status:new', { story: result });
    io.to('user_' + userId).emit('status:new', { story: result });
    const friendRows = await Friend().getUserFriends(userId, 'accepted').catch(() => []);
    const friendIds = friendRows.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
    for (const friendId of friendIds) {
      io.to('user:' + friendId).emit('status:new', { story: result });
      io.to('user_' + friendId).emit('status:new', { story: result });
    }
  }
  return res.status(201).json({ success: true, status: result });
}));

// Compatibility/default status feed. Older shells request GET /api/status directly.
router.get('/', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  const friends = await Friend().getUserFriends(userId, 'accepted');
  const ids = friends.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
  const statuses = await Status().getFriendsStatuses(userId, ids);
  const visible = [];
  for (const s of statuses) if (await canView(s, userId)) visible.push(await ownerPayload(s));
  const mine = await Status().getUserStatuses(userId, { activeOnly: true });
  return res.json({ success: true, data: [...(await Promise.all(mine.map(ownerPayload))), ...visible] });
}));

// Current user's active statuses.
router.get('/my', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().getUserStatuses(uid(req), { activeOnly: true });
  return res.json({ success: true, data: await Promise.all(statuses.map(async s => ({ ...(await ownerPayload(s)), viewedByMe: true }))) });
}));

// Friend statuses.
router.get('/friends', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = uid(req);
  const friends = await Friend().getUserFriends(userId, 'accepted');
  const ids = friends.map(f => Number(f.friend?.requesterId) === userId ? Number(f.friend?.addresseeId) : Number(f.friend?.requesterId)).filter(Number.isFinite);
  const statuses = await Status().getFriendsStatuses(userId, ids);
  const visible = [];
  for (const s of statuses) if (await canView(s, userId)) visible.push(await ownerPayload(s));
  const View = db().StatusView;
  const viewedIds = new Set();
  if (View && visible.length) {
    const rows = await View.findAll({ where: { statusId: visible.map(s => s.id), viewerId: userId }, attributes: ['statusId'] }).catch(() => []);
    rows.forEach(v => viewedIds.add(Number(v.statusId)));
  }
  const data = visible.map(s => ({ ...s, viewedByMe: viewedIds.has(Number(s.id)) }));
  return res.json({ success: true, data });
}));

// Public feed / trending.
router.get('/public', apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().findAll({ where: { isActive: true, isPublic: true, expiresAt: { [Op.gt]: new Date() } }, order: [['createdAt', 'DESC']], limit: 100 });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/trending', apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().findAll({ where: { isActive: true, isPublic: true, expiresAt: { [Op.gt]: new Date() } }, order: [['viewCount', 'DESC'], ['createdAt', 'DESC']], limit: 50 });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.json({ success: true, data: [] });
  const statuses = await Status().findAll({
    where: { isActive: true, expiresAt: { [Op.gt]: new Date() }, isPublic: true, [Op.or]: [{ content: { [Op.iLike]: '%' + q + '%' } }, { caption: { [Op.iLike]: '%' + q + '%' } }] },
    order: [['createdAt', 'DESC']], limit: 50,
  });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/mood/:moodType', apiRateLimiter, asyncHandler(async (req, res) => {
  const statuses = await Status().findAll({ where: { moodType: req.params.moodType, isActive: true, expiresAt: { [Op.gt]: new Date() }, isPublic: true }, order: [['createdAt', 'DESC']], limit: 50 });
  return res.json({ success: true, data: await Promise.all(statuses.map(ownerPayload)) });
}));

router.get('/user/:userId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const target = Number(req.params.userId);
  const statuses = await Status().findAll({ where: { userId: target, isActive: true, expiresAt: { [Op.gt]: new Date() } }, order: [['createdAt', 'ASC']] });
  const visible = [];
  for (const s of statuses) if (await canView(s, uid(req))) visible.push(await ownerPayload(s));
  return res.json({ success: true, data: visible });
}));

router.get('/stats', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  return res.json({ success: true, data: await Status().getStatusStats(uid(req)) });
}));

router.get('/:statusId', apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
  const viewer = uid(req) || 0;
  if (!(await canView(status, viewer))) return res.status(403).json({ success: false, message: 'This status is private.' });
  return res.json({ success: true, status: await ownerPayload(status) });
}));



// View endpoint is intentionally idempotent per viewer.
async function recordView(req, res) {
  const viewerId = uid(req) || null;
  const status = await Status().findByPk(Number(req.params.statusId || req.body?.statusId));
  if (!status || !(await canView(status, viewerId))) return res.status(404).json({ success: false, message: 'Status not found' });
  const View = db().StatusView;
  let created = false;
  if (View) {
    const [, wasCreated] = await View.findOrCreate({ where: { statusId: status.id, viewerId: viewerId || 0 }, defaults: { viewedAt: new Date() } });
    created = wasCreated;
  }
  if (created) await status.increment('viewCount');
  const io = global.__socketIO;
  if (created && io) io.to('user:' + status.userId).emit('status:viewed', { storyId: status.id, viewCount: Number(status.viewCount || 0) + 1, viewerId });
  return res.json({ success: true, created });
}
router.post('/view', recordView);
router.post('/:statusId/view', recordView);

router.get('/:statusId/viewers', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || status.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Status not found' });
  const View = db().StatusView;
  const views = View ? await View.findAll({ where: { statusId: status.id }, order: [['viewedAt', 'DESC']], limit: 500 }) : [];
  const users = await Promise.all(views.map(v => Users().findByPk(v.viewerId, { attributes: ['id','username','displayName','avatar'] }).catch(() => null)));
  return res.json({ success: true, data: views.map((v,i) => ({ ...v.toJSON(), viewer: users[i] })) });
}));

router.get('/:statusId/likes', apiRateLimiter, asyncHandler(async (req, res) => {
  const Like = db().StatusLike;
  const likes = Like ? await Like.findAll({ where: { statusId: Number(req.params.statusId) }, order: [['createdAt', 'DESC']], limit: 200 }) : [];
  return res.json({ success: true, data: likes });
}));

router.post('/:statusId/like', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || !(await canView(status, uid(req))) || !status.allowReactions) return res.status(404).json({ success: false, message: 'Status unavailable' });
  const Reaction = db().StatusReaction;
  const emoji = String(req.body?.emoji || '❤️').slice(0, 16);
  const [reaction] = await Reaction.findOrCreate({ where: { statusId: status.id, userId: uid(req) }, defaults: { emoji } });
  if (!reaction.changed()) {
    await Reaction.update({ emoji }, { where: { id: reaction.id } });
  }
  const count = await Reaction.count({ where: { statusId: status.id } });
  await status.update({ reactionCount: count });
  const io = global.__socketIO;
  if (io) io.to('user:' + status.userId).emit('status:reaction', { storyId: status.id, userId: uid(req), emoji, count });
  return res.json({ success: true, reaction: reaction.toJSON(), count });
}));

router.delete('/:statusId/like', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Reaction = db().StatusReaction;
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status) return res.status(404).json({ success: false, message: 'Status not found' });
  await Reaction.destroy({ where: { statusId: status.id, userId: uid(req) } });
  const count = await Reaction.count({ where: { statusId: status.id } });
  await status.update({ reactionCount: count });
  return res.json({ success: true, count });
}));

router.post('/:statusId/comment', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || !(await canView(status, uid(req))) || !status.allowReplies) return res.status(404).json({ success: false, message: 'Replies are disabled.' });
  const Reply = db().StatusReply;
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ success: false, message: 'Reply cannot be empty.' });
  const reply = await Reply.create({ statusId: status.id, userId: uid(req), text });
  await status.increment('replyCount');
  const io = global.__socketIO;
  if (io) io.to('user:' + status.userId).emit('status:reply', { storyId: status.id, userId: uid(req), text, replyId: reply.id });
  return res.status(201).json({ success: true, reply: reply.toJSON() });
}));

router.get('/:statusId/comments', apiRateLimiter, asyncHandler(async (req, res) => {
  const Reply = db().StatusReply;
  const replies = Reply ? await Reply.findAll({ where: { statusId: Number(req.params.statusId) }, order: [['createdAt', 'ASC']], limit: 200 }) : [];
  return res.json({ success: true, data: replies });
}));

router.delete('/:statusId/comment/:commentId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Reply = db().StatusReply;
  const reply = await Reply.findByPk(Number(req.params.commentId));
  if (!reply || reply.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Reply not found' });
  await reply.destroy();
  return res.json({ success: true });
}));

router.post('/:statusId/share', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || !(await canView(status, uid(req))) || !status.allowSharing) return res.status(404).json({ success: false, message: 'Sharing is disabled.' });
  await status.increment('shareCount');
  return res.json({ success: true });
}));

router.put('/:statusId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || status.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Status not found' });
  const allowed = ['caption', 'content', 'background', 'font', 'musicUrl', 'linkUrl', 'mentions', 'stickers', 'topics', 'moodType', 'category', 'intent', 'privacy', 'privacyList', 'allowReplies', 'allowReactions', 'allowSharing', 'highlight'];
  const patch = {};
  for (const key of allowed) if (req.body?.[key] !== undefined) patch[key] = req.body[key];
  if (patch.privacy && !VALID_PRIVACY.has(patch.privacy)) delete patch.privacy;
  await status.update(patch);
  return res.json({ success: true, status: await ownerPayload(status) });
}));

router.delete('/:statusId', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const status = await Status().findByPk(Number(req.params.statusId));
  if (!status || status.userId !== uid(req)) return res.status(404).json({ success: false, message: 'Status not found' });
  await status.update({ isActive: false, expiresAt: new Date() });
  const io = global.__socketIO;
  if (io) {
    const payload = { storyId: status.id, userId: uid(req) };
    io.to('user:' + uid(req)).emit('status:deleted', payload);
    io.to('user_' + uid(req)).emit('status:deleted', payload);
  }
  return res.json({ success: true });
}));


router.post('/:statusId/report', authenticateToken, apiRateLimiter, asyncHandler(async (req, res) => {
  const Report = db().StatusReport;
  if (!Report) return res.status(503).json({ success: false, message: 'Reporting unavailable' });
  const reason = String(req.body?.reason || 'other').slice(0, 80);
  const details = String(req.body?.details || '').slice(0, 1000);
  await Report.create({ statusId: Number(req.params.statusId), reporterId: uid(req), reason, details });
  return res.status(201).json({ success: true });
}));

module.exports = router;