'use strict';

/** Canonical friendship service.
 *
 * Friends is the relationship source of truth for the rest of the backend.
 * Use explicit SQL here so legacy Sequelize attribute-to-column mappings can
 * never turn requester_id/receiver_id into requesterId/receiverId in SQL.
 */
const db = require('../models');

const sequelize = db.sequelize;
const FRIEND_COLUMNS = '"id", "requester_id", "receiver_id", "status", "createdAt", "updatedAt"';

function validId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function pair(userA, userB) {
  const a = validId(userA), b = validId(userB);
  if (!a || !b || a === b) return null;
  return { a, b };
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    requesterId: Number(row.requester_id),
    addresseeId: Number(row.receiver_id),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function getRelationship(userA, userB, options = {}) {
  const p = pair(userA, userB);
  if (!p) return { status: 'none', direction: null, requestId: null };
  if (p.a === p.b) return { status: 'self', direction: null, requestId: null };

  const [rows] = await sequelize.query(
    `SELECT ${FRIEND_COLUMNS}
       FROM "friends"
      WHERE ("requester_id" = :a AND "receiver_id" = :b)
         OR ("requester_id" = :b AND "receiver_id" = :a)
      ORDER BY "updatedAt" DESC, "id" DESC
      LIMIT 1`,
    { replacements: p, transaction: options.transaction }
  );
  const row = mapRow(rows[0]);
  if (!row) return { status: 'none', direction: null, requestId: null };
  if (row.status === 'accepted') return { status: 'accepted', direction: null, requestId: row.id };
  return {
    status: row.status === 'rejected' ? 'rejected' : row.status,
    direction: row.requesterId === p.a ? 'outgoing' : 'incoming',
    requestId: row.id
  };
}

async function areFriends(userA, userB, options = {}) {
  const p = pair(userA, userB);
  if (!p) return false;
  const [rows] = await sequelize.query(
    `SELECT 1
       FROM "friends"
      WHERE "status" = 'accepted'
        AND (("requester_id" = :a AND "receiver_id" = :b)
          OR ("requester_id" = :b AND "receiver_id" = :a))
      LIMIT 1`,
    { replacements: p, transaction: options.transaction }
  );
  return rows.length > 0;
}

/** Return whether either side of a friendship pair has blocked the other. */
async function isBlocked(userA, userB, options = {}) {
  const p = pair(userA, userB);
  if (!p) return false;
  try {
    const [rows] = await sequelize.query(
      `SELECT 1
         FROM "friends"
        WHERE (("requester_id" = :a AND "receiver_id" = :b)
            OR ("requester_id" = :b AND "receiver_id" = :a))
          AND "blocked_at" IS NOT NULL
        LIMIT 1`,
      { replacements: p, transaction: options.transaction }
    );
    return rows.length > 0;
  } catch (error) {
    if (/blocked_at|column .* does not exist/i.test(error?.message || '')) return false;
    throw error;
  }
}

async function getFriendIds(userId, options = {}) {
  const id = validId(userId);
  if (!id) return [];
  const [rows] = await sequelize.query(
    `SELECT "requester_id", "receiver_id"
       FROM "friends"
      WHERE "status" = 'accepted'
        AND ("requester_id" = :id OR "receiver_id" = :id)`,
    { replacements: { id }, transaction: options.transaction }
  );
  return rows
    .map(row => Number(row.requester_id) === id ? Number(row.receiver_id) : Number(row.requester_id))
    .filter(n => Number.isInteger(n) && n > 0);
}

async function getPendingRequestIds(userId, options = {}) {
  const id = validId(userId);
  if (!id) return { incoming: [], outgoing: [] };
  const [rows] = await sequelize.query(
    `SELECT "id", "requester_id", "receiver_id"
       FROM "friends"
      WHERE "status" = 'pending'
        AND ("receiver_id" = :id OR "requester_id" = :id)
      ORDER BY "createdAt" DESC, "id" DESC`,
    { replacements: { id }, transaction: options.transaction }
  );
  const incoming = [], outgoing = [];
  for (const row of rows) {
    const item = { requestId: Number(row.id), userId: Number(row.requester_id) };
    if (Number(row.receiver_id) === id) incoming.push(item);
    else outgoing.push({ requestId: Number(row.id), userId: Number(row.receiver_id) });
  }
  return { incoming, outgoing };
}

module.exports = { areFriends, getRelationship, getFriendIds, getPendingRequestIds, isBlocked, validId, pair };
