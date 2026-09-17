'use strict';

const express = require('express');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');

const router = express.Router();
const Chat = db.Chats || db.Chat;
const Message = db.Messages || db.Message;
const ChatParticipant = db.ChatParticipant;
const User = db.Users || db.User;

const MAX_OPTIONS = 12;
const MAX_TEXT = 1000;
const MAX_EVENT_DAYS = 365;

function uid(req) {
  return Number(req.user?.userId || req.user?.id || 0);
}

function io(req) {
  return req.io || global.__socketIO || null;
}

async function participant(chatId, userId) {
  return ChatParticipant?.findOne({ where: { chatId, userId } });
}

async function groupAccess(chatId, userId) {
  if (!Chat || !ChatParticipant) return null;
  const p = await participant(chatId, userId);
  if (!p) return null;
  const chat = await Chat.findByPk(chatId);
  if (!chat || chat.type !== 'group' || chat.isActive === false) return null;
  return { chat, participant: p };
}

function manager(access) {
  return access && ['admin', 'owner'].includes(access.participant.role);
}

async function usersInChat(chatId) {
  const rows = await ChatParticipant.findAll({ where: { chatId }, attributes: ['userId'] });
  return rows.map(x => Number(x.userId));
}

async function emitChat(chatId, event, payload) {
  const socket = io({ io: null });
  if (!socket) return;
  const ids = await usersInChat(chatId);
  for (const id of ids) {
    socket.to(`user:${id}`).emit(event, payload);
    socket.to(`user_${id}`).emit(event, payload);
  }
}

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, max);
}

function featureState(chat) {
  const metadata = chat.metadata && typeof chat.metadata === 'object' ? chat.metadata : {};
  const current = metadata.groupPlatform && typeof metadata.groupPlatform === 'object'
    ? metadata.groupPlatform
    : {};
  return {
    ...current,
    polls: Array.isArray(current.polls) ? current.polls : [],
    events: Array.isArray(current.events) ? current.events : [],
    moderation: Array.isArray(current.moderation) ? current.moderation : [],
    blockedUsers: Array.isArray(current.blockedUsers) ? current.blockedUsers : [],
    bots: Array.isArray(current.bots) ? current.bots : [],
    communityId: current.communityId || null,
    announcementOnly: current.announcementOnly === true,
    disappearingSeconds: Number(current.disappearingSeconds || 0),
    updatedAt: current.updatedAt || null,
  };
}

async function saveFeatures(chat, state) {
  const metadata = chat.metadata && typeof chat.metadata === 'object' ? { ...chat.metadata } : {};
  metadata.groupPlatform = { ...state, updatedAt: new Date().toISOString() };
  chat.metadata = metadata;
  chat.changed('metadata', true);
  await chat.save();
  return metadata.groupPlatform;
}

async function audit(chat, actorId, action, details = {}) {
  const state = featureState(chat);
  state.moderation.unshift({
    id: crypto.randomUUID(),
    actorId: Number(actorId),
    action: cleanText(action, 100),
    details,
    createdAt: new Date().toISOString(),
  });
  state.moderation = state.moderation.slice(0, 500);
  await saveFeatures(chat, state);
}

function findPoll(state, pollId) {
  return state.polls.find(p => String(p.id) === String(pollId));
}

// ---------------------------------------------------------------------------
// Unified group feature state / multi-device synchronization
// ---------------------------------------------------------------------------
router.get('/:chatId/state', async (req, res) => {
  const access = await groupAccess(req.params.chatId, uid(req));
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const state = featureState(access.chat);
  return res.json({
    success: true,
    data: {
      chatId: access.chat.id,
      updatedAt: state.updatedAt,
      announcementOnly: state.announcementOnly,
      disappearingSeconds: state.disappearingSeconds,
      communityId: state.communityId,
      polls: state.polls,
      events: state.events,
      blockedUsers: state.blockedUsers,
      security: access.chat.metadata?.groupEncryption || null,
    },
  });
});

