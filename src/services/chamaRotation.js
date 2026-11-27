'use strict';
/**
 * Chama rotation ("merry-go-round"): who receives the pot now, who is next, and who has already received.
 *
 * Stored in circle.settings.rotation (JSONB, no schema change):
 *   { order: [userId, ...], payouts: [{ id, userId, amount, paidAt, round, note, recordedBy }] }
 *
 * Money separation (same rule as dukaChama.js): this module never moves money and never changes the circle's
 * collected balance. A payout is a RECORD made by the circle owner after they have paid the member through the
 * Money module or in person. It is shown to members as "recorded by the owner", not as verified by NECPRA.
 */
const crypto = require('crypto');

const cents = (x) => Math.round(Number(x || 0) * 100);
const fromCents = (c) => c / 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function raw(circle) {
  const r = circle && circle.settings && circle.settings.rotation;
  const order = Array.isArray(r && r.order) ? r.order.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  const payouts = Array.isArray(r && r.payouts) ? r.payouts.filter((p) => p && Number(p.userId) > 0) : [];
  return { order: [...new Set(order)], payouts };
}

/** Total already recorded as paid out to members. */
function paidOutTotal(payouts) {
  return fromCents(payouts.reduce((n, p) => n + cents(p.amount), 0));
}

/**
 * Pure state calculation. `activeIds` is the set of user ids that are still active members.
 * Members who left are skipped; members not yet in the order are reported so the owner can place them.
 */
function compute(circle, activeIds, names) {
  const { order, payouts } = raw(circle);
  const active = new Set([...activeIds].map(Number));
  const queue = order.filter((u) => active.has(u));
  const unordered = [...active].filter((u) => !order.includes(u));
  const round = payouts.reduce((m, p) => Math.max(m, Number(p.round) || 1), 1);
  const paidThisRound = new Set(payouts.filter((p) => (Number(p.round) || 1) === round).map((p) => Number(p.userId)));
  let pending = queue.filter((u) => !paidThisRound.has(u));
  let currentRound = round;
  if (queue.length && !pending.length) { currentRound = round + 1; pending = queue.slice(); }   // everyone has received: a new round starts
  const nm = (u) => (names && names.get(Number(u))) || ('User ' + u);
  const person = (u) => (u ? { userId: Number(u), name: nm(u) } : null);
  const current = pending[0] || null;
  const next = pending[1] || (pending.length === 1 && queue.length > 1 ? queue.find((u) => u !== pending[0]) : null) || null;
  const doneNow = currentRound === round ? paidThisRound : new Set();   // a fresh round starts with nobody received
  const lastForUser = new Map();
  payouts.forEach((p) => lastForUser.set(Number(p.userId), p));
  const line = queue.map((u, i) => {
    const got = doneNow.has(u);
    return { userId: u, name: nm(u), position: i + 1, status: got ? 'received' : (u === current ? 'current' : 'upcoming'),
      receivedAt: got && lastForUser.get(u) ? lastForUser.get(u).paidAt : null, receivedAmount: got && lastForUser.get(u) ? Number(lastForUser.get(u).amount) : null };
  });
  const history = payouts.slice().sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))
    .map((p) => ({ id: p.id, userId: Number(p.userId), name: nm(p.userId), amount: Number(p.amount), paidAt: p.paidAt, round: Number(p.round) || 1, note: p.note || null,
      label: 'Recorded by the chama owner; not verified by NECPRA' }));
  const collected = Number(circle.collectedAmount || 0);
  const out = paidOutTotal(payouts);
  return {
    enabled: queue.length > 0,
    round: currentRound,
    positions: queue.length,
    receivedThisRound: queue.filter((u) => doneNow.has(u)).length,
    current: person(current),
    next: person(next),
    queue: line,
    history,
    unordered: unordered.map((u) => person(u)),
    pot: { collected, paidOut: out, available: Math.max(0, fromCents(cents(collected) - cents(out))) },
  };
}

