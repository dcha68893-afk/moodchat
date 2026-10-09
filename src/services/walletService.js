'use strict';
/**
 * walletService.js — the ONE place wallet balances change.
 *
 * Guarantees
 *  - every balance change runs inside a DB transaction with the wallet row locked (SELECT … FOR UPDATE);
 *  - the balance UPDATE itself is atomic and refuses to go negative (balance + delta >= 0);
 *  - every change writes a wallet_transactions ledger row with balance_before/after, a `kind`, a unique
 *    reference and structured metadata (partial unique index makes replays impossible);
 *  - transfers lock both wallets in a fixed order (no deadlocks);
 *  - withdrawals RESERVE (debit) the funds up front, and a failed withdrawal restores them exactly once.
 */
const crypto = require('crypto');
const { QueryTypes, Op } = require('sequelize');
const b2c = require('./darajaB2C');

const r2 = n => Math.round(Number(n) * 100) / 100;
const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const limits = () => ({
  transferMin: env('WALLET_TRANSFER_MIN', 1),
  transferMax: env('WALLET_TRANSFER_MAX', 150000),
  transferDaily: env('WALLET_TRANSFER_DAILY_MAX', 300000),
  withdrawMin: env('WALLET_WITHDRAW_MIN', 10),
  withdrawMax: env('WALLET_WITHDRAW_MAX', 150000),
  withdrawDaily: env('WALLET_WITHDRAW_DAILY_MAX', 300000),
  withdrawFee: Number(process.env.WALLET_WITHDRAW_FEE || 0) || 0,
});

class WalletError extends Error {
  constructor(message, status = 400, code = 'WALLET_ERROR', extra = {}) { super(message); this.status = status; this.statusCode = status; this.code = code; Object.assign(this, extra); }
}

const models = () => require('../models');
const sequelize = () => {
  const m = models();
  const s = m.sequelize;
  if (!s) throw new WalletError('Wallet system not available', 503, 'WALLET_UNAVAILABLE');
  return s;
};
const uid = v => String(v); // quoted literal: works for integer AND uuid user_id columns

async function q(t, sql, replacements = {}, type = QueryTypes.SELECT) {
  return sequelize().query(sql, { replacements, type, transaction: t || undefined });
}
const tx = fn => sequelize().transaction(fn);

// ── wallet row access ───────────────────────────────────────────────────────
async function lockWallet(t, userId) {
  await q(t, `INSERT INTO "wallets" ("user_id","balance","currency","is_frozen","metadata","createdAt","updatedAt")
              VALUES (:u, 0, 'KES', false, '{}', NOW(), NOW()) ON CONFLICT ("user_id") DO NOTHING`, { u: uid(userId) }, QueryTypes.RAW);
  const rows = await q(t, `SELECT "id","user_id","balance","currency","is_frozen" FROM "wallets" WHERE "user_id" = :u FOR UPDATE`, { u: uid(userId) });
  if (!rows[0]) throw new WalletError('Wallet not found', 404, 'WALLET_NOT_FOUND');
  return rows[0];
}

/**
 * Apply a signed delta to a locked wallet and write the ledger row. The caller MUST have locked the wallet
 * in the same transaction (lockWallet). Returns { balanceBefore, balanceAfter, ledgerId }.
 */