router.get('/:chatId/sync', async (req, res) => {
  const access = await groupAccess(req.params.chatId, uid(req));
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const since = req.query.since ? new Date(req.query.since) : new Date(0);
  const messages = await Message.findAll({
    where: {
      chatId: access.chat.id,
      createdAt: { [Op.gt]: Number.isNaN(since.getTime()) ? new Date(0) : since },
      isDeleted: false,
    },
    order: [['createdAt', 'ASC']],
    limit: 200,
  });
  const state = featureState(access.chat);
  return res.json({
    success: true,
    data: {
      chatId: access.chat.id,
      serverTime: new Date().toISOString(),
      messages,
      featureState: state,
      security: access.chat.metadata?.groupEncryption || null,
    },
  });
});

// ---------------------------------------------------------------------------
// Polls inside group chat. Polls are first-class Messages(type=poll) and the
// authoritative vote state lives in the message metadata.
// ---------------------------------------------------------------------------
router.post('/:chatId/polls', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });

  const question = cleanText(req.body?.question, 500);
  const options = Array.isArray(req.body?.options)
    ? req.body.options.map(x => cleanText(x, 200)).filter(Boolean).slice(0, MAX_OPTIONS)
    : [];
  if (!question || options.length < 2) {
    return res.status(400).json({ success: false, message: 'Poll question and at least two options are required' });
  }

  const pollId = crypto.randomUUID();
  const poll = {
    id: pollId,
    question,
    options: options.map((label, index) => ({ id: String(index + 1), label, votes: 0 })),
    multiple: req.body?.multiple === true,
    anonymous: req.body?.anonymous === true,
    closed: false,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    voters: {},
  };

  // FIX (COMPETING-PIPELINE): this used to be a raw Message.create() —
  // exactly the bug class already found and fixed in status.js's reply
  // route (see that route's own comment): no messageBroadcast real-time
  // emit, no `.sender` lookup/attach (so the poll message would render with
  // the generic "User" placeholder on first load), and no receiverId
  // resolution. Routed through the one canonical send path instead —
  // sendMessage() requires a clientMessageId even for a server-initiated
  // send like this one, so a fresh one is generated here.
  const messageDeliveryService = require('../services/messageDeliveryService');
  const messageBroadcast = require('../services/messageBroadcast');
  const sendResult = await messageDeliveryService.sendMessage({
    chatId: access.chat.id,
    senderId: userId,
    content: question,
    type: 'poll',
    clientMessageId: `poll-${pollId}`,
    metadata: { groupId: access.chat.id, pollId, poll },
  });
  const message = sendResult.message || sendResult;
  try { await messageBroadcast.broadcastNewMessage(message, userId); } catch (_) {}

  const state = featureState(access.chat);
  state.polls.unshift(poll);
  state.polls = state.polls.slice(0, 200);
  await saveFeatures(access.chat, state);
  await emitChat(access.chat.id, 'group:poll:new', { chatId: access.chat.id, message, poll });

  return res.status(201).json({ success: true, data: { message, poll } });
});

router.get('/:chatId/polls', async (req, res) => {
  const access = await groupAccess(req.params.chatId, uid(req));
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const state = featureState(access.chat);
  const polls = state.polls.map(p => ({
    ...p,
    voters: undefined,
  }));
  return res.json({ success: true, data: polls });
});

router.post('/:chatId/polls/:pollId/vote', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const state = featureState(access.chat);
  const poll = findPoll(state, req.params.pollId);
  if (!poll) return res.status(404).json({ success: false, message: 'Poll not found' });
  if (poll.closed) return res.status(409).json({ success: false, message: 'Poll is closed' });

  let selected = Array.isArray(req.body?.optionIds) ? req.body.optionIds.map(String) : [String(req.body?.optionId || '')];
  selected = [...new Set(selected.filter(id => poll.options.some(o => o.id === id)))];
  if (!selected.length) return res.status(400).json({ success: false, message: 'Select a valid poll option' });
  if (!poll.multiple && selected.length > 1) return res.status(400).json({ success: false, message: 'This poll allows one choice' });

  const key = String(userId);
  const previous = Array.isArray(poll.voters?.[key]) ? poll.voters[key] : [];
  for (const optionId of previous) {
    const option = poll.options.find(o => o.id === optionId);
    if (option) option.votes = Math.max(0, Number(option.votes || 0) - 1);
  }
  for (const optionId of selected) {
    const option = poll.options.find(o => o.id === optionId);
    option.votes = Number(option.votes || 0) + 1;
  }
  if (!poll.anonymous) poll.voters[key] = selected;
  else poll.voters[key] = selected;
  await saveFeatures(access.chat, state);

  // Keep the first-class message metadata synchronized with the authoritative poll state.
  await Message.update(
    { metadata: { groupId: access.chat.id, pollId: poll.id, poll } },
    { where: { chatId: access.chat.id, type: 'poll', metadata: { pollId: poll.id } } }
  ).catch(() => {});

  await emitChat(access.chat.id, 'group:poll:updated', { chatId: access.chat.id, poll: { ...poll, voters: undefined } });
  return res.json({ success: true, data: { poll: { ...poll, voters: undefined }, selected } });
});

