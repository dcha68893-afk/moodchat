'use strict';
/**
 * darajaB2C.js — Safaricom Daraja B2C (BusinessPayment) client for wallet withdrawals.
 *
 * Required env (production):
 *   MPESA_B2C_SHORTCODE            B2C shortcode (PartyA)
 *   MPESA_B2C_INITIATOR_NAME       API operator username
 *   MPESA_B2C_SECURITY_CREDENTIAL  pre-encrypted initiator password (base64), OR
 *   MPESA_B2C_INITIATOR_PASSWORD + MPESA_B2C_CERT (PEM text, or path to the Safaricom .cer/.pem)
 *   BACKEND_URL                    public https URL used for ResultURL / QueueTimeOutURL
 * Optional:
 *   MPESA_B2C_CONSUMER_KEY / MPESA_B2C_CONSUMER_SECRET (fall back to MPESA_CONSUMER_KEY/SECRET)
 *   WALLET_B2C_CALLBACK_SECRET     secret path segment of the callback URLs (derived if unset)
 *   MPESA_ENV=production|sandbox
 */
const crypto = require('crypto');
const fs = require('fs');

const isProd = () => String(process.env.MPESA_ENV || 'sandbox').toLowerCase() === 'production';
const baseUrl = () => (isProd() ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
const cfg = () => ({
  consumerKey: process.env.MPESA_B2C_CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY || '',
  consumerSecret: process.env.MPESA_B2C_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET || '',
  shortcode: process.env.MPESA_B2C_SHORTCODE || '',
  initiator: process.env.MPESA_B2C_INITIATOR_NAME || '',
});

function securityCredential() {
  if (process.env.MPESA_B2C_SECURITY_CREDENTIAL) return process.env.MPESA_B2C_SECURITY_CREDENTIAL;
  const pw = process.env.MPESA_B2C_INITIATOR_PASSWORD;
  let cert = process.env.MPESA_B2C_CERT || '';
  if (!pw || !cert) return '';
  if (!cert.includes('BEGIN')) { try { cert = fs.readFileSync(cert, 'utf8'); } catch (_) { return ''; } }
  try {
    return crypto.publicEncrypt({ key: cert, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(pw)).toString('base64');
  } catch (_) { return ''; }
}

function missingConfig() {
  const c = cfg();
  return [
    !c.consumerKey && 'MPESA_CONSUMER_KEY', !c.consumerSecret && 'MPESA_CONSUMER_SECRET',
    !c.shortcode && 'MPESA_B2C_SHORTCODE', !c.initiator && 'MPESA_B2C_INITIATOR_NAME',
    !securityCredential() && 'MPESA_B2C_SECURITY_CREDENTIAL (or MPESA_B2C_INITIATOR_PASSWORD + MPESA_B2C_CERT)',
    !(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL) && 'BACKEND_URL',
  ].filter(Boolean);
}
const isConfigured = () => missingConfig().length === 0;

// Secret path segment protecting the (unauthenticated) Safaricom result/timeout URLs.
function callbackSecret() {
  if (process.env.WALLET_B2C_CALLBACK_SECRET) return process.env.WALLET_B2C_CALLBACK_SECRET;
  const seed = process.env.MPESA_B2C_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET || process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || '';
  return seed ? crypto.createHmac('sha256', seed).update('wallet-b2c-callback').digest('hex').slice(0, 40) : '';
}
function verifyCallbackSecret(given) {
  const want = callbackSecret();
  if (!want || !given) return false;
  const a = Buffer.from(String(given)); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizePhone(phone) {
  let d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (d.startsWith('00254')) d = d.slice(2);
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^254[17]\d{8}$/.test(d) ? d : null;
}

let _tok = { value: null, exp: 0 };
async function accessToken() {
  if (_tok.value && Date.now() < _tok.exp) return _tok.value;
  const c = cfg();
  const r = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64') },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error('M-Pesa authorisation failed'), { definitive: true });
  _tok = { value: j.access_token, exp: Date.now() + Math.max(60, Number(j.expires_in || 3599) - 120) * 1000 };
  return _tok.value;
}

/**
 * Send a B2C payment. Resolves { accepted:true, conversationId, originatorConversationId } when Safaricom
 * ACCEPTED the request for processing (final outcome arrives on ResultURL). Resolves { accepted:false,
 * definitive:true, message } when it was definitively rejected before any money moved. Throws
 * { ambiguous:true } when the request may or may not have reached Safaricom (never auto-refund on that).
 */
async function sendB2C({ originatorConversationId, phone, amount, remarks, occasion }) {
  if (!isConfigured()) return { accepted: false, definitive: true, message: 'Withdrawals are temporarily unavailable.' };
  const c = cfg();
  const backend = (process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/$/, '');
  const secret = callbackSecret();
  let token;
  try { token = await accessToken(); }
  catch (e) { return { accepted: false, definitive: true, message: 'M-Pesa could not be reached. Try again shortly.' }; }

  let res, json;
  try {
    res = await fetch(`${baseUrl()}/mpesa/b2c/v1/paymentrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        OriginatorConversationID: originatorConversationId,
        InitiatorName: c.initiator,
        SecurityCredential: securityCredential(),
        CommandID: 'BusinessPayment',
        Amount: Math.round(Number(amount)),
        PartyA: c.shortcode,
        PartyB: phone,
        Remarks: String(remarks || 'Wallet withdrawal').slice(0, 100),
        QueueTimeOutURL: `${backend}/api/wallet/b2c/timeout/${secret}`,
        ResultURL: `${backend}/api/wallet/b2c/result/${secret}`,
        Occasion: String(occasion || '').slice(0, 100),
      }),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    throw Object.assign(new Error('M-Pesa request outcome unknown'), { ambiguous: true });
  }
  if (res.ok && String(json.ResponseCode) === '0') {
    return { accepted: true, conversationId: json.ConversationID || null, originatorConversationId: json.OriginatorConversationID || originatorConversationId };
  }
  if (res.status >= 500) throw Object.assign(new Error('M-Pesa request outcome unknown'), { ambiguous: true });
  return { accepted: false, definitive: true, message: json.errorMessage || json.ResponseDescription || 'M-Pesa rejected the withdrawal.', raw: json };
}

/** Normalise a B2C Result callback body. */
function parseResult(body) {
  const r = (body && body.Result) || {};
  const params = {};
  const list = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
  (Array.isArray(list) ? list : [list]).forEach(p => { if (p && p.Key) params[p.Key] = p.Value; });
  return {
    resultCode: r.ResultCode === undefined ? null : Number(r.ResultCode),
    resultDesc: r.ResultDesc || '',
    originatorConversationId: r.OriginatorConversationID || null,
    conversationId: r.ConversationID || null,
    transactionId: r.TransactionID || params.TransactionID || null,
    amount: params.TransactionAmount != null ? Number(params.TransactionAmount) : null,
    params,
  };
}

module.exports = { isConfigured, missingConfig, sendB2C, parseResult, verifyCallbackSecret, normalizePhone };
