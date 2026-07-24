// src/utils/identityNormalizer.js
//
// CENTRALIZED IDENTITY NORMALIZER
// ────────────────────────────────
// Problem this fixes: different modules (friends, groups, calls, status,
// marketplace, search, notifications) were each reading whatever field
// happened to exist on whatever shape of row they had — `avatar`,
// `avatarUrl`, `photoURL`, `profileImage`, `profilePhoto`, `picture`,
// `userAvatar`, `coverImage` — with no single agreed-upon contract. That is
// why the same user could show a photo in one screen and initials in
// another: it was never the same field.
//
// The real database column is `avatar` (Users.avatar) and `coverPhoto`
// (Users.coverPhoto) — see models/Users.js. Every other name below is a
// LEGACY ALIAS that some older piece of code still produces; this
// normalizer accepts all of them on read (so nothing breaks) but only
// ever WRITES/RETURNS the canonical shape, so from here on every consumer
// gets exactly one identity contract:
//
//   {
//     id, username, displayName, avatar, coverPhoto, bio,
//     isVerified, isOnline, lastSeen, statusMessage
//   }
//
// Use `toPublicIdentity(row)` anywhere a user/friend/group-member/caller/
// seller/search-result/notification-actor is serialized for the client.
'use strict';

const LEGACY_AVATAR_KEYS = ['avatar', 'avatarUrl', 'photoURL', 'profileImage', 'profilePhoto', 'picture', 'userAvatar', 'photo'];
const LEGACY_COVER_KEYS = ['coverPhoto', 'coverImage', 'coverUrl', 'bannerUrl', 'banner'];

function firstTruthy(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return obj[k];
    }
  }
  return null;
}

/**
 * Normalize any user-like row (Sequelize instance, plain object, raw SQL
 * result, or a partial patch) into the single canonical identity shape.
 * Never throws; missing fields simply come back null/undefined-safe.
 */
function toPublicIdentity(row) {
  if (!row) return null;
  const src = typeof row.toJSON === 'function' ? row.toJSON() : row;

  const firstName = src.firstName || '';
  const lastName = src.lastName || '';
  const computedDisplayName = `${firstName} ${lastName}`.trim();
  const displayName = src.displayName || (computedDisplayName || src.username || null);

  const avatar = firstTruthy(src, LEGACY_AVATAR_KEYS);
  const coverPhoto = firstTruthy(src, LEGACY_COVER_KEYS);

  return {
    id: src.id != null ? src.id : src.userId,
    username: src.username || null,
    displayName,
    avatar: avatar || null,
    coverPhoto: coverPhoto || null,
    bio: src.bio != null ? src.bio : null,
    isVerified: !!src.isVerified,
    isOnline: src.isOnline != null ? !!src.isOnline : src.status === 'online',
    lastSeen: src.lastSeen || null,
    statusMessage: src.statusMessage || src.status || null,
  };
}

/**
 * Given a partial update object coming from Settings (Edit Profile), figure
 * out which canonical identity fields actually changed, so callers can emit
 * targeted events (avatar:update, cover:update, username:update, bio:update)
 * in addition to the general profile:update.
 */
function diffChangedFields(before, updateData) {
  const changed = [];
  if (!updateData) return changed;
  if ('avatar' in updateData) changed.push('avatar');
  if ('coverPhoto' in updateData) changed.push('cover');
  if ('username' in updateData) changed.push('username');
  if ('bio' in updateData) changed.push('bio');
  if ('firstName' in updateData || 'lastName' in updateData || 'displayName' in updateData) changed.push('displayName');
  return changed;
}

module.exports = { toPublicIdentity, diffChangedFields, LEGACY_AVATAR_KEYS, LEGACY_COVER_KEYS };