async function applyDelta(t, wallet, { delta, kind, reference, description, metadata = {}, orderId = null }) {
  delta = r2(delta);
  if (!delta) throw new WalletError('Amount must be non-zero', 400, 'BAD_AMOUNT');
  const upd = await q(t, `UPDATE "wallets" SET "balance" = "balance" + :d, "updatedAt" = NOW()
                          WHERE "id" = :id AND ("balance" + :d) >= 0 RETURNING "balance"`, { d: delta, id: wallet.id });
  if (!upd[0]) throw new WalletError('Insufficient wallet balance', 402, 'INSUFFICIENT_FUNDS');
  const after = r2(upd[0].balance);
  const before = r2(after - delta);
  const id = crypto.randomUUID();
  await q(t, `INSERT INTO "wallet_transactions"
      ("id","wallet_id","user_id","type","amount","currency","balance_after","order_id","reference","description","metadata","createdAt","updatedAt")
      VALUES (:id,:wid,:u,:type,:amt,:cur,:after,:order,:ref,:desc,CAST(:meta AS jsonb),NOW(),NOW())`, {
    id, wid: wallet.id, u: uid(wallet.user_id), type: delta > 0 ? 'credit' : 'debit', amt: Math.abs(delta),
    cur: wallet.currency || 'KES', after, order: orderId, ref: reference || null, desc: description || null,
    meta: JSON.stringify({ kind, status: 'completed', balance_before: before, ...metadata }),
  }, QueryTypes.RAW);
  wallet.balance = after;
  return { balanceBefore: before, balanceAfter: after, ledgerId: id };
}

const assertUsable = (w, who = 'Your') => { if (w.is_frozen) throw new WalletError(`${who} wallet is frozen. Please contact support.`, 403, 'WALLET_FROZEN'); };

// ── recipient resolution ────────────────────────────────────────────────────
function phoneVariants(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const n = b2c.normalizePhone(d);
  if (!n) return [];
  const local = '0' + n.slice(3);
  return [n, '+' + n, local, n.slice(3)];
}
async function findRecipient(identifier) {
  const m = models();
  const User = m.User || m.Users || (m.sequelize && (m.sequelize.models.Users || m.sequelize.models.User));
  if (!User) throw new WalletError('User service unavailable', 503, 'USER_UNAVAILABLE');
  const s = String(identifier || '').trim();
  if (!s) throw new WalletError('Enter a username, email or phone number', 400, 'RECIPIENT_REQUIRED');
  const or = [];
  if (/^[^@\s]+@[^@\s]+$/.test(s)) or.push(sequelize().where(sequelize().fn('lower', sequelize().col('email')), s.toLowerCase()));
  else {
    const pv = phoneVariants(s);
    if (pv.length) or.push({ phone: { [Op.in]: pv } });
    or.push(sequelize().where(sequelize().fn('lower', sequelize().col('username')), s.replace(/^@/, '').toLowerCase()));
  }
  const rows = await User.findAll({ where: { [Op.or]: or }, limit: 2 });
  if (!rows.length) throw new WalletError('No user found with those details', 404, 'RECIPIENT_NOT_FOUND');
  if (rows.length > 1) throw new WalletError('More than one user matches. Use their username.', 409, 'RECIPIENT_AMBIGUOUS');
  const u = rows[0];
  return { id: u.id, username: u.username || u.displayName || `User ${u.id}`, displayName: u.displayName || u.username || null };
}

