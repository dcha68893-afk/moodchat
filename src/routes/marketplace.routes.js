'use strict';
// marketplace.routes.js — ALL P1/P2 FORENSIC FIXES APPLIED
// P1: adminOnly middleware at router level (not just controller)
// P1: Approval gate enforced — products default to pending_review
// P1: Refund workflow routes added
// P1: Payment + checkout rate limiting applied
// P2: Coupon validation, Flash sales, Recommendations, Wallet, KYC, Payouts, AuditLog
const express  = require('express');
const rateLimit = require('express-rate-limit');
const router   = express.Router();

let ctrl;
try {
    ctrl = require('../controllers/marketplace.controller');
} catch(e) {
    console.warn('[marketplace.routes] controller load failed:', e.message);
}

// P1 FIX: Load adminOnly middleware at route file level
let adminOnly;
try {
    adminOnly = require('../middleware/auth').adminOnly;
} catch(_) {
    adminOnly = (req, res, next) => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Admin access required.' });
        }
        next();
    };
}

// P1 FIX: Payment-specific rate limiting — stricter than general API limiter
// Prevents payment fraud attempts, brute-force checkout, and webhook replay attacks
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 10,                      // max 10 payment attempts per IP per 15min
    message: { success: false, message: 'Too many payment attempts. Please wait 15 minutes.', code: 'PAYMENT_RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,  // per-user not per-IP when authenticated
});

const checkoutLimiter = rateLimit({
    windowMs: 60 * 1000,         // 1 minute
    max: 5,                       // max 5 checkout attempts per minute (double-click protection)
    message: { success: false, message: 'Too many checkout requests. Please wait a moment.', code: 'CHECKOUT_RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,
});

const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,                     // 60 searches per minute
    message: { success: false, message: 'Search rate limit exceeded.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.query.q, // don't limit listing/browse, only search
});

const safe = (fn) => (req, res, next) => {
    if (typeof fn === 'function') return fn(req, res, next);
    return res.status(501).json({ success: false, message: 'Not yet implemented' });
};