async function loadState(d, circle) {
  const rows = await d.MoneyCircleMember.findAll({ where: { circleId: circle.id, status: 'active' }, attributes: ['userId'] });
  const ids = rows.map((r) => Number(r.userId));
  const { order, payouts } = raw(circle);
  const wanted = [...new Set([...ids, ...order, ...payouts.map((p) => Number(p.userId))])];
  const us = d.Users && wanted.length ? await d.Users.findAll({ where: { id: wanted }, attributes: ['id', 'username', 'firstName', 'lastName'] }) : [];
  const names = new Map(us.map((u) => [Number(u.id), [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || ('User ' + u.id)]));
  return { ids, names, state: compute(circle, ids, names) };
}

/** Run fn(circle) with the circle row locked, so two owner devices cannot overwrite each other's rotation. */
async function withLockedCircle(d, circleId, fn) {
  if (d.sequelize && typeof d.sequelize.transaction === 'function') {
    return d.sequelize.transaction(async (t) => {
      const circle = await d.MoneyCircle.findByPk(circleId, { transaction: t, lock: t.LOCK.UPDATE });
      return fn(circle, t);
    });
  }
  return fn(await d.MoneyCircle.findByPk(circleId), undefined);
}

const httpErr = (status, message, code) => Object.assign(new Error(message), { status, errorCode: code });

/** Owner sets the order of receiving. Existing payout history is kept. */
async function setOrder(d, circleId, ownerId, order) {
  if (!Array.isArray(order) || !order.length) throw httpErr(400, 'Choose at least one member for the rotation');
  const ids = order.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n < 1) || new Set(ids).size !== ids.length) throw httpErr(400, 'The rotation order has an invalid or repeated member');
  return withLockedCircle(d, circleId, async (circle, t) => {
    if (!circle || circle.status === 'cancelled') throw httpErr(404, 'Circle not found');
    if (Number(circle.ownerId) !== Number(ownerId)) throw httpErr(403, 'Only the chama owner can set the rotation');
    const members = await d.MoneyCircleMember.findAll({ where: { circleId: circle.id, status: 'active' }, attributes: ['userId'], transaction: t });
    const active = new Set(members.map((m) => Number(m.userId)));
    if (ids.some((u) => !active.has(u))) throw httpErr(400, 'Everyone in the rotation must be an active member of this chama');
    const cur = raw(circle);
    const settings = { ...(circle.settings || {}), rotation: { order: ids, payouts: cur.payouts } };
    circle.settings = settings; circle.changed('settings', true); await circle.save({ transaction: t });
    return circle;
  });
}

/** Owner records that the current recipient has been paid the pot. Advances the queue. Idempotent on payoutId. */
async function recordPayout(d, circleId, ownerId, { payoutId, amount, note }) {
  const id = UUID_RE.test(String(payoutId || '')) ? String(payoutId).toLowerCase() : crypto.randomUUID();
  return withLockedCircle(d, circleId, async (circle, t) => {
    if (!circle || circle.status === 'cancelled') throw httpErr(404, 'Circle not found');
    if (Number(circle.ownerId) !== Number(ownerId)) throw httpErr(403, 'Only the chama owner can record a payout');
    const cur = raw(circle);
    if (cur.payouts.some((p) => p.id === id)) return { circle, replay: true };
    const members = await d.MoneyCircleMember.findAll({ where: { circleId: circle.id, status: 'active' }, attributes: ['userId'], transaction: t });
    const state = compute(circle, members.map((m) => Number(m.userId)), null);
    if (!state.enabled || !state.current) throw httpErr(409, 'Set the rotation order first', 'NO_ROTATION');
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw httpErr(400, 'Enter the amount paid to the member');
    if (cents(amt) > cents(state.pot.available)) throw httpErr(409, 'That is more than the pot has available (KSh ' + state.pot.available.toFixed(2) + ' collected and not yet paid out)', 'EXCEEDS_POT');
    const entry = { id, userId: state.current.userId, amount: fromCents(cents(amt)), paidAt: new Date().toISOString(), round: state.round, note: String(note || '').trim().slice(0, 240) || null, recordedBy: Number(ownerId) };
    const settings = { ...(circle.settings || {}), rotation: { order: cur.order, payouts: [...cur.payouts, entry] } };
    circle.settings = settings; circle.changed('settings', true); await circle.save({ transaction: t });
    return { circle, entry };
  });
}

module.exports = { compute, loadState, setOrder, recordPayout, paidOutTotal, raw };