// ── transfers ───────────────────────────────────────────────────────────────
async function transfer({ fromUserId, recipient, amount, note, idempotencyKey }) {
  const L = limits();
  amount = r2(amount);
  if (!Number.isFinite(amount) || amount < L.transferMin) throw new WalletError(`Minimum transfer is KES ${L.transferMin}`, 400, 'AMOUNT_TOO_LOW');
  if (amount > L.transferMax) throw new WalletError(`Maximum per transfer is KES ${L.transferMax.toLocaleString('en-KE')}`, 400, 'AMOUNT_TOO_HIGH');
  const to = await findRecipient(recipient);
  if (String(to.id) === String(fromUserId)) throw new WalletError('You cannot send money to yourself', 400, 'SELF_TRANSFER');
  const idem = idempotencyKey ? String(idempotencyKey).slice(0, 100) : null;
  const cleanNote = note ? String(note).slice(0, 140) : null;
  // Resolve names BEFORE opening the transaction: a second pool connection inside it can exhaust the pool under load.
  const fromName = await displayName(fromUserId);

  return tx(async t => {
    // Lock both wallets in a fixed order so two opposite transfers can never deadlock.
    const ids = [String(fromUserId), String(to.id)].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
    const locked = {};
    for (const id of ids) locked[id] = await lockWallet(t, id);
    const from = locked[String(fromUserId)], dest = locked[String(to.id)];

    if (idem) {
      const dup = await q(t, `SELECT "id","amount","balance_after","metadata","createdAt" FROM "wallet_transactions"
        WHERE "user_id" = :u AND "metadata"->>'kind' = 'transfer_out' AND "metadata"->>'idempotency_key' = :k LIMIT 1`, { u: uid(fromUserId), k: idem });
      if (dup[0]) return { transferId: dup[0].metadata.transfer_id, amount: r2(dup[0].amount), balance: r2(dup[0].balance_after), recipient: { id: to.id, username: to.username }, createdAt: dup[0].createdAt, idempotent: true };
    }
    assertUsable(from, 'Your'); assertUsable(dest, "The recipient's");

    const today = await q(t, `SELECT COALESCE(SUM("amount"),0) AS total FROM "wallet_transactions"
      WHERE "user_id" = :u AND "type" = 'debit' AND "metadata"->>'kind' = 'transfer_out' AND "createdAt" > NOW() - INTERVAL '24 hours'`, { u: uid(fromUserId) });
    if (r2(today[0].total) + amount > L.transferDaily) throw new WalletError(`Daily transfer limit of KES ${L.transferDaily.toLocaleString('en-KE')} reached`, 429, 'DAILY_LIMIT');

    const transferId = crypto.randomUUID();
    const ref = `TRF-${transferId}`;
    const toName = to.username;
    const out = await applyDelta(t, from, { delta: -amount, kind: 'transfer_out', reference: ref, description: `Sent to ${toName}`,
      metadata: { transfer_id: transferId, counterparty_id: to.id, counterparty_name: toName, note: cleanNote, idempotency_key: idem } });
    await applyDelta(t, dest, { delta: amount, kind: 'transfer_in', reference: ref, description: `Received from ${fromName}`,
      metadata: { transfer_id: transferId, counterparty_id: fromUserId, counterparty_name: fromName, note: cleanNote } });
    return { transferId, amount, balance: out.balanceAfter, recipient: { id: to.id, username: toName }, createdAt: new Date().toISOString(), idempotent: false };
  });
}
async function displayName(userId) {
  try {
    const m = models(); const User = m.User || m.Users;
    const u = await User.findByPk(userId, { attributes: ['id', 'username'] });
    return (u && u.username) || `User ${userId}`;
  } catch (_) { return `User ${userId}`; }
}

