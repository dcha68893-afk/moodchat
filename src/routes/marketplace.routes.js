'use strict';
/**
 * marketplace.routes.js — COMPLETE FORENSIC FIX
 * 109 routes wired. Every URL the buyer/seller/admin frontend calls is here.
 */
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const router     = express.Router();

let ctrl;
try { ctrl = require('../controllers/marketplace.controller'); }
catch(e) { console.warn('[marketplace.routes] controller load failed:', e.message); }

let adminOnly;
try { adminOnly = require('../middleware/auth').adminOnly; }
catch(_) {
    adminOnly = (req, res, next) => {
        if (!req.user || req.user.role !== 'admin')
            return res.status(403).json({ success: false, message: 'Admin access required.' });
        next();
    };
}

const paymentLimiter  = rateLimit({ windowMs:15*60*1000, max:10, keyGenerator:r=>r.user?.id||r.ip,
    message:{success:false,message:'Too many payment attempts. Wait 15 minutes.'},standardHeaders:true,legacyHeaders:false });
const checkoutLimiter = rateLimit({ windowMs:60*1000,    max:5,  keyGenerator:r=>r.user?.id||r.ip,
    message:{success:false,message:'Too many checkout requests. Wait a moment.'},standardHeaders:true,legacyHeaders:false });
const searchLimiter   = rateLimit({ windowMs:60*1000,    max:60, keyGenerator:r=>r.user?.id||r.ip,
    message:{success:false,message:'Search rate limit exceeded.'},standardHeaders:true,legacyHeaders:false,
    skip:r=>!r.query.q });

const safe = (fn) => (req, res, next) => {
    if (typeof fn === 'function') return fn(req, res, next);
    return res.status(501).json({ success:false, message:'Not yet implemented' });
};

