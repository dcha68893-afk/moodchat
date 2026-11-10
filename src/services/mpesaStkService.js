'use strict';
/**
 * mpesaStkService.js — the ONE M-Pesa STK service for every NECPRA module.
 *
 * Every module (marketplace, games, airtime, money circles/requests, fundraisers, ...) supplies:
 *    module, txType, reference, description, payer, amount, beneficiaries
 * and this service does the rest, always in the same order:
 *
 *   1. validate + build the customer-facing description (the full text is stored and shown in-app / on receipts);
 *   2. resolve each beneficiary's APPROVED receiving account (refuses if there is none);
 *   3. SAVE the transaction (beneficiary + account snapshot) BEFORE any prompt is sent;
 *   4. send the STK prompt (the only code in the backend that calls Daraja's STK endpoint);
 *   5. on Safaricom's callback: verify amount, mark paid exactly once, and ONLY THEN credit the beneficiary
 *      through the module's settler (idempotent, retried by reconcileCredits() if it ever fails).
 *
 * NOTE ON WORDING: Daraja only lets us send AccountReference (max 12 chars) and TransactionDesc (max 13 chars).
 * The phone's M-Pesa prompt therefore shows a compact label; the FULL description is kept on the transaction,
 * returned to the app (`summary`/`description`) for the confirm screen + receipt, and is what the beneficiary sees.
 */
const crypto = require('crypto');
const { Op } = require('sequelize');

let logger = console;
try { logger = require('../utils/logger'); } catch (_) { /* console fallback */ }

const models = () => require('../models');
const Stk = () => models().StkTransaction;
const Receiving = () => models().ReceivingAccount;
const db = () => models();

class StkError extends Error {
  constructor(message, status = 400, code = 'STK_ERROR', extra = {}) {
    super(message); this.status = status; this.statusCode = status; this.code = code; Object.assign(this, extra);
  }
}

/* ───────────────────────────── helpers ───────────────────────────── */
const r2 = n => Math.round(Number(n) * 100) / 100;
const isProd = () => ['production', 'prod', 'live'].includes(String(process.env.MPESA_ENV || 'sandbox').trim().toLowerCase());
const eatTimestamp = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
const clean = (s, n) => String(s == null ? '' : s).normalize('NFKD').replace(/[^A-Za-z0-9 \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const kes = n => 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });

function normalizePhone(phone) {
  let d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  if (!/^254[17]\d{8}$/.test(d)) throw new StkError('Enter a valid Safaricom M-Pesa number (07XX XXX XXX)', 400, 'BAD_PHONE');
  return d;
}
// 254712345678 / 0712345678 / +254712345678  ->  0712XXXXXX
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const local = d.startsWith('254') ? '0' + d.slice(3) : d;
  return local.length >= 10 ? local.slice(0, 4) + 'X'.repeat(local.length - 4) : local.replace(/\d/g, 'X');
}
function maskAccount(a) {
  if (!a) return null;
  const n = String(a.accountNumber || '');
  return {
    method: a.method, accountName: a.accountName || null, bankName: a.bankName || null, approved: a.approved !== false,
    accountNumber: n ? (a.method === 'mpesa_phone' ? maskPhone(n) : n.length > 4 ? '•'.repeat(n.length - 4) + n.slice(-4) : n) : null,
  };
}

/* ─────────────── customer-facing descriptions (one wording per activity) ─────────────── */
const text = {
  marketplaceOrder(orders) {
    const tag = o => '#' + String(o.invoiceNumber || o.id || '').replace(/^#/, '').replace(/-/g, '').slice(0, 8).toUpperCase();
    const list = (orders || []).map(tag);
    if (list.length <= 1) return `NECPRA Marketplace – Order ${list[0] || ''}`.trim();
    if (list.length <= 3) return `NECPRA Marketplace – Orders ${list.join(', ')}`;
    return `NECPRA Marketplace – ${list.length} Orders`;
  },
  gameCoins: coins => `NECPRA Game Coins – ${Number(coins).toLocaleString('en-KE')} Coins`,
  airtime: (phone, kind) => `NECPRA ${kind === 'data' ? 'Mobile Data' : 'Airtime'} – ${maskPhone(phone)}`,
  circleContribution: name => `${String(name || 'Chama').trim()} – Contribution`,
  fundraiser: name => { const n = String(name || 'Fundraiser').trim(); return /fundrais/i.test(n) ? `${n} Contribution` : `${n} Fundraiser Contribution`; },
  paymentTo: name => `Payment to ${String(name || 'recipient').trim()}`,
};

const SHORT_DESC = { order: 'NECPRA Order', game_coins: 'Game Coins', airtime: 'Airtime', data: 'Mobile Data',
  circle_contribution: 'Contribution', payment_request: 'Payment', fundraiser_contribution: 'Fundraiser', wallet_topup: 'Wallet Top-up' };

/* ───────────────────────────── Daraja (the ONLY STK caller) ───────────────────────────── */
let _tok = { v: null, exp: 0, key: '' };
async function accessToken(base, key, secret) {
  const ck = base + '|' + key;
  if (_tok.v && _tok.key === ck && Date.now() < _tok.exp) return _tok.v;
  const r = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64') },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    logger.error('[stk] OAuth failed: ' + r.status + ' ' + JSON.stringify(j));
    throw new StkError('M-Pesa could not be reached (authorisation failed). Please try again shortly.', 502, 'MPESA_AUTH');
  }
  _tok = { v: j.access_token, exp: Date.now() + 50 * 60 * 1000, key: ck };
  return j.access_token;
}