// ── withdrawals ─────────────────────────────────────────────────────────────
async function requestWithdrawal({ userId, amount, phone, idempotencyKey }) {
  const L = limits();
  amount = r2(amount);
  if (!Number.isFinite(amount) || amount < L.withdrawMin) throw new WalletError(`Minimum withdrawal is KES ${L.withdrawMin}`, 400, 'AMOUNT_TOO_LOW');
  if (amount > L.withdrawMax) throw new WalletError(`Maximum per withdrawal is KES ${L.withdrawMax.toLocaleString('en-KE')}`, 400, 'AMOUNT_TOO_HIGH');
  const msisdn = b2c.normalizePhone(phone);
  if (!msisdn) throw new WalletError('Enter a valid Safaricom M-Pesa number, e.g. 0712 345 678', 400, 'BAD_PHONE');
  if (!b2c.isConfigured()) {
    console.error('[Wallet] B2C not configured, missing:', b2c.missingConfig().join(', '));
    throw new WalletError('Withdrawals are temporarily unavailable. Please try again later.', 503, 'B2C_NOT_CONFIGURED');
  }
  const idem = idempotencyKey ? String(idempotencyKey).slice(0, 100) : null;
  const total = r2(amount + L.withdrawFee);

  // 1) reserve funds + create the withdrawal row atomically
  const w = await tx(async t => {
    const wallet = await lockWallet(t, userId);
    if (idem) {
      const dup = await q(t, `SELECT * FROM "wallet_withdrawals" WHERE "user_id" = :u AND "idempotency_key" = :k LIMIT 1`, { u: uid(userId), k: idem });
      if (dup[0]) return { row: dup[0], idempotent: true };
    }
    assertUsable(wallet);
    const day = await q(t, `SELECT COALESCE(SUM("amount"),0) AS total FROM "wallet_withdrawals"
      WHERE "user_id" = :u AND "status" IN ('pending','processing','completed') AND "created_at" > NOW() - INTERVAL '24 hours'`, { u: uid(userId) });
    if (r2(day[0].total) + amount > L.withdrawDaily) throw new WalletError(`Daily withdrawal limit of KES ${L.withdrawDaily.toLocaleString('en-KE')} reached`, 429, 'DAILY_LIMIT');
    const inflight = await q(t, `SELECT COUNT(*)::int AS n FROM "wallet_withdrawals" WHERE "user_id" = :u AND "status" IN ('pending','processing')`, { u: uid(userId) });
    if (inflight[0].n >= 3) throw new WalletError('You have withdrawals still processing. Wait for them to finish.', 429, 'TOO_MANY_PENDING');

    const id = crypto.randomUUID();
    const originator = crypto.randomUUID();
    const hold = await applyDelta(t, wallet, { delta: -total, kind: 'withdrawal', reference: `WDR-${id}`, description: 'Withdrawal to M-Pesa (reserved)',
      metadata: { withdrawal_id: id, status: 'pending', phone_last4: msisdn.slice(-4), fee: L.withdrawFee } });
    const ins = await q(t, `INSERT INTO "wallet_withdrawals"
      ("id","user_id","wallet_id","amount","fee","currency","phone","status","originator_conversation_id","idempotency_key","metadata","created_at","updated_at")
      VALUES (:id,:u,:wid,:amt,:fee,:cur,:phone,'pending',:orig,:idem,CAST(:meta AS jsonb),NOW(),NOW()) RETURNING *`, {
      id, u: uid(userId), wid: wallet.id, amt: amount, fee: L.withdrawFee, cur: wallet.currency || 'KES', phone: msisdn, orig: originator, idem,
      meta: JSON.stringify({ ledger_hold_id: hold.ledgerId, balance_after_hold: hold.balanceAfter }),
    });
    return { row: ins[0], idempotent: false, balance: hold.balanceAfter };
  });
  if (w.idempotent) return publicWithdrawal(w.row, { idempotent: true });

  // 2) call Daraja outside the DB transaction
  const row = w.row;
  let sent;
  try {
    sent = await b2c.sendB2C({ originatorConversationId: row.originator_conversation_id, phone: msisdn, amount, remarks: 'Wallet withdrawal', occasion: row.id });
  } catch (e) {
    // Ambiguous: Safaricom may have processed it. Never auto-refund here — the Result callback settles it.
    await q(null, `UPDATE "wallet_withdrawals" SET "status"='processing', "metadata" = "metadata" || CAST(:m AS jsonb), "updated_at"=NOW() WHERE "id"=:id`,
      { id: row.id, m: JSON.stringify({ ambiguous_send: true, ambiguous_at: new Date().toISOString() }) }, QueryTypes.RAW);
    return publicWithdrawal({ ...row, status: 'processing' }, { balance: w.balance });
  }
  if (!sent.accepted) {
    await failWithdrawal({ withdrawalId: row.id, reason: sent.message || 'Withdrawal was rejected', source: 'sync_reject', resultCode: null });
    throw new WalletError(sent.message || 'Withdrawal was rejected. Your balance was not charged.', 502, 'B2C_REJECTED');
  }
  await q(null, `UPDATE "wallet_withdrawals" SET "status"='processing', "conversation_id"=:cid, "updated_at"=NOW() WHERE "id"=:id AND "status"='pending'`,
    { id: row.id, cid: sent.conversationId }, QueryTypes.RAW);
  return publicWithdrawal({ ...row, status: 'processing', conversation_id: sent.conversationId }, { balance: w.balance });
}

