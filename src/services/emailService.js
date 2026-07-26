'use strict';
/**
 * emailService.js — Real email notifications via nodemailer
 * Activated when SMTP_HOST + SMTP_USER + SMTP_PASS env vars are set.
 * Falls back to console logging in development / when unconfigured.
 */
const nodemailer = require('nodemailer');

let _transporter = null;

function _getTransporter() {
    if (_transporter) return _transporter;
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
    _transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT || '587'),
        secure: parseInt(SMTP_PORT || '587') === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        tls: { rejectUnauthorized: false },
    });
    return _transporter;
}

const FROM = process.env.EMAIL_FROM || 'Nexopa <noreply@nexopa.com>';

// ── HTML template wrapper ────────────────────────────────────────────────────
function _wrap(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0}
.wrap{max-width:580px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.hdr{background:#f57224;padding:24px 32px;color:#fff;font-size:22px;font-weight:700}
.body{padding:28px 32px;color:#374151;font-size:15px;line-height:1.6}
.btn{display:inline-block;background:#f57224;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0}
.ft{padding:16px 32px;background:#f9fafb;color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6}
.tag{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700}
.green{background:#d1fae5;color:#065f46}.yellow{background:#fef3c7;color:#92400e}
.blue{background:#dbeafe;color:#1e40af}.red{background:#fee2e2;color:#991b1b}
</style></head><body>
<div class="wrap">
<div class="hdr">Nexopa Marketplace</div>
<div class="body"><h2 style="margin-top:0;color:#111">${title}</h2>${body}</div>
<div class="ft">Nexopa · Nairobi, Kenya · You received this because you have an account with us.</div>
</div></body></html>`;
}

// ── send helper ──────────────────────────────────────────────────────────────
async function send(to, subject, html) {
    const t = _getTransporter();
    if (!t) {
        console.log(`[Email] (unconfigured) TO:${to} SUBJ:${subject}`);
        return { queued: false, reason: 'SMTP_NOT_CONFIGURED' };
    }
    try {
        const info = await t.sendMail({ from: FROM, to, subject, html });
        console.log(`[Email] Sent to ${to}: ${info.messageId}`);
        return { queued: true, messageId: info.messageId };
    } catch (e) {
        console.error(`[Email] Failed to ${to}:`, e.message);
        return { queued: false, error: e.message };
    }
}

// ── Order emails ─────────────────────────────────────────────────────────────
async function orderConfirmed(to, { orderId, items = [], total, currency = 'KES', deliveryAddress }) {
    const itemRows = items.map(i =>
        `<tr><td style="padding:6px 0;color:#374151">${i.title || 'Item'} × ${i.quantity || 1}</td>
         <td style="padding:6px 0;text-align:right;font-weight:700">${currency} ${parseFloat((i.price || 0) * (i.quantity || 1)).toFixed(2)}</td></tr>`
    ).join('');
    const addr = deliveryAddress ? `${deliveryAddress.street || ''}, ${deliveryAddress.city || ''}`.replace(/^,\s*|,\s*$/g, '') : '';
    const body = `
        <p>Your order has been placed successfully! 🎉</p>
        <p><strong>Order #</strong> <code>${String(orderId).slice(-9).toUpperCase()}</code></p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0">
            ${itemRows}
            <tr style="border-top:1px solid #f3f4f6">
                <td style="padding:8px 0;font-weight:700">Total</td>
                <td style="padding:8px 0;text-align:right;font-weight:700;color:#f57224">${currency} ${parseFloat(total || 0).toFixed(2)}</td>
            </tr>
        </table>
        ${addr ? `<p><strong>Delivery to:</strong> ${addr}</p>` : ''}
        <p>We'll notify you when your order ships. Thank you for shopping on Nexopa!</p>`;
    return send(to, `Order Confirmed — #${String(orderId).slice(-9).toUpperCase()}`, _wrap('Order Confirmed ✅', body));
}

async function orderShipped(to, { orderId, trackingNumber, estimatedDelivery }) {
    const body = `
        <p>Great news! Your order has been shipped. 🚚</p>
        <p><strong>Order #</strong> <code>${String(orderId).slice(-9).toUpperCase()}</code></p>
        ${trackingNumber ? `<p><strong>Tracking Number:</strong> <code>${trackingNumber}</code></p>` : ''}
        ${estimatedDelivery ? `<p><strong>Estimated Delivery:</strong> ${estimatedDelivery}</p>` : ''}
        <p>Your package is on its way!</p>`;
    return send(to, `Your order has shipped — #${String(orderId).slice(-9).toUpperCase()}`, _wrap('Order Shipped 🚚', body));
}

async function orderDelivered(to, { orderId, productTitle }) {
    const body = `
        <p>Your order has been delivered! 📦</p>
        <p><strong>Order #</strong> <code>${String(orderId).slice(-9).toUpperCase()}</code></p>
        ${productTitle ? `<p><strong>Item:</strong> ${productTitle}</p>` : ''}
        <p>Enjoying your purchase? Leave a review to help other shoppers!</p>`;
    return send(to, `Delivered — #${String(orderId).slice(-9).toUpperCase()}`, _wrap('Order Delivered 📦', body));
}

async function refundApproved(to, { orderId, amount, currency = 'KES' }) {
    const body = `
        <p>Your refund has been approved and will be processed within 3–5 business days.</p>
        <p><strong>Order #</strong> <code>${String(orderId).slice(-9).toUpperCase()}</code></p>
        <p><strong>Refund Amount:</strong> <span style="color:#f57224;font-weight:700">${currency} ${parseFloat(amount || 0).toFixed(2)}</span></p>
        <p>Thank you for your patience.</p>`;
    return send(to, `Refund Approved — #${String(orderId).slice(-9).toUpperCase()}`, _wrap('Refund Approved ✅', body));
}

async function productApproved(to, { productTitle }) {
    const body = `
        <p>Your product listing has been reviewed and approved! 🎉</p>
        <p><strong>Product:</strong> ${productTitle || 'Your listing'}</p>
        <p>It is now live on Nexopa Marketplace and visible to buyers.</p>`;
    return send(to, `Product Approved — ${productTitle || 'Your listing'}`, _wrap('Product Approved ✅', body));
}

async function productRejected(to, { productTitle, reason }) {
    const body = `
        <p>Your product listing could not be approved at this time.</p>
        <p><strong>Product:</strong> ${productTitle || 'Your listing'}</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        <p>Please update your listing and resubmit for review.</p>`;
    return send(to, `Product Not Approved — ${productTitle || 'Your listing'}`, _wrap('Product Not Approved ❌', body));
}

async function payoutDisburse(to, { amount, currency = 'KES', method }) {
    const body = `
        <p>Your payout has been processed!</p>
        <p><strong>Amount:</strong> <span style="color:#f57224;font-weight:700">${currency} ${parseFloat(amount || 0).toFixed(2)}</span></p>
        <p><strong>Method:</strong> ${(method || 'M-Pesa').toUpperCase()}</p>
        <p>Funds should arrive within 24 hours.</p>`;
    return send(to, `Payout Processed — ${currency} ${parseFloat(amount || 0).toFixed(2)}`, _wrap('Payout Sent 💸', body));
}

async function kycApproved(to) {
    const body = `
        <p>Congratulations! Your seller account has been verified. ✅</p>
        <p>You now have access to higher listing limits and can request payouts.</p>
        <p>Start listing your products today!</p>`;
    return send(to, 'Seller Account Verified', _wrap('Seller Verified ✅', body));
}

async function kycRejected(to, { reason }) {
    const body = `
        <p>Your seller verification could not be completed.</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        <p>Please update your documents and resubmit.</p>`;
    return send(to, 'Seller Verification — Action Required', _wrap('Verification Incomplete ❌', body));
}

// ── Security alert emails (P1/P2 Forensic Audit) ─────────────────────────────
async function loginAttemptsAlert(to, { identifier, ip, attempts }) {
    const body = `
        <p>We detected <strong>${attempts}</strong> failed login attempts on your Nexopa account.</p>
        <p><strong>Account:</strong> ${identifier}</p>
        <p><strong>IP Address:</strong> ${ip}</p>
        <p>If this wasn't you, we recommend changing your password as soon as possible.
        Your account has been temporarily locked for 15 minutes as a precaution.</p>
        <p>If this was you, you can simply wait and try again shortly.</p>`;
    return send(to, 'Security Alert: Multiple Failed Login Attempts', _wrap('Security Alert ⚠️', body));
}

async function passwordResetEmail(to, { resetToken, resetUrl }) {
    const link = resetUrl || `${process.env.FRONTEND_URL || ''}/reset-password.html?token=${encodeURIComponent(resetToken)}`;
    const body = `
        <p>We received a request to reset your Nexopa account password.</p>
        <p><a class="btn" href="${link}">Reset Password</a></p>
        <p>This link will expire in 1 hour. If you did not request this, you can safely ignore this email —
        your password will remain unchanged.</p>`;
    return send(to, 'Reset Your Nexopa Password', _wrap('Password Reset Request 🔑', body));
}

async function verificationEmail(to, { verificationToken, verifyUrl }) {
    const link = verifyUrl || `${process.env.FRONTEND_URL || ''}/verify-email.html?token=${encodeURIComponent(verificationToken)}`;
    const body = `
        <p>Welcome to Nexopa! Please verify your email address to activate your account.</p>
        <p><a class="btn" href="${link}">Verify Email</a></p>
        <p>This link will expire in 24 hours. If you didn't create a Nexopa account, you can ignore this email.</p>`;
    return send(to, 'Verify Your Nexopa Email', _wrap('Verify Your Email ✉️', body));
}

async function passwordChangedAlert(to) {
    const body = `
        <p>Your Nexopa account password was just changed.</p>
        <p>If you made this change, no further action is needed.</p>
        <p><strong>If you did not change your password</strong>, please contact support immediately —
        your account may be compromised.</p>`;
    return send(to, 'Your Nexopa Password Was Changed', _wrap('Password Changed 🔒', body));
}

async function newDeviceLoginAlert(to, { device, location, ip, time }) {
    const body = `
        <p>We noticed a new login to your Nexopa account.</p>
        <p><strong>Device:</strong> ${device || 'Unknown device'}</p>
        <p><strong>Location:</strong> ${location || 'Unknown'}</p>
        <p><strong>IP Address:</strong> ${ip || 'Unknown'}</p>
        <p><strong>Time:</strong> ${time || new Date().toISOString()}</p>
        <p>If this was you, no action is needed. If you don't recognize this activity,
        please change your password immediately and review your active sessions.</p>`;
    return send(to, 'New Login to Your Nexopa Account', _wrap('New Device Login 📱', body));
}

module.exports = {
    send,
    orderConfirmed,
    orderShipped,
    orderDelivered,
    refundApproved,
    productApproved,
    productRejected,
    payoutDisburse,
    kycApproved,
    kycRejected,
    loginAttemptsAlert,
    passwordResetEmail,
    verificationEmail,
    passwordChangedAlert,
    newDeviceLoginAlert,
};
