// src/services/identityBroadcastService.js
//
// CENTRALIZED REAL-TIME IDENTITY PROPAGATION
// ───────────────────────────────────────────
// This is the missing link that makes "edit profile → updates everywhere
// instantly" actually true. Before this file existed, a profile/avatar/
// cover/username/bio save only ever emitted `settings_updated` to the
// EDITOR's OWN device rooms (see routes/settings.js `_emitSettingsUpdated`,
// which only targets `user:${userId}`). Nobody else — no friend, no group
// co-member — was ever told the user's identity changed, so their UI kept
// showing the stale avatar/name until they refreshed or refetched.
//
// broadcastIdentityUpdate() fixes this by fanning the update out to:
//   1. The user's own other connected devices/tabs   (multi-device sync)
//   2. Every accepted friend                          (friend list, chat header, calls)
//   3. Every group the user currently belongs to       (group members/admin list, group chat)
//
// It always emits the generic `profile:update` event (full normalized
// identity payload) plus one targeted event per changed field
// (`avatar:update`, `cover:update`, `username:update`, `bio:update`) so
// existing and future listeners can subscribe to only what they care about.
'use strict';

const wsService = require('./webSocketService');
const { toPublicIdentity } = require('../utils/identityNormalizer');

async function _getContactIds(userId, db) {
  const ids = new Set();

  try {
    const Friend = db.Friend || (db.models && db.models.Friend);
    if (Friend && Friend.getUserFriends) {
      const friendships = await Friend.getUserFriends(userId, 'accepted');
      for (const f of friendships) {
        const otherId = String(f.requesterId) === String(userId) ? f.receiverId : f.requesterId;
        if (otherId) ids.add(String(otherId));
      }
    }
  } catch (_) { /* non-fatal — identity still reaches own devices */ }

  try {
    const GroupMembers = db.GroupMembers || (db.models && db.models.GroupMembers);
    if (GroupMembers && GroupMembers.findAll) {
      const myMemberships = await GroupMembers.findAll({ where: { userId, leftAt: null } });
      const groupIds = myMemberships.map(m => m.groupId).filter(Boolean);
      if (groupIds.length) {
        const { Op } = require('sequelize');
        const coMembers = await GroupMembers.findAll({
          where: { groupId: { [Op.in]: groupIds }, leftAt: null },
        });
        for (const m of coMembers) {
          if (String(m.userId) !== String(userId)) ids.add(String(m.userId));
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  return ids;
}

/**
 * @param {number|string} userId   - owner whose identity changed
 * @param {object} userRowOrPatch  - full user row (preferred) or at minimum the fields that changed
 * @param {string[]} changedFields - subset of ['avatar','cover','username','bio','displayName']
 */
async function broadcastIdentityUpdate(userId, userRowOrPatch, changedFields = []) {
  if (!userId) return;

  const identity = toPublicIdentity(userRowOrPatch);
  if (!identity) return;
  identity.id = identity.id || userId;

  const basePayload = {
    userId: identity.id,
    identity,
    changedFields,
    timestamp: Date.now(),
  };

  // 1) Owner's own other devices/tabs — instant multi-device sync.
  try { await wsService.sendToUser(userId, 'profile:update', basePayload); } catch (_) {}

  // 2 & 3) Friends + group co-members — everyone who can currently see this
  // user's identity anywhere in the app (messages, groups, calls, status,
  // marketplace, search, notifications) gets it pushed live.
  let db;
  try { db = require('../models'); } catch (_) { db = null; }

  if (db) {
    const contactIds = await _getContactIds(userId, db);
    for (const cid of contactIds) {
      try { await wsService.sendToUser(cid, 'profile:update', basePayload); } catch (_) {}
    }

    // Targeted, field-specific events for listeners that only care about one thing.
    const targets = [String(userId), ...contactIds];
    for (const field of changedFields) {
      const eventName = `${field === 'displayName' ? 'displayName' : field}:update`;
      for (const tid of targets) {
        try { await wsService.sendToUser(tid, eventName, basePayload); } catch (_) {}
      }
    }
  }

  return basePayload;
}

module.exports = { broadcastIdentityUpdate };
