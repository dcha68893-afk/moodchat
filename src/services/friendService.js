'use strict';

/**
 * Canonical friendship service.
 * Every module that needs friendship state should use this service.
 * The production table stores the two users as requester_id/receiver_id;
 * there is no userLowId/userHighId pair column.
 */
const { Op } = require('sequelize');
const db = require('../models');

const Friend = db.models?.Friend || db.Friend || db.models?.Friends || db.Friends;

function validId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function pair(userA, userB) {
  const a = validId(userA), b = validId(userB);
  if (!a || !b || a === b) return null;
  return {
    [Op.or]: [
      { requesterId: a, addresseeId: b },
      { requesterId: b, addresseeId: a }
    ]
  };
}

async function getRelationship(userA, userB, options = {}) {
  const a = validId(userA), b = validId(userB);
  if (!a || !b) return { status: 'none', direction: null, requestId: null };
  if (a === b) return { status: 'self', direction: null, requestId: null };
  if (!Friend) throw new Error('Friend model unavailable');

  const row = await Friend.findOne({
    where: pair(a, b),
    attributes: ['id', 'requesterId', 'addresseeId', 'status'],
    transaction: options.transaction
  });
  if (!row) return { status: 'none', direction: null, requestId: null };
  if (row.status === 'accepted') return { status: 'accepted', direction: null, requestId: row.id };
  const incoming = Number(row.addresseeId) === a;
  return {
    status: row.status === 'rejected' ? 'rejected' : row.status,
    direction: incoming ? 'incoming' : 'outgoing',
    requestId: row.id
  };
}

async function areFriends(userA, userB, options = {}) {
  const a = validId(userA), b = validId(userB);
  if (!a || !b || a === b || !Friend) return false;
  const row = await Friend.findOne({
    where: { ...pair(a, b), status: 'accepted' },
    attributes: ['id'],
    transaction: options.transaction
  });
  return Boolean(row);
}

async function getFriendIds(userId, options = {}) {
  const id = validId(userId);
  if (!id || !Friend) return [];
  const rows = await Friend.findAll({
    where: { status: 'accepted', [Op.or]: [{ requesterId: id }, { addresseeId: id }] },
    attributes: ['requesterId', 'addresseeId'],
    transaction: options.transaction,
    raw: true
  });
  return rows.map(row => Number(row.requesterId) === id ? Number(row.addresseeId) : Number(row.requesterId)).filter(n => Number.isInteger(n) && n > 0);
}

async function getPendingRequestIds(userId, options = {}) {
  const id = validId(userId);
  if (!id || !Friend) return { incoming: [], outgoing: [] };
  const [incoming, outgoing] = await Promise.all([
    Friend.findAll({ where: { addresseeId: id, status: 'pending' }, attributes: ['id', 'requesterId'], transaction: options.transaction, raw: true }),
    Friend.findAll({ where: { requesterId: id, status: 'pending' }, attributes: ['id', 'addresseeId'], transaction: options.transaction, raw: true })
  ]);
  return {
    incoming: incoming.map(r => ({ requestId: Number(r.id), userId: Number(r.requesterId) })),
    outgoing: outgoing.map(r => ({ requestId: Number(r.id), userId: Number(r.addresseeId) }))
  };
}

module.exports = { areFriends, getRelationship, getFriendIds, getPendingRequestIds, validId, pair };