router.post('/:chatId/polls/:pollId/close', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const state = featureState(access.chat);
  const poll = findPoll(state, req.params.pollId);
  if (!poll) return res.status(404).json({ success: false, message: 'Poll not found' });
  poll.closed = true;
  poll.closedAt = new Date().toISOString();
  poll.closedBy = userId;
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'poll_closed', { pollId: poll.id });
  await emitChat(access.chat.id, 'group:poll:updated', { chatId: access.chat.id, poll: { ...poll, voters: undefined } });
  return res.json({ success: true, data: poll });
});

// ---------------------------------------------------------------------------
// Group events
// ---------------------------------------------------------------------------
router.post('/:chatId/events', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const title = cleanText(req.body?.title, 200);
  const description = cleanText(req.body?.description, 2000);
  const startsAt = new Date(req.body?.startsAt);
  if (!title || Number.isNaN(startsAt.getTime())) return res.status(400).json({ success: false, message: 'Valid title and startsAt are required' });
  if (startsAt.getTime() > Date.now() + MAX_EVENT_DAYS * 86400000) return res.status(400).json({ success: false, message: 'Event is too far in the future' });

  const state = featureState(access.chat);
  const event = {
    id: crypto.randomUUID(),
    title,
    description,
    startsAt: startsAt.toISOString(),
    endsAt: req.body?.endsAt ? new Date(req.body.endsAt).toISOString() : null,
    location: cleanText(req.body?.location, 500),
    createdBy: userId,
    createdAt: new Date().toISOString(),
    attendees: {},
  };
  state.events.unshift(event);
  state.events = state.events.slice(0, 200);
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'event_created', { eventId: event.id });
  await emitChat(access.chat.id, 'group:event:created', { chatId: access.chat.id, event });
  return res.status(201).json({ success: true, data: event });
});

router.get('/:chatId/events', async (req, res) => {
  const access = await groupAccess(req.params.chatId, uid(req));
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  return res.json({ success: true, data: featureState(access.chat).events });
});

router.post('/:chatId/events/:eventId/rsvp', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const state = featureState(access.chat);
  const event = state.events.find(x => String(x.id) === String(req.params.eventId));
  if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
  const status = ['going', 'maybe', 'declined'].includes(req.body?.status) ? req.body.status : 'maybe';
  event.attendees[String(userId)] = status;
  await saveFeatures(access.chat, state);
  await emitChat(access.chat.id, 'group:event:updated', { chatId: access.chat.id, event });
  return res.json({ success: true, data: event });
});

// ---------------------------------------------------------------------------
// Communities: a community is represented by a dedicated group chat with
// metadata.communityRoot=true; existing group chats can then be attached.
// ---------------------------------------------------------------------------
router.post('/communities', async (req, res) => {
  const userId = uid(req);
  const name = cleanText(req.body?.name, 100);
  const description = cleanText(req.body?.description, 1000);
  if (!userId || !name) return res.status(400).json({ success: false, message: 'Community name is required' });

  const community = await Chat.create({
    type: 'group',
    name,
    description,
    createdBy: userId,
    metadata: { communityRoot: true, community: { id: crypto.randomUUID(), name, description, createdBy: userId, createdAt: new Date().toISOString() } },
  });
  await ChatParticipant.create({ chatId: community.id, userId, role: 'admin', joinedAt: new Date() });
  return res.status(201).json({ success: true, data: { communityId: community.metadata.community.id, chatId: community.id, community: community.metadata.community } });
});

