'use strict';
/**
 * wallet.js — /api/wallet
 *   GET  /summary                 balance, reserved (pending withdrawals), limits
 *   GET  /lookup?q=               resolve a recipient by username / email / phone (no private data returned)
 *   POST /transfer                send wallet money to another user          (step-up + rate limited)
 *   GET  /ledger                  ledger entries (credits, debits, transfers, withdrawals, reversals)
 *   POST /withdraw                withdraw to M-Pesa via Daraja B2C           (step-up + rate limited)
 *   GET  /withdrawals             withdrawal history
 * Public (Safaricom → server, protected by secret path segment, mounted in routes/index.js):
 *   POST /b2c/result/:secret , POST /b2c/timeout/:secret
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const wallet = require('../services/walletService');
const b2c = require('../services/darajaB2C');

const router = express.Router();
const userId = req => req.user && (req.user.id || req.user.userId);
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  const status = e.status || e.statusCode || 500;
  if (status >= 500) console.error('[wallet]', e.message);
  if (!res.headersSent) res.status(status).json({ success: false, message: status >= 500 && !e.code ? 'Wallet error. Please try again.' : e.message, code: e.code || 'WALLET_ERROR' });
});

// Per-user limiter for the money-moving calls (on top of paymentLimiter's 10/min): 5 per minute, 40 per hour.
const mk = (windowMs, max, name) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `wallet-${name}:${userId(req) || req.ip}`,
  message: { success: false, message: 'Too many wallet requests. Please wait a moment and try again.', code: 'RATE_LIMITED' },
});
const burst = mk(60 * 1000, 5, 'burst');
const hourly = mk(60 * 60 * 1000, 40, 'hour');
const lookupLimiter = mk(60 * 1000, 15, 'lookup');

// Same fresh-password (+OTP) step-up the Money module uses.
function stepUp(req, res, next) {
  try {
    const money = require('./money');
    if (typeof money.requireMoneyStepUp === 'function' && !money.requireMoneyStepUp(req, res, Number(userId(req)))) return;
  } catch (e) { console.error('[wallet] step-up unavailable:', e.message); return res.status(503).json({ success: false, message: 'Security check unavailable', code: 'STEP_UP_UNAVAILABLE' }); }
  next();
}

// ── Safaricom callbacks (no JWT). Always answer 200 so Safaricom stops retrying. ─────────────────────────────
const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };
router.publicB2CResult = async (req, res) => {
  try {
    if (!b2c.verifyCallbackSecret(req.params.secret)) { console.warn('[wallet] B2C result with bad secret'); return res.status(200).json(ACK); }
    const r = b2c.parseResult(req.body);
    if (r.resultCode === null) return res.status(200).json(ACK);
    if (r.resultCode === 0) await wallet.completeWithdrawal({ originatorConversationId: r.originatorConversationId, conversationId: r.conversationId, receipt: r.transactionId, amount: r.amount, resultDesc: r.resultDesc });
    else await wallet.failWithdrawal({ originatorConversationId: r.originatorConversationId, reason: r.resultDesc || 'M-Pesa could not complete the withdrawal', source: 'b2c_result', resultCode: r.resultCode });
  } catch (e) { console.error('[wallet] B2C result handling failed:', e.message); }
  return res.status(200).json(ACK);
};
router.publicB2CTimeout = async (req, res) => {
  try {
    if (!b2c.verifyCallbackSecret(req.params.secret)) return res.status(200).json(ACK);
    const r = b2c.parseResult(req.body);
    // A timeout is NOT a failure: the payout may still succeed. Keep the reservation; the Result callback settles it.
    await wallet.markTimeout({ originatorConversationId: r.originatorConversationId, conversationId: r.conversationId });
  } catch (e) { console.error('[wallet] B2C timeout handling failed:', e.message); }
  return res.status(200).json(ACK);
};

// ── authenticated API ────────────────────────────────────────────────────────────────────────────────────────
router.use(authenticateToken);

router.get('/summary', wrap(async (req, res) => {
  res.json({ success: true, data: await wallet.getSummary(userId(req)) });
}));

router.get('/lookup', lookupLimiter, wrap(async (req, res) => {
  const r = await wallet.findRecipient(req.query.q);
  if (String(r.id) === String(userId(req))) throw new wallet.WalletError('You cannot send money to yourself', 400, 'SELF_TRANSFER');
  res.json({ success: true, data: { id: r.id, username: r.username, displayName: r.displayName } });
}));

router.post('/transfer', paymentLimiter, burst, hourly, stepUp, wrap(async (req, res) => {
  const b = req.body || {};
  const result = await wallet.transfer({ fromUserId: userId(req), recipient: b.recipient || b.to, amount: b.amount, note: b.note, idempotencyKey: b.idempotencyKey || req.get('Idempotency-Key') });
  res.status(result.idempotent ? 200 : 201).json({ success: true, message: 'Transfer sent', data: result });
}));

router.get('/ledger', wrap(async (req, res) => {
  const items = await wallet.listLedger(userId(req), { limit: Number(req.query.limit) || 30, offset: Number(req.query.offset) || 0, kind: req.query.kind || undefined });
  res.json({ success: true, data: { items } });
}));

router.post('/withdraw', paymentLimiter, burst, hourly, stepUp, wrap(async (req, res) => {
  const b = req.body || {};
  const result = await wallet.requestWithdrawal({ userId: userId(req), amount: b.amount, phone: b.phone, idempotencyKey: b.idempotencyKey || req.get('Idempotency-Key') });
  res.status(result.idempotent ? 200 : 202).json({ success: true, message: 'Withdrawal is being processed. You will receive the money on M-Pesa shortly.', data: result });
}));

router.get('/withdrawals', wrap(async (req, res) => {
  const items = await wallet.listWithdrawals(userId(req), { limit: Number(req.query.limit) || 30, offset: Number(req.query.offset) || 0 });
  res.json({ success: true, data: { items } });
}));

module.exports = router;
