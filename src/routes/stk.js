'use strict';
/**
 * routes/stk.js — mounted automatically at /api/stk (behind authenticateToken).
 *
 *   GET  /api/stk/status/:checkoutRequestId   payer (or admin) polls one payment
 *   GET  /api/stk/mine                        my recent payments (with full descriptions)
 *   GET  /api/stk/accounts?ownerType&ownerId  list receiving accounts (owner or admin)
 *   POST /api/stk/accounts                    submit a receiving account for approval (self, or a circle you own)
 *   POST /api/stk/accounts/:id/approve        admin
 *   POST /api/stk/accounts/:id/reject         admin
 *
 * The public Safaricom callback (/api/stk/pay-callback) is exposed as router.payCallback and registered
 * WITHOUT auth in routes/index.js, exactly like the existing money/games/marketplace callbacks.
 */
const express = require('express');
const router = express.Router();
const stk = require('../services/mpesaStkService');
const models = () => require('../models');

const uid = req => Number(req.user && (req.user.id || req.user.userId || req.user.sub) || req.userId);
const isAdmin = req => !!req.user && ['admin', 'superadmin'].includes(String(req.user.role || '').toLowerCase());
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (res.headersSent) return;
  res.status(e.status || e.statusCode || 500).json({ success: false, message: e.message || 'Server error', code: e.code });
});

router.payCallback = stk.callbackHandler;
stk.startReconciler();

router.get('/status/:checkoutRequestId', wrap(async (req, res) => {
  const S = models().StkTransaction;
  const tx = S ? await S.findOne({ where: { checkoutRequestId: String(req.params.checkoutRequestId) } }) : null;
  if (!tx) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (!isAdmin(req) && tx.payerUserId !== uid(req)) return res.status(403).json({ success: false, message: 'Not authorized' });
  // If the payment is confirmed but the credit has not landed yet, try again now (idempotent).
  if (tx.status === 'paid' && ['pending', 'failed'].includes(tx.creditStatus)) { await stk.reconcileCredits({ limit: 5 }).catch(() => {}); await tx.reload(); }
  res.json({ success: true, transaction: stk.publicView(tx) });
}));

router.get('/mine', wrap(async (req, res) => {
  const S = models().StkTransaction;
  const rows = S ? await S.findAll({ where: { payerUserId: uid(req) }, order: [['createdAt', 'DESC']], limit: Math.min(Number(req.query.limit) || 30, 100) }) : [];
  res.json({ success: true, transactions: rows.map(stk.publicView) });
}));

async function canManage(req, ownerType, ownerId) {
  if (isAdmin(req)) return true;
  if (ownerType === 'user') return String(ownerId) === String(uid(req));
  if (ownerType === 'circle') {
    const C = models().MoneyCircle; const c = C ? await C.findByPk(ownerId) : null;
    return !!c && Number(c.ownerId) === uid(req);
  }
  return false; // fundraisers: admin only until a fundraiser module defines its owner
}

router.get('/accounts', wrap(async (req, res) => {
  const RA = models().ReceivingAccount;
  const ownerType = String(req.query.ownerType || 'user'); const ownerId = String(req.query.ownerId || uid(req));
  if (!(await canManage(req, ownerType, ownerId))) return res.status(403).json({ success: false, message: 'Not authorized' });
  const rows = RA ? await RA.findAll({ where: { ownerType, ownerId }, order: [['createdAt', 'DESC']] }) : [];
  res.json({ success: true, accounts: rows.map(r => ({ id: r.id, ownerType: r.ownerType, ownerId: r.ownerId, status: r.status, rejectionReason: r.rejectionReason,
    ...stk.maskAccount({ method: r.method, accountNumber: r.accountNumber, accountName: r.accountName, bankName: r.bankName }) })) });
}));

router.post('/accounts', wrap(async (req, res) => {
  const RA = models().ReceivingAccount;
  if (!RA) return res.status(503).json({ success: false, message: 'Receiving accounts are unavailable' });
  const b = req.body || {};
  const ownerType = String(b.ownerType || 'user'); const ownerId = String(b.ownerId || uid(req));
  if (!['user', 'circle', 'fundraiser'].includes(ownerType)) return res.status(400).json({ success: false, message: 'Invalid owner type' });
  if (!(await canManage(req, ownerType, ownerId))) return res.status(403).json({ success: false, message: 'Not authorized' });
  const method = String(b.method || '');
  if (!['wallet', 'mpesa_phone', 'paybill', 'till', 'bank'].includes(method)) return res.status(400).json({ success: false, message: 'Invalid account method' });
  let accountNumber = String(b.accountNumber || '').replace(/\s/g, '');
  if (method === 'mpesa_phone') accountNumber = stk.normalizePhone(accountNumber);
  if (method !== 'wallet' && !accountNumber) return res.status(400).json({ success: false, message: 'Account number is required' });
  const accountName = String(b.accountName || '').trim();
  if (!accountName) return res.status(400).json({ success: false, message: 'The registered account name is required' });
  const row = await RA.create({ ownerType, ownerId, method, accountNumber: accountNumber || null, accountReference: b.accountReference ? String(b.accountReference).slice(0, 60) : null,
    accountName: accountName.slice(0, 160), bankName: b.bankName ? String(b.bankName).slice(0, 100) : null, status: 'pending', submittedBy: uid(req) });
  res.status(201).json({ success: true, id: row.id, status: 'pending', message: 'Submitted. Payments to this account start once an admin approves it.' });
}));

async function decide(req, res, status) {
  if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin only' });
  const RA = models().ReceivingAccount; const row = RA ? await RA.findByPk(req.params.id) : null;
  if (!row) return res.status(404).json({ success: false, message: 'Account not found' });
  if (status === 'approved') {
    // one approved account per owner: retire the previous one
    await RA.update({ status: 'suspended' }, { where: { ownerType: row.ownerType, ownerId: row.ownerId, status: 'approved' } });
  }
  await row.update({ status, approvedBy: uid(req), approvedAt: status === 'approved' ? new Date() : null,
    rejectionReason: status === 'rejected' ? String((req.body && req.body.reason) || 'Not approved').slice(0, 255) : null });
  res.json({ success: true, id: row.id, status });
}
router.post('/accounts/:id/approve', wrap((req, res) => decide(req, res, 'approved')));
router.post('/accounts/:id/reject', wrap((req, res) => decide(req, res, 'rejected')));

module.exports = router;