/** Mark a withdrawal failed and restore the reserved funds — exactly once, no matter how often it is called. */
async function failWithdrawal({ withdrawalId, originatorConversationId, reason, source, resultCode }) {
  return tx(async t => {
    const rows = withdrawalId
      ? await q(t, `SELECT * FROM "wallet_withdrawals" WHERE "id" = :id FOR UPDATE`, { id: withdrawalId })
      : await q(t, `SELECT * FROM "wallet_withdrawals" WHERE "originator_conversation_id" = :o FOR UPDATE`, { o: originatorConversationId });
    const w = rows[0];
    if (!w) return { found: false };
    if (w.status === 'completed') return { found: true, skipped: 'already_completed' };   // never refund a paid-out withdrawal
    if (w.reversed || w.status === 'failed') return { found: true, skipped: 'already_failed' };
    const wallet = await lockWallet(t, w.user_id);
    const restore = r2(Number(w.amount) + Number(w.fee || 0));
    const back = await applyDelta(t, wallet, { delta: restore, kind: 'withdrawal_reversal', reference: `WDR-REV-${w.id}`,
      description: 'Withdrawal failed — funds returned', metadata: { withdrawal_id: w.id, reason: reason || null, result_code: resultCode, source } });
    await q(t, `UPDATE "wallet_withdrawals" SET "status"='failed', "reversed"=true, "failure_reason"=:r, "result_code"=:c, "updated_at"=NOW() WHERE "id"=:id`,
      { id: w.id, r: String(reason || 'Withdrawal failed').slice(0, 500), c: resultCode == null ? null : String(resultCode) }, QueryTypes.RAW);
    await q(t, `UPDATE "wallet_transactions" SET "metadata" = "metadata" || '{"status":"reversed"}'::jsonb, "updatedAt"=NOW()
                WHERE "wallet_id" = :wid AND "reference" = :ref`, { wid: wallet.id, ref: `WDR-${w.id}` }, QueryTypes.RAW);
    return { found: true, restored: restore, balance: back.balanceAfter, userId: w.user_id };
  });
}

async function completeWithdrawal({ originatorConversationId, conversationId, receipt, amount, resultDesc }) {
  return tx(async t => {
    let rows = originatorConversationId ? await q(t, `SELECT * FROM "wallet_withdrawals" WHERE "originator_conversation_id" = :o FOR UPDATE`, { o: originatorConversationId }) : [];
    if (!rows[0] && conversationId) rows = await q(t, `SELECT * FROM "wallet_withdrawals" WHERE "conversation_id" = :c FOR UPDATE`, { c: conversationId });
    const w = rows[0];
    if (!w) return { found: false };
    if (w.status === 'completed') return { found: true, skipped: 'already_completed' };
    const mismatch = amount != null && Math.abs(Number(amount) - Number(w.amount)) > 0.5;
    // Money has left the till either way: keep the reservation as the final debit, flag any mismatch for review.
    await q(t, `UPDATE "wallet_withdrawals" SET "status"='completed', "mpesa_receipt"=:r, "completed_at"=NOW(), "result_code"='0', "updated_at"=NOW(),
                "metadata" = "metadata" || CAST(:m AS jsonb) WHERE "id"=:id`,
      { id: w.id, r: receipt || null, m: JSON.stringify({ result_desc: resultDesc || null, ...(mismatch ? { amount_mismatch: amount } : {}), was_reversed_before_success: !!w.reversed }) }, QueryTypes.RAW);
    await q(t, `UPDATE "wallet_transactions" SET "metadata" = "metadata" || CAST(:m AS jsonb), "updatedAt"=NOW() WHERE "wallet_id" = :wid AND "reference" = :ref`,
      { wid: w.wallet_id, ref: `WDR-${w.id}`, m: JSON.stringify({ status: 'completed', mpesa_receipt: receipt || null }) }, QueryTypes.RAW);
    return { found: true, completed: true, userId: w.user_id };
  });
}