router.get('/communities/:communityId', async (req, res) => {
  const userId = uid(req);
  const roots = await Chat.findAll({ where: { type: 'group' }, limit: 200 });
  const root = roots.find(c => c.metadata?.communityRoot && String(c.metadata?.community?.id) === String(req.params.communityId));
  if (!root) return res.status(404).json({ success: false, message: 'Community not found' });
  if (!(await participant(root.id, userId))) return res.status(403).json({ success: false, message: 'Community access denied' });
  const groups = roots.filter(c => String(c.metadata?.groupPlatform?.communityId || '') === String(req.params.communityId));
  return res.json({ success: true, data: { community: root.metadata.community, rootChatId: root.id, groups } });
});

router.post('/communities/:communityId/groups/:chatId', async (req, res) => {
  const userId = uid(req);
  const roots = await Chat.findAll({ where: { type: 'group' }, limit: 200 });
  const root = roots.find(c => c.metadata?.communityRoot && String(c.metadata?.community?.id) === String(req.params.communityId));
  if (!root || !(await participant(root.id, userId))) return res.status(403).json({ success: false, message: 'Community admin permission required' });
  const rootParticipant = await participant(root.id, userId);
  if (!['admin', 'owner'].includes(rootParticipant.role)) return res.status(403).json({ success: false, message: 'Community admin permission required' });
  const group = await Chat.findByPk(req.params.chatId);
  if (!group || group.type !== 'group') return res.status(404).json({ success: false, message: 'Group not found' });
  const state = featureState(group);
  state.communityId = req.params.communityId;
  await saveFeatures(group, state);
  await emitChat(group.id, 'group:community:updated', { chatId: group.id, communityId: req.params.communityId });
  return res.json({ success: true, data: { chatId: group.id, communityId: req.params.communityId } });
});

// ---------------------------------------------------------------------------
// Announcement groups + disappearing-message policy. The policy is stored in
// group state and exposed to every device through /state and /sync.
// ---------------------------------------------------------------------------
router.put('/:chatId/announcement', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const state = featureState(access.chat);
  state.announcementOnly = req.body?.enabled === true;
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, state.announcementOnly ? 'announcement_enabled' : 'announcement_disabled');
  await emitChat(access.chat.id, 'group:announcement:updated', { chatId: access.chat.id, enabled: state.announcementOnly });
  return res.json({ success: true, data: { enabled: state.announcementOnly } });
});

router.put('/:chatId/disappearing', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const seconds = [0, 86400, 604800, 2592000, 7776000].includes(Number(req.body?.seconds)) ? Number(req.body.seconds) : 0;
  const state = featureState(access.chat);
  state.disappearingSeconds = seconds;
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'disappearing_policy_changed', { seconds });
  await emitChat(access.chat.id, 'group:disappearing:updated', { chatId: access.chat.id, seconds });
  return res.json({ success: true, data: { seconds } });
});

router.post('/:chatId/disappearing/enforce', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const state = featureState(access.chat);
  if (!state.disappearingSeconds) return res.json({ success: true, data: { expired: 0 } });
  const cutoff = new Date(Date.now() - state.disappearingSeconds * 1000);
  const [count] = await Message.update(
    { isDeleted: true, deletedAt: new Date(), deletedBy: userId },
    { where: { chatId: access.chat.id, isDeleted: false, createdAt: { [Op.lte]: cutoff } } }
  );
  if (count) await emitChat(access.chat.id, 'group:messages:expired', { chatId: access.chat.id, count });
  return res.json({ success: true, data: { expired: count || 0 } });
});

