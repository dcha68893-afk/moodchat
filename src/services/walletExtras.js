'use strict';
/**
 * walletExtras.js — read-side helpers + savings goals built ON TOP of walletService.
 * Every balance change still goes through walletService.applyDelta (locked wallet row, ledger row, no negative balance).
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const W = require('./walletService');

const r2 = n => Math.round(Number(n) * 100) / 100;
const uid = v => String(v);
const sequelize = () => {
  const s = require('../models').sequelize;
  if (!s) throw new W.WalletError('Wallet system not available', 503, 'WALLET_UNAVAILABLE');
  return s;
};
const q = (t, sql, replacements = {}, type = QueryTypes.SELECT) => sequelize().query(sql, { replacements, type, transaction: t || undefined });

const CATEGORIES = ['school_fees', 'rent', 'shopping', 'emergency', 'personal'];
// Transfers between NECPRA users are free today (walletService.transfer charges no fee). If you ever add a fee,
// change it HERE and in walletService.transfer together so the quote the user sees is the amount actually charged.
const transferFee = () => Number(process.env.WALLET_TRANSFER_FEE || 0) || 0;

// ── dashboard ───────────────────────────────────────────────────────────────
async function getDashboard(userId) {
  const summary = await W.getSummary(userId);
  const month = await q(null, `
    SELECT
      COALESCE(SUM(CASE WHEN "type"='credit' AND COALESCE("metadata"->>'kind','') NOT IN ('goal_withdraw','withdrawal_reversal') THEN "amount" END),0) AS received,
      COALESCE(SUM(CASE WHEN "type"='debit'  AND COALESCE("metadata"->>'kind','') NOT IN ('goal_deposit') THEN "amount" END),0) AS spent
    FROM "wallet_transactions"
    WHERE "user_id" = :u AND "createdAt" >= date_trunc('month', NOW())
      AND COALESCE("metadata"->>'status','completed') = 'completed'`, { u: uid(userId) });
  const pend = await q(null, `
    SELECT COUNT(*)::int AS n, COALESCE(SUM("amount"),0) AS total FROM "wallet_transactions"
    WHERE "user_id" = :u AND "metadata"->>'kind' = 'topup' AND "metadata"->>'status' = 'pending' AND "createdAt" > NOW() - INTERVAL '30 minutes'`, { u: uid(userId) });
  const goals = await q(null, `SELECT COALESCE(SUM("saved_amount"),0) AS saved, COUNT(*)::int AS n FROM "wallet_savings_goals" WHERE "user_id" = :u AND "status" <> 'closed'`, { u: uid(userId) })
    .catch(() => [{ saved: 0, n: 0 }]);
  const recent = await W.listLedger(userId, { limit: 8 });
  let username = null, displayName = null;
  try {
    const m = require('../models'); const User = m.User || m.Users;
    const u = User && await User.findByPk(userId, { attributes: ['id', 'username', 'displayName'] });
    if (u) { username = u.username || null; displayName = u.displayName || null; }
  } catch (_) {}
  return {
    username, displayName,
    balance: summary.balance, currency: summary.currency, isFrozen: summary.isFrozen,
    pendingWithdrawals: summary.reserved,          // money already taken from the balance, on its way to M-PESA
    pendingDeposits: r2(pend[0].total), pendingDepositCount: pend[0].n,
    pendingTotal: r2(summary.reserved + Number(pend[0].total)),
    receivedThisMonth: r2(month[0].received), spentThisMonth: r2(month[0].spent),
    savedInGoals: r2(goals[0].saved), goalCount: goals[0].n,
    limits: summary.limits, recent,
  };
}

// ── fee / limit quote (shown before the user confirms) ──────────────────────
async function quote(userId, type, amountRaw) {
  const L = W.limits();
  const isW = type === 'withdraw';
  const amount = r2(amountRaw);
  const fee = isW ? r2(L.withdrawFee) : r2(transferFee());
  const min = isW ? L.withdrawMin : L.transferMin, max = isW ? L.withdrawMax : L.transferMax, daily = isW ? L.withdrawDaily : L.transferDaily;
  const used = await q(null, `SELECT COALESCE(SUM("amount"),0) AS total FROM "wallet_transactions"
    WHERE "user_id" = :u AND "type"='debit' AND "metadata"->>'kind' = :k AND "createdAt" > NOW() - INTERVAL '24 hours'`, { u: uid(userId), k: isW ? 'withdrawal' : 'transfer_out' });
  const s = await W.getSummary(userId);
  const dailyUsed = r2(used[0].total), total = r2((amount || 0) + fee), problems = [];
  if (Number.isFinite(amount) && amount > 0) {
    if (amount < min) problems.push(`Minimum is KES ${min.toLocaleString('en-KE')}`);
    if (amount > max) problems.push(`Maximum per ${isW ? 'withdrawal' : 'transfer'} is KES ${max.toLocaleString('en-KE')}`);
    if (dailyUsed + amount > daily) problems.push(`Daily limit of KES ${daily.toLocaleString('en-KE')} would be exceeded`);
    if (total > s.balance) problems.push('Insufficient wallet balance');
  }
  if (s.isFrozen) problems.push('Your wallet is frozen. Contact support.');
  return { type: isW ? 'withdraw' : 'transfer', amount: amount || 0, fee, total, currency: s.currency, available: s.balance,
    min, max, dailyLimit: daily, dailyUsed, dailyRemaining: Math.max(0, r2(daily - dailyUsed)), problems, canProceed: !!(amount > 0) && problems.length === 0 };
}

// ── receipts ────────────────────────────────────────────────────────────────
async function getReceipt(userId, id) {
  const isUuid = /^[0-9a-f-]{32,36}$/i.test(id);
  if (!isUuid) throw new W.WalletError('Receipt not found', 404, 'RECEIPT_NOT_FOUND');
  const tx = await q(null, `SELECT * FROM "wallet_transactions" WHERE "id" = :id AND "user_id" = :u LIMIT 1`, { id, u: uid(userId) });
  if (tx[0]) {
    const r = tx[0], m = r.metadata || {};
    return { id: r.id, kind: m.kind || (r.type === 'credit' ? 'credit' : 'debit'), direction: r.type, status: m.status || 'completed',
      amount: r2(r.amount), fee: r2(m.fee || 0), currency: r.currency || 'KES', description: r.description, counterparty: m.counterparty_name || null,
      note: m.note || null, reference: r.reference, mpesaReceipt: m.mpesa_receipt || null, balanceAfter: r.balance_after == null ? null : r2(r.balance_after), createdAt: r.createdAt };
  }
  const w = await q(null, `SELECT * FROM "wallet_withdrawals" WHERE "id" = :id AND "user_id" = :u LIMIT 1`, { id, u: uid(userId) });
  if (w[0]) {
    const r = w[0];
    return { id: r.id, kind: 'withdrawal', direction: 'debit', status: r.status, amount: r2(r.amount), fee: r2(r.fee || 0), currency: r.currency || 'KES',
      description: `Withdrawal to M-PESA ****${String(r.phone || '').slice(-4)}`, counterparty: null, note: null, reference: r.originator_conversation_id || r.id,
      mpesaReceipt: r.mpesa_receipt || null, failureReason: r.failure_reason || null, balanceAfter: null, createdAt: r.created_at, completedAt: r.completed_at || null };
  }
  throw new W.WalletError('Receipt not found', 404, 'RECEIPT_NOT_FOUND');
}

// ── savings goals ───────────────────────────────────────────────────────────
const pubGoal = g => ({ id: g.id, name: g.name, category: g.category, target: r2(g.target_amount), saved: r2(g.saved_amount),
  dueDate: g.due_date || null, status: g.status, progress: Number(g.target_amount) > 0 ? Math.min(100, Math.round(Number(g.saved_amount) / Number(g.target_amount) * 100)) : 0, createdAt: g.createdAt });

async function listGoals(userId) {
  const rows = await q(null, `SELECT * FROM "wallet_savings_goals" WHERE "user_id" = :u AND "status" <> 'closed' ORDER BY "createdAt" DESC`, { u: uid(userId) });
  return rows.map(pubGoal);
}
async function createGoal(userId, b) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw new W.WalletError('Give your goal a name', 400, 'GOAL_NAME_REQUIRED');
  const category = CATEGORIES.includes(b.category) ? b.category : 'personal';
  const target = r2(b.target);
  if (!Number.isFinite(target) || target <= 0 || target > 10000000) throw new W.WalletError('Enter a valid target amount', 400, 'GOAL_TARGET_INVALID');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate || '')) ? b.dueDate : null;
  const count = await q(null, `SELECT COUNT(*)::int AS n FROM "wallet_savings_goals" WHERE "user_id" = :u AND "status" <> 'closed'`, { u: uid(userId) });
  if (count[0].n >= 20) throw new W.WalletError('You can have up to 20 active goals', 400, 'GOAL_LIMIT');
  const id = crypto.randomUUID();
  const rows = await q(null, `INSERT INTO "wallet_savings_goals" ("id","user_id","name","category","target_amount","saved_amount","due_date","status","createdAt","updatedAt")
    VALUES (:id,:u,:n,:c,:t,0,:d,'active',NOW(),NOW()) RETURNING *`, { id, u: uid(userId), n: name, c: category, t: target, d: due }, QueryTypes.SELECT);
  return pubGoal(rows[0]);
}
async function goalMove(userId, goalId, dir, amountRaw) {
  const amount = r2(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) throw new W.WalletError('Enter a valid amount', 400, 'BAD_AMOUNT');
  return W.tx(async t => {
    const wallet = await W.lockWallet(t, userId);
    if (wallet.is_frozen) throw new W.WalletError('Your wallet is frozen. Please contact support.', 403, 'WALLET_FROZEN');
    const g = (await q(t, `SELECT * FROM "wallet_savings_goals" WHERE "id" = :id AND "user_id" = :u AND "status" <> 'closed' FOR UPDATE`, { id: goalId, u: uid(userId) }))[0];
    if (!g) throw new W.WalletError('Goal not found', 404, 'GOAL_NOT_FOUND');
    const ref = `GOAL-${dir === 'deposit' ? 'DEP' : 'WD'}-${crypto.randomUUID()}`;
    if (dir === 'deposit') {
      await W.applyDelta(t, wallet, { delta: -amount, kind: 'goal_deposit', reference: ref, description: `Saved to ${g.name}`, metadata: { goal_id: g.id, goal_name: g.name } });
      const saved = r2(Number(g.saved_amount) + amount);
      await q(t, `UPDATE "wallet_savings_goals" SET "saved_amount" = :s, "status" = :st, "updatedAt" = NOW() WHERE "id" = :id`,
        { s: saved, st: saved >= Number(g.target_amount) ? 'completed' : 'active', id: g.id }, QueryTypes.RAW);
    } else {
      if (amount > Number(g.saved_amount)) throw new W.WalletError('That is more than you have saved in this goal', 400, 'GOAL_INSUFFICIENT');
      await W.applyDelta(t, wallet, { delta: amount, kind: 'goal_withdraw', reference: ref, description: `Moved from ${g.name}`, metadata: { goal_id: g.id, goal_name: g.name } });
      await q(t, `UPDATE "wallet_savings_goals" SET "saved_amount" = "saved_amount" - :a, "status" = 'active', "updatedAt" = NOW() WHERE "id" = :id`, { a: amount, id: g.id }, QueryTypes.RAW);
    }
    const fresh = (await q(t, `SELECT * FROM "wallet_savings_goals" WHERE "id" = :id`, { id: g.id }))[0];
    return { goal: pubGoal(fresh), balance: r2(wallet.balance) };
  });
}
async function closeGoal(userId, goalId) {
  return W.tx(async t => {
    const wallet = await W.lockWallet(t, userId);
    const g = (await q(t, `SELECT * FROM "wallet_savings_goals" WHERE "id" = :id AND "user_id" = :u AND "status" <> 'closed' FOR UPDATE`, { id: goalId, u: uid(userId) }))[0];
    if (!g) throw new W.WalletError('Goal not found', 404, 'GOAL_NOT_FOUND');
    const back = r2(g.saved_amount);
    if (back > 0) await W.applyDelta(t, wallet, { delta: back, kind: 'goal_withdraw', reference: `GOAL-CLOSE-${g.id}`, description: `Returned from ${g.name}`, metadata: { goal_id: g.id, goal_name: g.name } });
    await q(t, `UPDATE "wallet_savings_goals" SET "saved_amount" = 0, "status" = 'closed', "updatedAt" = NOW() WHERE "id" = :id`, { id: g.id }, QueryTypes.RAW);
    return { returned: back, balance: r2(wallet.balance) };
  });
}

// ── M-PESA setup check (admin only; never returns secrets) ─────────────────
function mpesaDiagnostics() {
  const b2c = require('./darajaB2C');
  const env = String(process.env.MPESA_ENV || '').trim().toLowerCase();
  const live = ['production', 'prod', 'live'].includes(env);
  const shortcode = process.env.MPESA_SHORTCODE || process.env.MPESA_GAME_SHORTCODE || '';
  const txType = process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
  const partyB = process.env.MPESA_PARTY_B || shortcode;
  const issues = [];
  if (!live) issues.push('MPESA_ENV is "' + (env || '(unset)') + '": Safaricom SANDBOX is used, so no real prompt reaches a phone. Set MPESA_ENV=production.');
  if (live && (!shortcode || shortcode === '174379')) issues.push('MPESA_SHORTCODE is missing or is the sandbox code 174379. Use your real Paybill / Store number.');
  if (!process.env.MPESA_PASSKEY && !process.env.MPESA_GAME_PASSKEY && live) issues.push('MPESA_PASSKEY is missing (live passkey from Daraja Go-Live).');
  if (txType === 'CustomerPayBillOnline' && partyB !== shortcode) issues.push('MPESA_PARTY_B differs from MPESA_SHORTCODE but the transaction type is CustomerPayBillOnline. For a Paybill, PartyB must equal the Paybill. This causes "The receiver party information is invalid".');
  if (txType === 'CustomerBuyGoodsOnline' && (!process.env.MPESA_PARTY_B || partyB === shortcode)) issues.push('Till (Buy Goods) needs MPESA_SHORTCODE = Store/Head-office number AND MPESA_PARTY_B = the Till number. Using the same number for both gives "The receiver party information is invalid".');
  if (txType !== 'CustomerPayBillOnline' && txType !== 'CustomerBuyGoodsOnline') issues.push('MPESA_TRANSACTION_TYPE must be CustomerPayBillOnline (Paybill) or CustomerBuyGoodsOnline (Till).');
  if (!(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL)) issues.push('BACKEND_URL is not set: M-PESA cannot call back and deposits never complete.');
  const b2cMissing = b2c.missingConfig();
  if (b2cMissing.length) issues.push('Withdrawals (B2C) need: ' + b2cMissing.join(', ') + '. B2C uses its own shortcode (MPESA_B2C_SHORTCODE) and initiator, not the STK Paybill/Till.');
  return { mode: live ? 'live' : 'sandbox', mpesaEnv: env || '(unset)', stk: { shortcode, transactionType: txType, partyB }, withdrawalsConfigured: b2cMissing.length === 0, issues, ok: issues.length === 0 };
}

module.exports = { mpesaDiagnostics, getDashboard, quote, getReceipt, listGoals, createGoal, goalMove, closeGoal };