function darajaSettings(profile) {
  const prod = isProd();
  const game = profile === 'game';
  const shortcode = (game ? (process.env.MPESA_GAME_SHORTCODE || process.env.MPESA_SHORTCODE) : (process.env.MPESA_SHORTCODE || process.env.MPESA_GAME_SHORTCODE)) || (prod ? '' : '174379');
  const passkey = (game ? (process.env.MPESA_GAME_PASSKEY || process.env.MPESA_PASSKEY) : (process.env.MPESA_PASSKEY || process.env.MPESA_GAME_PASSKEY)) ||
    (prod ? '' : 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919');
  return {
    prod, shortcode, passkey,
    key: process.env.MPESA_CONSUMER_KEY || '', secret: process.env.MPESA_CONSUMER_SECRET || '',
    base: prod ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
    txType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    partyB: process.env.MPESA_PARTY_B || shortcode,
  };
}

// Daraja PRODUCTION rejects any CallBackURL containing "mpesa"/"safaricom", so the shared path is neutral.
function callbackUrl(req) {
  if (process.env.STK_CALLBACK_URL) return process.env.STK_CALLBACK_URL;
  const backend = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '';
  if (backend) return backend.replace(/\/$/, '') + '/api/stk/pay-callback';
  if (req && (req.headers || req.get)) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || (req.get && req.get('host'));
    if (host) return `${proto}://${host}/api/stk/pay-callback`;
  }
  return '';
}

/**
 * Low-level: send ONE STK prompt. Every legacy helper (marketplace wallet top-up included) delegates here.
 * Returns Daraja's JSON ({ CheckoutRequestID, MerchantRequestID, ResponseCode, CustomerMessage, sandbox? }).
 */