async function markTimeout({ originatorConversationId, conversationId }) {
  await q(null, `UPDATE "wallet_withdrawals" SET "metadata" = "metadata" || CAST(:m AS jsonb), "updated_at"=NOW()
                 WHERE ("originator_conversation_id" = :o OR "conversation_id" = :c) AND "status" IN ('pending','processing')`,
    { o: originatorConversationId || '', c: conversationId || '', m: JSON.stringify({ timeout_at: new Date().toISOString() }) }, QueryTypes.RAW);
}

// ── reads ───────────────────────────────────────────────────────────────────
function publicWithdrawal(r, extra = {}) {
  return { id: r.id, amount: r2(r.amount), fee: r2(r.fee || 0), currency: r.currency || 'KES', status: r.status, phoneLast4: String(r.phone || '').slice(-4),
    receipt: r.mpesa_receipt || null, failureReason: r.failure_reason || null, createdAt: r.created_at, completedAt: r.completed_at || null, ...extra };
}
async function listWithdrawals(userId, { limit = 30, offset = 0 } = {}) {
  const rows = await q(null, `SELECT * FROM "wallet_withdrawals" WHERE "user_id" = :u ORDER BY "created_at" DESC LIMIT :l OFFSET :o`,
    { u: uid(userId), l: Math.min(100, Math.max(1, limit | 0)), o: Math.max(0, offset | 0) });
  return rows.map(r => publicWithdrawal(r));
}
async function getSummary(userId) {
  const w = await tx(t => lockWallet(t, userId));
  const res = await q(null, `SELECT COALESCE(SUM("amount"+"fee"),0) AS reserved FROM "wallet_withdrawals" WHERE "user_id" = :u AND "status" IN ('pending','processing')`, { u: uid(userId) });
  return { balance: r2(w.balance), reserved: r2(res[0].reserved), currency: w.currency || 'KES', isFrozen: !!w.is_frozen, limits: limits() };
}
async function listLedger(userId, { limit = 30, offset = 0, kind } = {}) {
  const rows = await q(null, `SELECT "id","type","amount","currency","balance_after","reference","description","metadata","createdAt"
    FROM "wallet_transactions" WHERE "user_id" = :u AND NOT ("metadata"->>'kind' = 'topup' AND COALESCE("metadata"->>'status','') <> 'completed')
    ${kind ? `AND "metadata"->>'kind' = :k` : ''} ORDER BY "createdAt" DESC LIMIT :l OFFSET :o`,
    { u: uid(userId), k: kind || null, l: Math.min(100, Math.max(1, limit | 0)), o: Math.max(0, offset | 0) });
  return rows.map(r => ({ id: r.id, type: r.type, amount: r2(r.amount), currency: r.currency, balanceAfter: r.balance_after == null ? null : r2(r.balance_after),
    kind: (r.metadata && r.metadata.kind) || null, status: (r.metadata && r.metadata.status) || 'completed', description: r.description,
    counterparty: (r.metadata && r.metadata.counterparty_name) || null, note: (r.metadata && r.metadata.note) || null, reference: r.reference, createdAt: r.createdAt }));
}

/** Credit a wallet (refunds etc.) idempotently by reference — used by the marketplace refund path. */
async function creditByReference({ userId, amount, kind, reference, description, metadata, orderId }) {
  return tx(async t => {
    const wallet = await lockWallet(t, userId);
    const dup = await q(t, `SELECT "id","balance_after" FROM "wallet_transactions" WHERE "wallet_id" = :w AND "reference" = :r AND "type" = 'credit' LIMIT 1`, { w: wallet.id, r: reference });
    if (dup[0]) return { credited: false, duplicate: true, balance: r2(dup[0].balance_after) };
    const res = await applyDelta(t, wallet, { delta: r2(amount), kind, reference, description, metadata, orderId });
    return { credited: true, balance: res.balanceAfter };
  });
}

module.exports = { WalletError, limits, transfer, findRecipient, requestWithdrawal, failWithdrawal, completeWithdrawal, markTimeout,
  listWithdrawals, listLedger, getSummary, creditByReference, lockWallet, applyDelta, tx };