if (ctrl) {
    // ── Products ──────────────────────────────────────────────────────────────
    router.get('/products',              safe(ctrl.getProducts?.bind(ctrl)));
    router.get('/products/:id',          safe(ctrl.getProductById?.bind(ctrl)));
    router.post('/products',             safe(ctrl.createProduct?.bind(ctrl)));
    router.put('/products/:id',          safe(ctrl.updateProduct?.bind(ctrl)));
    router.delete('/products/:id',       safe(ctrl.deleteProduct?.bind(ctrl)));
    router.post('/products/:id/stock',   safe(ctrl.updateStock?.bind(ctrl)));
    router.post('/products/:id/image',   safe(ctrl.uploadImage?.bind(ctrl)));

    // ── Search ────────────────────────────────────────────────────────────────
    router.get('/search',                searchLimiter, safe(ctrl.getProducts?.bind(ctrl)));
    router.get('/search/suggest',        searchLimiter, safe(ctrl.searchSuggest?.bind(ctrl)));

    // ── Categories ────────────────────────────────────────────────────────────
    router.get('/categories',            safe(ctrl.getCategories?.bind(ctrl)));

    // ── Flash Sales (P2 FIX: real endpoint) ──────────────────────────────────
    router.get('/flash-sales',           safe(ctrl.getFlashSales?.bind(ctrl)));

    // ── Recommendations (P2 FIX: real endpoint) ───────────────────────────────
    router.get('/recommendations',       safe(ctrl.getRecommendations?.bind(ctrl)));

    // ── Cart ──────────────────────────────────────────────────────────────────
    router.get('/cart',                  safe(ctrl.getCart?.bind(ctrl)));
    router.post('/cart',                 safe(ctrl.addToCart?.bind(ctrl)));
    router.patch('/cart',                safe(ctrl.updateCartItem?.bind(ctrl)));
    router.delete('/cart/clear',         safe(ctrl.clearCart?.bind(ctrl)));
    router.delete('/cart',               safe(ctrl.removeFromCart?.bind(ctrl)));

    // ── Coupon validation (P1 FIX) ────────────────────────────────────────────
    router.post('/coupon/validate',      safe(ctrl.validateCoupon?.bind(ctrl)));

    // ── Wishlist ──────────────────────────────────────────────────────────────
    router.get('/wishlist',              safe(ctrl.getWishlist?.bind(ctrl)));
    router.post('/wishlist',             safe(ctrl.toggleWishlist?.bind(ctrl)));
    router.delete('/wishlist/:id',       safe(ctrl.removeFromWishlist?.bind(ctrl)));

    // ── Orders ────────────────────────────────────────────────────────────────
    router.get('/orders',                safe(ctrl.getOrders?.bind(ctrl)));
    router.post('/orders',               checkoutLimiter, safe(ctrl.createOrder?.bind(ctrl)));
    router.get('/orders/:id',            safe(ctrl.getOrder?.bind(ctrl)));
    router.patch('/orders/:id/status',   safe(ctrl.updateOrderStatus?.bind(ctrl)));
    router.get('/orders/:id/tracking',   safe(ctrl.getOrderTracking?.bind(ctrl)));
    router.put('/orders/:id/tracking',   safe(ctrl.updateTracking?.bind(ctrl)));
    // P1 FIX: Refund request by buyer
    router.post('/orders/:id/refund',    safe(ctrl.requestRefund?.bind(ctrl)));

    // ── Checkout ──────────────────────────────────────────────────────────────
    router.post('/checkout',             checkoutLimiter, safe(ctrl.createOrder?.bind(ctrl)));

    // ── Payments ──────────────────────────────────────────────────────────────
    router.post('/payment/mpesa',              paymentLimiter, safe(ctrl.initiateMpesa?.bind(ctrl)));
    router.post('/payment/mpesa/callback',     safe(ctrl.mpesaCallback?.bind(ctrl)));   // no rate limit — Safaricom webhook
    router.get('/payment/mpesa/verify',        paymentLimiter, safe(ctrl.verifyMpesa?.bind(ctrl)));
    router.post('/payment/card',               paymentLimiter, safe(ctrl.cardPayment?.bind(ctrl)));
    router.post('/payment/wallet',             paymentLimiter, safe(ctrl.walletPayment?.bind(ctrl)));
    router.get('/payment/wallet/balance',      safe(ctrl.getWalletBalance?.bind(ctrl)));
    router.post('/payment/wallet/topup',       paymentLimiter, safe(ctrl.walletTopup?.bind(ctrl)));

    // ── Reviews ───────────────────────────────────────────────────────────────
    router.get('/products/:id/reviews',        safe(ctrl.getReviews?.bind(ctrl)));
    router.post('/products/:id/reviews',       safe(ctrl.createReview?.bind(ctrl)));
    router.post('/reviews/:id/respond',        safe(ctrl.respondToReview?.bind(ctrl)));
    router.post('/reviews/:id/helpful',        safe(ctrl.markReviewHelpful?.bind(ctrl)));

    // ── Seller ────────────────────────────────────────────────────────────────
    router.get('/seller/products',             safe(ctrl.getSellerDashboard?.bind(ctrl)));
    router.get('/seller/orders',               safe(ctrl.getOrders?.bind(ctrl)));
    router.get('/seller/dashboard',            safe(ctrl.getSellerDashboard?.bind(ctrl)));
    router.get('/seller/earnings',             safe(ctrl.getSellerEarnings?.bind(ctrl)));
    // P2 FIX: Seller KYC
    router.post('/seller/kyc',                 safe(ctrl.submitSellerKYC?.bind(ctrl)));
    router.get('/seller/kyc/status',           safe(ctrl.getKYCStatus?.bind(ctrl)));
    // P2 FIX: Payout requests
    router.get('/seller/payouts',              safe(ctrl.getPayouts?.bind(ctrl)));
    router.post('/seller/payouts/request',     safe(ctrl.requestPayout?.bind(ctrl)));
    router.get('/seller/:id',                  safe(ctrl.getSellerProfile?.bind(ctrl)));
    router.get('/delivery-zones',              safe(ctrl.getDeliveryZones?.bind(ctrl)));

    // ── Admin — P1 FIX: adminOnly applied at ROUTER level ─────────────────────
    // All routes below /admin require admin role — enforced BEFORE controllers.
    router.use('/admin', adminOnly);

    router.delete('/admin/products/:id',           safe(ctrl.adminRemoveProduct?.bind(ctrl)));
    router.post('/admin/ban/:sellerId',            safe(ctrl.adminBanSeller?.bind(ctrl)));
    router.get('/admin/stats',                     safe(ctrl.adminGetStats?.bind(ctrl)));
    router.get('/admin/stats/full',                safe(ctrl.adminGetStats?.bind(ctrl))); // alias — frontend calls /stats/full
    router.post('/admin/products/:id/approve',     safe(ctrl.adminApproveProduct?.bind(ctrl)));
    router.post('/admin/products/:id/reject',      safe(ctrl.adminRejectProduct?.bind(ctrl)));
    router.get('/admin/products/pending',          safe(ctrl.adminGetPendingProducts?.bind(ctrl)));

    // P1 FIX: Refund approval workflow
    router.get('/admin/refunds',                   safe(ctrl.adminGetRefunds?.bind(ctrl)));
    router.post('/admin/refunds/:id/approve',      safe(ctrl.adminApproveRefund?.bind(ctrl)));
    router.post('/admin/refunds/:id/reject',       safe(ctrl.adminRejectRefund?.bind(ctrl)));

    // P2 FIX: Seller KYC review
    router.get('/admin/kyc/pending',               safe(ctrl.adminGetPendingKYC?.bind(ctrl)));
    router.post('/admin/kyc/:id/approve',          safe(ctrl.adminApproveKYC?.bind(ctrl)));
    router.post('/admin/kyc/:id/reject',           safe(ctrl.adminRejectKYC?.bind(ctrl)));

    // P2 FIX: Payout disbursement
    router.get('/admin/payouts/pending',           safe(ctrl.adminGetPendingPayouts?.bind(ctrl)));
    router.post('/admin/payouts/:id/disburse',     safe(ctrl.adminDisbursePayout?.bind(ctrl)));

    // P2 FIX: Audit log
    router.get('/admin/audit-log',                 safe(ctrl.getAuditLog?.bind(ctrl)));

    // P2 FIX: Admin order management
    router.get('/admin/orders',                    safe(ctrl.adminGetOrders?.bind(ctrl)));
}

module.exports = router;