async function sendStkPush({ phone, amount, accountReference, transactionDesc, callbackUrl: cb, profile = 'main' }) {
  const s = darajaSettings(profile);
  const missing = [!s.key && 'MPESA_CONSUMER_KEY', !s.secret && 'MPESA_CONSUMER_SECRET', !s.shortcode && 'MPESA_SHORTCODE', !s.passkey && 'MPESA_PASSKEY'].filter(Boolean);
  if (missing.length) {
    if (!s.prod && process.env.MPESA_ALLOW_MOCK === 'true') {
      logger.warn('[stk] M-Pesa env vars not set — MPESA_ALLOW_MOCK=true, returning mock response');
      return { CheckoutRequestID: 'MOCK-' + Date.now(), MerchantRequestID: 'MOCK', ResponseCode: '0', mock: true, sandbox: true };
    }
    logger.error('[stk] M-Pesa not configured, missing env: ' + missing.join(', '));
    throw new StkError('M-Pesa payment is temporarily unavailable. Please try again later.', 503, 'MPESA_NOT_CONFIGURED', s.prod ? {} : { missing });
  }
  if (!cb) throw new StkError('Payment callback URL is not configured (set BACKEND_URL).', 500, 'NO_CALLBACK_URL');
  if (/mpesa|safaricom/i.test(cb)) logger.warn('[stk] CallBackURL contains a word Daraja production rejects: ' + cb);

  const p = normalizePhone(phone);
  const token = await accessToken(s.base, s.key, s.secret);
  const timestamp = eatTimestamp();
  const password = Buffer.from(`${s.shortcode}${s.passkey}${timestamp}`).toString('base64');
  const r = await fetch(`${s.base}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: s.shortcode, Password: password, Timestamp: timestamp, TransactionType: s.txType,
      Amount: Math.ceil(amount), PartyA: p, PartyB: s.partyB, PhoneNumber: p, CallBackURL: cb,
      AccountReference: clean(accountReference || 'NECPRA', 12) || 'NECPRA',
      TransactionDesc: clean(transactionDesc || 'Payment', 13) || 'Payment',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.ResponseCode !== undefined && String(j.ResponseCode) !== '0')) {
    logger.error('[stk] STK rejected: ' + r.status + ' ' + JSON.stringify(j));
    throw new StkError(j.errorMessage || j.ResponseDescription || 'M-Pesa STK request was rejected by the payment provider.', 502, 'MPESA_REJECTED', { provider: j });
  }
  if (!s.prod) {
    j.sandbox = true;
    logger.warn('[stk] STK sent to the Daraja SANDBOX (MPESA_ENV=' + (process.env.MPESA_ENV || '(unset)') + '): no real prompt reaches a phone.');
  }
  return j;
}

/* ───────────────────── beneficiaries → approved receiving accounts ───────────────────── */
const enforceAccounts = () => String(process.env.STK_ENFORCE_RECEIVING_ACCOUNT || 'true').toLowerCase() !== 'false';

async function approvedAccountFor(ownerType, ownerId) {
  const RA = Receiving();
  if (!RA) return null;
  const row = await RA.findOne({ where: { ownerType, ownerId: String(ownerId), status: 'approved' }, order: [['approvedAt', 'DESC']] });
  return row ? { id: row.id, method: row.method, accountNumber: row.accountNumber, accountReference: row.accountReference, accountName: row.accountName, bankName: row.bankName, approved: true } : null;
}

async function resolveBeneficiary(b) {
  const type = String(b && b.type || '').toLowerCase();
  const m = db();
  if (type === 'platform') return { type, id: 'necpra', name: b.name || 'NECPRA', account: { method: 'platform', accountName: 'NECPRA', approved: true } };
  if (!b.id && b.id !== 0) throw new StkError('Payment beneficiary is missing.', 400, 'NO_BENEFICIARY');

  if (type === 'user') {
    const User = m.User || m.Users;
    const u = User ? await User.findByPk(b.id) : null;
    if (!u) throw new StkError('The recipient account could not be found.', 404, 'BENEFICIARY_NOT_FOUND');
    if (u.isActive === false) throw new StkError('The recipient account is not active.', 409, 'BENEFICIARY_INACTIVE');
    const name = b.name || u.displayName || u.username || 'NECPRA user';
    // Approved external account if they registered one, otherwise their NECPRA wallet (always a NECPRA-controlled account).
    const acct = (await approvedAccountFor('user', b.id)) || { method: 'wallet', accountName: name, approved: true };
    return { type, id: String(b.id), name, account: acct };
  }

  if (type === 'seller') {
    const SP = m.SellerProfile;
    const sp = SP ? await SP.findOne({ where: { userId: b.id } }) : null;
    const ok = sp && (sp.kycStatus === 'approved' || sp.verified === true);
    if (!ok) throw new StkError('This seller has not been approved to receive payments yet.', 409, 'BENEFICIARY_NOT_APPROVED');
    const acctNo = sp.phone || sp.bankAccount;
    if (!acctNo) throw new StkError('This seller has no payout account on file.', 409, 'BENEFICIARY_NO_ACCOUNT');
    return { type, id: String(b.id), name: b.name || sp.businessName, account: {
      method: sp.phone ? 'mpesa_phone' : 'bank', accountNumber: acctNo, accountName: sp.businessName, bankName: sp.phone ? null : sp.bankName, approved: true } };
  }

  if (type === 'circle' || type === 'fundraiser') {
    const acct = await approvedAccountFor(type, b.id);
    if (acct) return { type, id: String(b.id), name: b.name || acct.accountName, account: acct };
    if (enforceAccounts()) {
      throw new StkError(`${type === 'circle' ? 'This group' : 'This fundraiser'} has no approved receiving account yet, so payments are paused. The organiser can add one for approval.`, 409, 'BENEFICIARY_NOT_APPROVED');
    }
    // Staged-rollout escape hatch (STK_ENFORCE_RECEIVING_ACCOUNT=false): money is tracked and held by NECPRA.
    return { type, id: String(b.id), name: b.name || 'NECPRA group', account: { method: 'platform_hold', accountName: 'NECPRA (held)', approved: false } };
  }
  throw new StkError('Unsupported beneficiary type: ' + type, 400, 'BAD_BENEFICIARY');
}

/* ───────────────────────────── module registry (settlers) ───────────────────────────── */
const registry = new Map();
function registerModule(name, handlers) { registry.set(String(name), handlers); }
function ensureModulesLoaded() {
  // Settlers register themselves when their module file loads; load them lazily in case a callback arrives first.
  for (const f of ['../routes/money', '../routes/games', '../routes/airtime', '../controllers/marketplace.controller']) {
    try { require(f); } catch (e) { logger.warn('[stk] could not load settler module ' + f + ': ' + e.message); }
  }
}

async function creditUserWallet(tx, userId, amount, idx = 0) {
  const wallet = require('./walletService');
  return wallet.creditByReference({
    userId, amount: r2(amount), kind: 'stk_received', reference: `STK-${tx.id}-${idx}`,
    description: tx.description, metadata: { stkTransactionId: tx.id, mpesaReceipt: tx.mpesaReceipt, module: tx.module, payerUserId: tx.payerUserId },
  });
}

async function settle(tx) {
  if (tx.status !== 'paid') return;
  if (!registry.has(tx.module)) ensureModulesLoaded();
  const mod = registry.get(tx.module);
  if (!mod || typeof mod.onPaid !== 'function') {
    await tx.update({ creditStatus: 'pending', creditError: ('No settler registered for module ' + tx.module).slice(0, 255) });
    logger.error('[stk] no settler for module ' + tx.module + ' (tx ' + tx.id + ')');
    return;
  }
  try {
    const out = await mod.onPaid(tx, { creditUserWallet, models: db(), logger, r2 });
    await tx.update({ creditStatus: out && out.notApplicable ? 'not_applicable' : 'credited', creditedAt: new Date(), creditError: null });
  } catch (e) {
    logger.error('[stk] settle failed for tx ' + tx.id + ': ' + (e.stack || e.message));
    await tx.update({ creditStatus: 'failed', creditError: String(e.message || e).slice(0, 255) }).catch(() => {});
  }
}

// Retry credits for payments that were confirmed but whose beneficiary credit failed / never ran. Settlers are idempotent.
async function reconcileCredits({ limit = 20 } = {}) {
  const S = Stk();
  if (!S) return 0;
  const rows = await S.findAll({
    where: {
      status: 'paid', creditStatus: { [Op.in]: ['pending', 'failed'] }, paidAt: { [Op.lt]: new Date(Date.now() - 60 * 1000) },
      // 'MANUAL:' errors (e.g. money received for a cancelled order) need a human; never auto-retry them
      [Op.or]: [{ creditError: null }, { creditError: { [Op.notLike]: 'MANUAL:%' } }],
    },
    order: [['paidAt', 'ASC']], limit,
  });
  for (const tx of rows) await settle(tx);
  return rows.length;
}
let _timer = null;
function startReconciler() {
  if (_timer || process.env.STK_RECONCILE_MS === '0') return;
  _timer = setInterval(() => reconcileCredits().catch(e => logger.warn('[stk] reconcile: ' + e.message)), Number(process.env.STK_RECONCILE_MS) || 120000);
  if (_timer.unref) _timer.unref();
}

/* ───────────────────────────── public API ───────────────────────────── */
function publicView(tx) {
  const t = tx.toJSON ? tx.toJSON() : tx;
  const multi = t.beneficiaryType === 'multiple';
  return {
    id: t.id, module: t.module, txType: t.txType, reference: t.reference,
    description: t.description, amount: Number(t.amount), currency: t.currency || 'KES',
    summary: `Pay ${kes(t.amount)} — ${t.description}`,
    status: t.status, creditStatus: t.creditStatus, resultDesc: t.resultDesc || null,
    receipt: t.mpesaReceipt || null, paidAt: t.paidAt || null, checkoutRequestId: t.checkoutRequestId || null,
    beneficiary: multi
      ? { type: 'multiple', name: t.beneficiaryName, allocations: (t.allocations || []).map(a => ({ type: a.type, name: a.name, amount: a.amount })) }
      : { type: t.beneficiaryType, name: t.beneficiaryName, account: maskAccount(t.beneficiaryAccount) },
    shownOnPhoneAs: { reference: t.stkReference, description: t.stkDesc },
  };
}

/**
 * initiate({
 *   req?, module, txType, reference, description,
 *   payer: { userId, phone }, amount,
 *   beneficiaries: [{ type, id, name?, amount?, ref? }],      // platform | user | seller | circle | fundraiser
 *   stkReference?, stkDesc?, payload?, idempotencyKey?, profile?: 'main'|'game'
 * }) -> { transaction, checkoutRequestId, customerMessage, sandbox }
 */
async function initiate(o) {
  const S = Stk();
  if (!S) throw new StkError('Payment ledger is unavailable. Please try again shortly.', 503, 'STK_LEDGER_UNAVAILABLE');
  if (!o.module || !o.txType || !o.reference) throw new StkError('Payment is missing its module, type or reference.', 500, 'STK_BAD_CALL');
  const description = String(o.description || '').trim();
  if (!description) throw new StkError('Payment description is required so the customer knows what they are paying for.', 500, 'STK_NO_DESCRIPTION');
  const amount = Math.ceil(Number(o.amount));
  if (!Number.isFinite(amount) || amount < 1) throw new StkError('Invalid payment amount.', 400, 'BAD_AMOUNT');
  const payerUserId = Number(o.payer && o.payer.userId);
  if (!payerUserId) throw new StkError('Authentication required.', 401, 'NO_PAYER');
  const phone = normalizePhone(o.payer.phone);

  // Idempotency / duplicate-prompt guard
  if (o.idempotencyKey) {
    const dup = await S.findOne({ where: { payerUserId, idempotencyKey: String(o.idempotencyKey).slice(0, 120) } });
    if (dup) return { transaction: publicView(dup), checkoutRequestId: dup.checkoutRequestId, customerMessage: 'This payment was already requested.', idempotent: true };
  }
  const inflight = await S.findOne({ where: { payerUserId, module: o.module, reference: String(o.reference), status: { [Op.in]: ['created', 'prompt_sent'] }, createdAt: { [Op.gt]: new Date(Date.now() - 90 * 1000) } } });
  if (inflight) throw new StkError('A payment prompt for this is already on your phone. Complete it, or wait a minute and try again.', 409, 'STK_IN_FLIGHT');

  // Resolve beneficiaries + approved receiving accounts BEFORE anything is sent
  const specs = Array.isArray(o.beneficiaries) && o.beneficiaries.length ? o.beneficiaries : [{ type: 'platform' }];
  const resolved = [];
  for (const b of specs) resolved.push({ ...(await resolveBeneficiary(b)), amount: b.amount != null ? r2(b.amount) : null, ref: b.ref || null });
  if (resolved.length === 1) resolved[0].amount = amount;
  else {
    const sum = r2(resolved.reduce((n, x) => n + Number(x.amount || 0), 0));
    if (Math.abs(sum - amount) > 1) throw new StkError('Split payment amounts do not add up to the total.', 500, 'STK_BAD_SPLIT');
  }
  const single = resolved.length === 1;
  const stkReference = clean(o.stkReference || String(o.reference).replace(/-/g, '').toUpperCase(), 12) || 'NECPRA';
  const stkDesc = clean(o.stkDesc || SHORT_DESC[o.txType] || description.replace(/^NECPRA\s+/i, ''), 13) || 'Payment';

  // 1) SAVE the transaction (with beneficiary) first
  const tx = await S.create({
    module: o.module, txType: o.txType, reference: String(o.reference).slice(0, 80), description: description.slice(0, 255),
    stkReference, stkDesc, payerUserId, payerPhone: phone, amount, currency: 'KES',
    beneficiaryType: single ? resolved[0].type : 'multiple',
    beneficiaryId: single ? resolved[0].id : null,
    beneficiaryName: single ? resolved[0].name : `${resolved.length} sellers`,
    beneficiaryAccount: single ? resolved[0].account : {},
    allocations: resolved.map(x => ({ type: x.type, id: x.id, name: x.name, amount: x.amount, ref: x.ref, account: x.account })),
    payload: o.payload || {}, status: 'created',
    creditStatus: 'pending',
    idempotencyKey: o.idempotencyKey ? String(o.idempotencyKey).slice(0, 120) : null,
  });

  // 2) send the prompt
  let res;
  try {
    res = await sendStkPush({ phone, amount, accountReference: stkReference, transactionDesc: stkDesc, callbackUrl: callbackUrl(o.req), profile: o.profile || 'main' });
  } catch (e) {
    await tx.update({ status: 'failed', resultDesc: String(e.message || 'STK request failed').slice(0, 255), creditStatus: 'not_applicable' }).catch(() => {});
    throw e;
  }
  await tx.update({ checkoutRequestId: res.CheckoutRequestID || null, merchantRequestId: res.MerchantRequestID || null, status: 'prompt_sent' });
  startReconciler();
  return {
    transaction: publicView(tx), checkoutRequestId: res.CheckoutRequestID, merchantRequestId: res.MerchantRequestID,
    customerMessage: `Check your phone and enter your M-Pesa PIN to pay ${kes(amount)} for ${description}.`,
    sandbox: !!res.sandbox,
  };
}

/** Safaricom STK callback. Always answerable with ResultCode 0 — never throws. */
async function handleCallback(rawBody) {
  const S = Stk();
  const cb = (rawBody && rawBody.Body && rawBody.Body.stkCallback) || rawBody || {};
  const checkoutId = cb.CheckoutRequestID;
  if (!S || !checkoutId) return { matched: false };
  const tx = await S.findOne({ where: { checkoutRequestId: String(checkoutId) } });
  if (!tx) return { matched: false };

  const code = Number(cb.ResultCode ?? cb.result_code);
  const desc = String(cb.ResultDesc || cb.result_desc || '').slice(0, 255);
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const item = n => { const x = items.find(i => i.Name === n); return x ? x.Value : undefined; };
  const open = ['created', 'prompt_sent', 'expired'];

  if (code === 0) {
    const receipt = item('MpesaReceiptNumber');
    const paid = item('Amount') != null ? Number(item('Amount')) : null;
    const amountOk = paid == null || Math.abs(paid - Number(tx.amount)) <= 0.5;
    const [n] = await S.update({
      status: amountOk ? 'paid' : 'amount_mismatch', resultCode: 0, resultDesc: desc, mpesaReceipt: receipt ? String(receipt).slice(0, 40) : null,
      paidAmount: paid, paidAt: new Date(), creditStatus: amountOk ? 'pending' : 'failed', creditError: amountOk ? null : 'Paid amount does not match the amount requested',
    }, { where: { id: tx.id, status: { [Op.in]: open } } });
    if (!n) return { matched: true, duplicate: true };
    if (!amountOk) { logger.error(`[stk] amount mismatch tx ${tx.id}: expected ${tx.amount}, got ${paid} — NOT credited`); return { matched: true, mismatch: true }; }
    const fresh = await S.findByPk(tx.id);
    await settle(fresh);
    return { matched: true, paid: true };
  }

  const status = code === 1032 ? 'cancelled' : code === 1037 ? 'expired' : 'failed';
  const [n] = await S.update({ status, resultCode: Number.isFinite(code) ? code : null, resultDesc: desc || 'Payment was not completed', creditStatus: 'not_applicable' },
    { where: { id: tx.id, status: { [Op.in]: ['created', 'prompt_sent'] } } });
  if (n) {
    const fresh = await S.findByPk(tx.id);
    const mod = registry.get(tx.module) || (ensureModulesLoaded(), registry.get(tx.module));
    if (mod && typeof mod.onFailed === 'function') { try { await mod.onFailed(fresh, { models: db(), logger }); } catch (e) { logger.error('[stk] onFailed ' + e.message); } }
  }
  return { matched: true, failed: true };
}

const SAFARICOM_IPS = ['196.201.214.200', '196.201.214.206', '196.201.213.100', '196.201.214.207', '196.201.214.208', '196.201.213.101',
  '196.201.212.127', '196.201.212.138', '196.201.212.129', '196.201.212.136', '196.201.212.74', '196.201.212.69'];
async function callbackHandler(req, res) {
  try {
    const chain = [...String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()), req.ip, req.connection && req.connection.remoteAddress]
      .filter(Boolean).map(x => x.replace(/^::ffff:/, ''));
    if (!chain.some(ip => SAFARICOM_IPS.includes(ip))) {
      logger.warn('[stk] callback from non-whitelisted chain: ' + chain.join(' > '));
      if (process.env.NODE_ENV === 'production' && process.env.MPESA_STRICT_IP === 'true') return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    await handleCallback(req.body);
  } catch (e) { logger.error('[stk] callback error: ' + (e.stack || e.message)); }
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

module.exports = {
  StkError, initiate, handleCallback, callbackHandler, sendStkPush, registerModule, publicView, reconcileCredits, startReconciler,
  resolveBeneficiary, approvedAccountFor, creditUserWallet, text, normalizePhone, maskPhone, maskAccount, callbackUrl, clean,
};