// ---------------------------------------------------------------------------
// Group-specific block/report + moderation dashboard.
// ---------------------------------------------------------------------------
router.post('/:chatId/block', async (req, res) => {
  const userId = uid(req);
  const targetId = Number(req.body?.userId);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !targetId || (!manager(access) && targetId !== userId)) return res.status(403).json({ success: false, message: 'Permission denied' });
  const target = await participant(access.chat.id, targetId);
  if (!target) return res.status(404).json({ success: false, message: 'User is not a group member' });
  const state = featureState(access.chat);
  if (!state.blockedUsers.includes(targetId)) state.blockedUsers.push(targetId);
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'member_blocked', { targetId });
  await emitChat(access.chat.id, 'group:block:updated', { chatId: access.chat.id, userId: targetId, blocked: true });
  return res.json({ success: true, data: { userId: targetId, blocked: true } });
});

router.delete('/:chatId/block/:userId', async (req, res) => {
  const userId = uid(req);
  const targetId = Number(req.params.userId);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || (!manager(access) && targetId !== userId)) return res.status(403).json({ success: false, message: 'Permission denied' });
  const state = featureState(access.chat);
  state.blockedUsers = state.blockedUsers.filter(id => Number(id) !== targetId);
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'member_unblocked', { targetId });
  return res.json({ success: true, data: { userId: targetId, blocked: false } });
});

router.post('/:chatId/report', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access) return res.status(403).json({ success: false, message: 'Group access denied' });
  const targetId = Number(req.body?.userId || 0);
  const reason = cleanText(req.body?.reason, 500);
  await audit(access.chat, userId, 'member_reported', { targetId, reason });
  await emitChat(access.chat.id, 'group:moderation:report', { chatId: access.chat.id, targetId, reason });
  return res.status(201).json({ success: true, data: { reported: true } });
});

router.get('/:chatId/moderation', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const state = featureState(access.chat);
  const [members, messages, admins] = await Promise.all([
    ChatParticipant.count({ where: { chatId: access.chat.id } }),
    Message.count({ where: { chatId: access.chat.id } }),
    ChatParticipant.count({ where: { chatId: access.chat.id, role: 'admin' } }),
  ]);
  return res.json({ success: true, data: { members, messages, admins, blockedUsers: state.blockedUsers, audit: state.moderation.slice(0, 100), announcementOnly: state.announcementOnly, disappearingSeconds: state.disappearingSeconds } });
});

// ---------------------------------------------------------------------------
// Bots/integrations. Webhook destinations must be HTTPS and can be restricted
// with GROUP_BOT_ALLOWLIST (comma-separated hostnames) in the backend env.
// ---------------------------------------------------------------------------
function validWebhook(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const allow = String(process.env.GROUP_BOT_ALLOWLIST || '').split(',').map(x => x.trim()).filter(Boolean);
    return !allow.length || allow.includes(u.hostname);
  } catch (_) {
    return false;
  }
}

router.post('/:chatId/bots', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const name = cleanText(req.body?.name, 100);
  const webhookUrl = cleanText(req.body?.webhookUrl, 2000);
  if (!name || !validWebhook(webhookUrl)) return res.status(400).json({ success: false, message: 'Bot name and an allowed HTTPS webhook are required' });
  const state = featureState(access.chat);
  const bot = { id: crypto.randomUUID(), name, webhookUrl, createdBy: userId, createdAt: new Date().toISOString(), enabled: true };
  state.bots.push(bot);
  state.bots = state.bots.slice(-50);
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'bot_added', { botId: bot.id, name });
  return res.status(201).json({ success: true, data: { ...bot, webhookUrl: undefined } });
});

router.get('/:chatId/bots', async (req, res) => {
  const access = await groupAccess(req.params.chatId, uid(req));
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  return res.json({ success: true, data: featureState(access.chat).bots.map(({ webhookUrl, ...safe }) => safe) });
});

router.delete('/:chatId/bots/:botId', async (req, res) => {
  const userId = uid(req);
  const access = await groupAccess(req.params.chatId, userId);
  if (!access || !manager(access)) return res.status(403).json({ success: false, message: 'Group admin permission required' });
  const state = featureState(access.chat);
  state.bots = state.bots.filter(b => String(b.id) !== String(req.params.botId));
  await saveFeatures(access.chat, state);
  await audit(access.chat, userId, 'bot_removed', { botId: req.params.botId });
  return res.json({ success: true });
});

module.exports = router;