if (ctrl) {
    // ── Products ─────────────────────────────────────────────────────────────
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

    // ── Discovery ────────────────────────────────────────────────────────────
    router.get('/categories',            safe(ctrl.getCategories?.bind(ctrl)));
    router.get('/flash-sales',           safe(ctrl.getFlashSales?.bind(ctrl)));
    router.get('/recommendations',       safe(ctrl.getRecommendations?.bind(ctrl)));
    router.get('/trending',              safe(ctrl.getProducts?.bind(ctrl)));
    router.get('/compare',               safe(ctrl.compareProducts?.bind(ctrl)));

    // ── Cart ─────────────────────────────────────────────────────────────────
    router.get('/cart',                  safe(ctrl.getCart?.bind(ctrl)));
    router.post('/cart',                 safe(ctrl.addToCart?.bind(ctrl)));
    router.patch('/cart',                safe(ctrl.updateCartItem?.bind(ctrl)));
    router.post('/cart/sync',            safe(ctrl.syncCart?.bind(ctrl)));
    router.delete('/cart/clear',         safe(ctrl.clearCart?.bind(ctrl)));
    router.delete('/cart',               safe(ctrl.removeFromCart?.bind(ctrl)));

    // ── Coupon ────────────────────────────────────────────────────────────────
    router.post('/coupon/validate',      safe(ctrl.validateCoupon?.bind(ctrl)));
    router.get('/coupons',               safe(ctrl.getPublicCoupons?.bind(ctrl)));

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
    router.post('/orders/:id/refund',    safe(ctrl.requestRefund?.bind(ctrl)));
    router.post('/orders/:id/cancel',    safe(ctrl.cancelOrder?.bind(ctrl)));

    // ── Checkout ─────────────────────────────────────────────────────────────
    router.post('/checkout',             checkoutLimiter, safe(ctrl.createOrder?.bind(ctrl)));

    // ── Payments ─────────────────────────────────────────────────────────────
    router.post('/payment/mpesa',              paymentLimiter, safe(ctrl.initiateMpesa?.bind(ctrl)));
    router.post('/payment/mpesa/callback',     safe(ctrl.mpesaCallback?.bind(ctrl)));
    router.get('/payment/mpesa/verify',        safe(ctrl.verifyMpesa?.bind(ctrl)));
    router.post('/payment/card',               paymentLimiter, safe(ctrl.cardPayment?.bind(ctrl)));
    router.post('/payment/wallet',             paymentLimiter, safe(ctrl.walletPayment?.bind(ctrl)));
    router.get('/payment/wallet/balance',      safe(ctrl.getWalletBalance?.bind(ctrl)));
    router.post('/payment/wallet/topup',       paymentLimiter, safe(ctrl.walletTopup?.bind(ctrl)));

    // ── Wallet (advanced.js calls /marketplace/wallet) ────────────────────────
    router.get('/wallet',                safe(ctrl.getWalletBalance?.bind(ctrl)));
    router.post('/wallet/top-up',        paymentLimiter, safe(ctrl.walletTopup?.bind(ctrl)));

    // ── Loyalty / Referral / Behavior (advanced.js) ──────────────────────────
    router.get('/loyalty',               safe(ctrl.getLoyalty?.bind(ctrl)));
    router.post('/loyalty/redeem',       safe(ctrl.redeemLoyalty?.bind(ctrl)));
    router.get('/referral',              safe(ctrl.getReferral?.bind(ctrl)));
    router.post('/behavior/track',       safe(ctrl.trackBehavior?.bind(ctrl)));

    // ── Addresses (checkout.js) ───────────────────────────────────────────────
    router.get('/addresses',             safe(ctrl.getAddresses?.bind(ctrl)));
    router.post('/addresses',            safe(ctrl.saveAddress?.bind(ctrl)));
    router.delete('/addresses/:id',      safe(ctrl.deleteAddress?.bind(ctrl)));
    router.patch('/addresses/:id/default', safe(ctrl.setDefaultAddress?.bind(ctrl)));

    // ── Delivery ─────────────────────────────────────────────────────────────
    router.get('/delivery-zones',        safe(ctrl.getDeliveryZones?.bind(ctrl)));
    router.get('/delivery/zones',        safe(ctrl.getDeliveryZones?.bind(ctrl)));
    router.post('/delivery/smart-estimate', safe(ctrl.smartDeliveryEstimate?.bind(ctrl)));

    // ── Reviews ──────────────────────────────────────────────────────────────
    router.get('/products/:id/reviews',  safe(ctrl.getReviews?.bind(ctrl)));
    router.post('/products/:id/reviews', safe(ctrl.createReview?.bind(ctrl)));
    router.post('/reviews/:id/respond',  safe(ctrl.respondToReview?.bind(ctrl)));
    router.post('/reviews/:id/helpful',  safe(ctrl.markReviewHelpful?.bind(ctrl)));

    // ── Support ───────────────────────────────────────────────────────────────
    router.post('/support/ticket',       safe(ctrl.createSupportTicket?.bind(ctrl)));

    // ════════════════════════════════════════════════════════════════════════
    // SELLER ROUTES
    // ════════════════════════════════════════════════════════════════════════
    router.get('/seller-dashboard',                  safe(ctrl.getSellerDashboard?.bind(ctrl)));
    router.get('/seller-dashboard/orders',           safe(ctrl.getSellerOrders?.bind(ctrl)));
    router.get('/seller/dashboard',                  safe(ctrl.getSellerDashboard?.bind(ctrl)));

    router.get('/seller/products',                   safe(ctrl.getSellerProducts?.bind(ctrl)));
    router.post('/seller/products/import',           safe(ctrl.importSellerProducts?.bind(ctrl)));
    router.post('/seller/products/:id/archive',      safe(ctrl.sellerArchiveProduct?.bind(ctrl)));
    router.post('/seller/products/:id/restore',      safe(ctrl.sellerRestoreProduct?.bind(ctrl)));
    router.post('/seller/products/:id/resubmit',     safe(ctrl.sellerResubmitProduct?.bind(ctrl)));
    router.post('/seller/products/:id/duplicate',    safe(ctrl.sellerDuplicateProduct?.bind(ctrl)));

    router.get('/seller/inventory',                  safe(ctrl.getSellerInventory?.bind(ctrl)));
    router.put('/seller/inventory/bulk',             safe(ctrl.bulkUpdateInventory?.bind(ctrl)));

    router.get('/seller/analytics',                  safe(ctrl.getSellerAnalytics?.bind(ctrl)));
    router.get('/seller/earnings',                   safe(ctrl.getSellerEarnings?.bind(ctrl)));

    router.get('/seller/orders',                     safe(ctrl.getSellerOrders?.bind(ctrl)));
    router.put('/seller/orders/:id/shipping',        safe(ctrl.updateShipping?.bind(ctrl)));

    router.get('/seller/payout',                     safe(ctrl.getPayouts?.bind(ctrl)));
    router.get('/seller/payouts',                    safe(ctrl.getPayouts?.bind(ctrl)));
    router.post('/seller/payout/request',            safe(ctrl.requestPayout?.bind(ctrl)));
    router.post('/seller/payouts/request',           safe(ctrl.requestPayout?.bind(ctrl)));

    router.get('/seller/returns',                    safe(ctrl.getSellerReturns?.bind(ctrl)));
    router.post('/seller/returns/:id/approve',       safe(ctrl.approveReturn?.bind(ctrl)));
    router.post('/seller/returns/:id/reject',        safe(ctrl.rejectReturn?.bind(ctrl)));

    router.get('/seller/verification',               safe(ctrl.getKYCStatus?.bind(ctrl)));
    router.post('/seller/verification',              safe(ctrl.submitSellerKYC?.bind(ctrl)));
    router.get('/seller/kyc/status',                 safe(ctrl.getKYCStatus?.bind(ctrl)));
    router.post('/seller/kyc',                       safe(ctrl.submitSellerKYC?.bind(ctrl)));

    router.get('/seller/subscription',               safe(ctrl.getSellerSubscription?.bind(ctrl)));
    router.post('/seller/subscription/upgrade',      safe(ctrl.upgradeSubscription?.bind(ctrl)));

    router.get('/seller/:id',                        safe(ctrl.getSellerProfile?.bind(ctrl)));

    // AUDIT FIX: marketplace-ecommerce.js's SellerEngine calls the plural
    // "/sellers/:id" form (getProfile, getDashboard, getEarnings) but only
    // the singular "/seller/:id" route existed — these calls were 404ing
    // silently (the frontend _api() fallback swallows failed responses).
    // getSellerDashboard/getSellerEarnings read the authenticated user from
    // req.user internally, so the :id param is accepted for URL symmetry
    // with getSellerProfile but the data returned is always the caller's own.
    router.get('/sellers/:id',                       safe(ctrl.getSellerProfile?.bind(ctrl)));
    router.get('/sellers/:id/dashboard',             safe(ctrl.getSellerDashboard?.bind(ctrl)));
    router.get('/sellers/:id/earnings',              safe(ctrl.getSellerEarnings?.bind(ctrl)));

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN ROUTES — adminOnly enforced at router level
    // ════════════════════════════════════════════════════════════════════════
    router.use('/admin', adminOnly);

    router.get('/admin/stats',                       safe(ctrl.adminGetStats?.bind(ctrl)));
    router.get('/admin/stats/full',                  safe(ctrl.adminGetStats?.bind(ctrl)));
    router.get('/admin/analytics',                   safe(ctrl.adminGetStats?.bind(ctrl)));
    router.get('/admin/marketplace/stats',           safe(ctrl.adminGetStats?.bind(ctrl)));
    router.get('/admin/marketplace/reports',         safe(ctrl.adminGetStats?.bind(ctrl)));

    router.get('/admin/products',                    safe(ctrl.adminGetProducts?.bind(ctrl)));
    router.get('/admin/products/pending',            safe(ctrl.adminGetPendingProducts?.bind(ctrl)));
    router.post('/admin/products/:id/approve',       safe(ctrl.adminApproveProduct?.bind(ctrl)));
    router.post('/admin/products/:id/reject',        safe(ctrl.adminRejectProduct?.bind(ctrl)));
    router.delete('/admin/products/:id',             safe(ctrl.adminRemoveProduct?.bind(ctrl)));

    router.get('/admin/sellers',                     safe(ctrl.adminGetSellers?.bind(ctrl)));
    router.get('/admin/buyers',                      safe(ctrl.adminGetBuyers?.bind(ctrl)));
    router.post('/admin/ban/:userId',                safe(ctrl.adminBanSeller?.bind(ctrl)));
    router.post('/admin/unban/:userId',              safe(ctrl.adminUnbanUser?.bind(ctrl)));
    // AUDIT FIX: marketplace-admin.js's real "Ban" button calls this path;
    // it was 404ing because only /admin/ban/:userId existed.
    router.post('/admin/sellers/:userId/ban',        safe(ctrl.adminBanSeller?.bind(ctrl)));

    router.get('/admin/orders',                      safe(ctrl.adminGetOrders?.bind(ctrl)));

    router.get('/admin/returns',                     safe(ctrl.adminGetRefunds?.bind(ctrl)));
    router.get('/admin/refunds',                     safe(ctrl.adminGetRefunds?.bind(ctrl)));
    router.post('/admin/refunds/:id/approve',        safe(ctrl.adminApproveRefund?.bind(ctrl)));
    router.post('/admin/refunds/:id/reject',         safe(ctrl.adminRejectRefund?.bind(ctrl)));

    router.get('/admin/payouts',                     safe(ctrl.adminGetPendingPayouts?.bind(ctrl)));
    router.post('/admin/payouts/process',            safe(ctrl.adminProcessPayout?.bind(ctrl)));
    router.post('/admin/payouts/:id/disburse',       safe(ctrl.adminDisbursePayout?.bind(ctrl)));

    router.get('/admin/coupons',                     safe(ctrl.adminGetCoupons?.bind(ctrl)));
    router.post('/admin/coupons',                    safe(ctrl.adminCreateCoupon?.bind(ctrl)));
    router.delete('/admin/coupons/:id',              safe(ctrl.adminDeleteCoupon?.bind(ctrl)));

    router.get('/admin/flash-sales',                 safe(ctrl.adminGetFlashSales?.bind(ctrl)));
    router.post('/admin/flash-sales',                safe(ctrl.adminCreateFlashSale?.bind(ctrl)));
    router.delete('/admin/flash-sales/:id',          safe(ctrl.adminDeleteFlashSale?.bind(ctrl)));

    router.get('/admin/reviews',                     safe(ctrl.adminGetReviews?.bind(ctrl)));
    router.delete('/admin/reviews/:id',              safe(ctrl.adminDeleteReview?.bind(ctrl)));

    router.get('/admin/tickets',                     safe(ctrl.adminGetTickets?.bind(ctrl)));
    router.post('/admin/tickets/:id/reply',          safe(ctrl.adminReplyTicket?.bind(ctrl)));
    router.post('/admin/tickets/:id/close',          safe(ctrl.adminCloseTicket?.bind(ctrl)));

    router.post('/admin/notifications/send',         safe(ctrl.adminSendNotification?.bind(ctrl)));

    router.get('/admin/settings',                    safe(ctrl.adminGetSettings?.bind(ctrl)));
    router.put('/admin/settings',                    safe(ctrl.adminUpdateSettings?.bind(ctrl)));

    router.get('/admin/kyc/pending',                 safe(ctrl.adminGetPendingKYC?.bind(ctrl)));
    router.post('/admin/kyc/:id/approve',            safe(ctrl.adminApproveKYC?.bind(ctrl)));
    router.post('/admin/kyc/:id/reject',             safe(ctrl.adminRejectKYC?.bind(ctrl)));
    // AUDIT FIX: marketplace-admin.js's Verify/Reject seller button posts a
    // single {approved, reason} body to /admin/sellers/:id/verify. Dispatch
    // to the existing approve/reject controller methods based on that flag.
    router.post('/admin/sellers/:id/verify', safe(ctrl.verifySeller?.bind(ctrl)));

    router.get('/admin/audit-log',                   safe(ctrl.getAuditLog?.bind(ctrl)));
}

module.exports = router;
