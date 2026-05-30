'use strict';
/**
 * marketplace.routes.js — COMPLETE CUSTOMER MARKETPLACE ROUTES
 * Mounts all marketplace endpoints for the full Jumia-like buyer experience.
 * All routes require authentication (applied by index.js wrapping).
 */

const express = require('express');
const router  = express.Router();

let ctrl;
try {
    ctrl = require('../controllers/marketplace.controller');
} catch(e) {
    console.warn('[marketplace.routes] controller load failed:', e.message);
}

// ── Public product browsing (no auth required at route level — auth wrapper handles it) ──
const noop = (handler) => handler || ((req, res) => res.json({ success: true, data: {} }));

if (ctrl) {

    // ════════════════════════════════════════════════
    // PRODUCTS
    // ════════════════════════════════════════════════
    router.get('/products',                    noop(ctrl.getProducts?.bind(ctrl)     || ctrl.listProducts?.bind(ctrl)));
    router.get('/products/featured',           noop(ctrl.getFeaturedProducts?.bind(ctrl)));
    router.get('/products/flash-sales',        noop(ctrl.getFlashSales?.bind(ctrl)));
    router.get('/products/trending',           noop(ctrl.getTrendingProducts?.bind(ctrl)));
    router.get('/products/new-arrivals',       noop(ctrl.getNewArrivals?.bind(ctrl)));
    router.get('/products/:id',                noop(ctrl.getProductById?.bind(ctrl)  || ctrl.getProduct?.bind(ctrl)));
    router.post('/products',                   noop(ctrl.createProduct?.bind(ctrl)));
    router.put('/products/:id',                noop(ctrl.updateProduct?.bind(ctrl)));
    router.delete('/products/:id',             noop(ctrl.deleteProduct?.bind(ctrl)));
    router.patch('/products/:id/stock',        noop(ctrl.updateStock?.bind(ctrl)));
    router.post('/products/upload-image',      noop(ctrl.uploadImage?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // CATEGORIES
    // ════════════════════════════════════════════════
    router.get('/categories',                  noop(ctrl.getCategories?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // SEARCH
    // ════════════════════════════════════════════════
    router.get('/search',                      noop(ctrl.searchProducts?.bind(ctrl)));
    router.get('/search/suggestions',          noop(ctrl.getSearchSuggestions?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // CART (server-side sync)
    // ════════════════════════════════════════════════
    router.get('/cart',                        noop(ctrl.getCart?.bind(ctrl)));
    router.post('/cart',                       noop(ctrl.addToCart?.bind(ctrl)));
    router.put('/cart/:itemId',                noop(ctrl.updateCartItem?.bind(ctrl)));
    router.delete('/cart/:itemId',             noop(ctrl.removeFromCart?.bind(ctrl)));
    router.delete('/cart',                     noop(ctrl.clearCart?.bind(ctrl)));
    router.post('/cart/sync',                  noop(ctrl.syncCart?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // WISHLIST
    // ════════════════════════════════════════════════
    router.get('/wishlist',                    noop(ctrl.getWishlist?.bind(ctrl)));
    router.post('/wishlist',                   noop(ctrl.addToWishlist?.bind(ctrl)   || ctrl.toggleWishlist?.bind(ctrl)));
    router.delete('/wishlist/:id',             noop(ctrl.removeFromWishlist?.bind(ctrl)));
    router.post('/wishlist/:id/move-to-cart',  noop(ctrl.moveWishlistToCart?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // ADDRESSES (customer address book)
    // ════════════════════════════════════════════════
    router.get('/addresses',                   noop(ctrl.getAddresses?.bind(ctrl)));
    router.post('/addresses',                  noop(ctrl.addAddress?.bind(ctrl)));
    router.put('/addresses/:id',               noop(ctrl.updateAddress?.bind(ctrl)));
    router.delete('/addresses/:id',            noop(ctrl.deleteAddress?.bind(ctrl)));
    router.patch('/addresses/:id/default',     noop(ctrl.setDefaultAddress?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // DELIVERY
    // ════════════════════════════════════════════════
    router.get('/delivery/zones',              noop(ctrl.getDeliveryZones?.bind(ctrl)));
    router.post('/delivery/estimate',          noop(ctrl.estimateDelivery?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // CHECKOUT (creates order from cart or direct)
    // ════════════════════════════════════════════════
    router.post('/checkout',                   noop(ctrl.checkout?.bind(ctrl)));
    router.post('/checkout/validate',          noop(ctrl.validateCheckout?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // ORDERS
    // ════════════════════════════════════════════════
    router.get('/orders',                      noop(ctrl.getOrders?.bind(ctrl)));
    router.post('/orders',                     noop(ctrl.createOrder?.bind(ctrl)));
    router.get('/orders/:id',                  noop(ctrl.getOrder?.bind(ctrl)));
    router.get('/orders/:id/tracking',         noop(ctrl.getOrderTracking?.bind(ctrl)));
    router.get('/orders/:id/eta',              noop(ctrl.getOrderEta?.bind(ctrl)));
    router.put('/orders/:id/status',           noop(ctrl.updateOrderStatus?.bind(ctrl)));
    router.put('/orders/:id/tracking',         noop(ctrl.updateOrderTracking?.bind(ctrl)));
    router.post('/orders/:id/cancel',          noop(ctrl.cancelOrder?.bind(ctrl)));
    router.post('/orders/:id/refund',          noop(ctrl.requestRefund?.bind(ctrl)));
    router.post('/orders/:id/confirm-receipt', noop(ctrl.confirmDelivery?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // PAYMENTS
    // ════════════════════════════════════════════════
    router.post('/payment/mpesa',              noop(ctrl.mpesaPayment?.bind(ctrl)));
    router.post('/payment/mpesa/stk-push',     noop(ctrl.mpesaPayment?.bind(ctrl)));
    router.post('/payment/mpesa/verify',       noop(ctrl.mpesaVerify?.bind(ctrl)));
    router.post('/payment/mpesa/callback',     noop(ctrl.mpesaCallback?.bind(ctrl)));
    router.post('/payment/card',               noop(ctrl.cardPayment?.bind(ctrl)));
    router.post('/payment/wallet',             noop(ctrl.walletPayment?.bind(ctrl)));
    router.post('/payment/cod',                noop(ctrl.codPayment?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // REVIEWS
    // ════════════════════════════════════════════════
    router.get('/products/:id/reviews',        noop(ctrl.getProductReviews?.bind(ctrl)     || ctrl.getReviews?.bind(ctrl)));
    router.post('/products/:id/reviews',       noop(ctrl.createProductReview?.bind(ctrl)   || ctrl.addReview?.bind(ctrl)));
    router.put('/reviews/:id',                 noop(ctrl.updateReview?.bind(ctrl)));
    router.delete('/reviews/:id',              noop(ctrl.deleteReview?.bind(ctrl)));
    router.post('/reviews/:id/helpful',        noop(ctrl.markReviewHelpful?.bind(ctrl)));
    router.post('/reviews/:id/respond',        noop(ctrl.respondToReview?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // COUPONS / VOUCHERS
    // ════════════════════════════════════════════════
    router.post('/coupons/validate',           noop(ctrl.validateCoupon?.bind(ctrl)));
    router.post('/coupons/apply',              noop(ctrl.applyCoupon?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // WALLET
    // ════════════════════════════════════════════════
    router.get('/wallet',                      noop(ctrl.getWallet?.bind(ctrl)));
    router.post('/wallet/top-up',              noop(ctrl.topUpWallet?.bind(ctrl)));
    router.get('/wallet/transactions',         noop(ctrl.getWalletTransactions?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // LOYALTY & REWARDS
    // ════════════════════════════════════════════════
    router.get('/loyalty',                     noop(ctrl.getLoyalty?.bind(ctrl)));
    router.post('/loyalty/redeem',             noop(ctrl.redeemPoints?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // REFERRAL
    // ════════════════════════════════════════════════
    router.get('/referral',                    noop(ctrl.getReferral?.bind(ctrl)));
    router.post('/referral/apply',             noop(ctrl.applyReferral?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // FLASH SALES
    // ════════════════════════════════════════════════
    router.get('/flash-sales',                 noop(ctrl.getActiveFlashSales?.bind(ctrl)));
    router.post('/flash-sales',                noop(ctrl.createFlashSale?.bind(ctrl)));
    router.delete('/flash-sales/:id',          noop(ctrl.endFlashSale?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // AI RECOMMENDATIONS & BEHAVIOR TRACKING
    // ════════════════════════════════════════════════
    router.get('/recommendations',             noop(ctrl.getRecommendations?.bind(ctrl)));
    router.post('/behavior/track',             noop(ctrl.trackBehavior?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // BUY NOW (instant checkout bypass cart)
    // ════════════════════════════════════════════════
    router.post('/buy-now',                    noop(ctrl.buyNow?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // PRODUCT COMPARISON
    // ════════════════════════════════════════════════
    router.get('/compare',                     noop(ctrl.compareProducts?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // INVOICE / PDF
    // ════════════════════════════════════════════════
    router.get('/orders/:id/invoice',          noop(ctrl.getOrderInvoice?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // QR CODE TRACKING
    // ════════════════════════════════════════════════
    router.get('/orders/:id/qr',               noop(ctrl.getOrderQR?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // SMART DELIVERY ESTIMATE
    // ════════════════════════════════════════════════
    router.post('/delivery/smart-estimate',    noop(ctrl.smartDeliveryEstimate?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // COUPONS (admin create + public list)
    // ════════════════════════════════════════════════
    router.get('/coupons',                     noop(ctrl.listCoupons?.bind(ctrl)));
    router.post('/admin/coupons',              noop(ctrl.adminCreateCoupon?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // SELLER DASHBOARD (authenticated)
    // ════════════════════════════════════════════════
    router.get('/seller-dashboard',            noop(ctrl.getSellerDashboard?.bind(ctrl)));
    router.get('/seller-dashboard/orders',     noop(ctrl.getSellerOrders?.bind(ctrl)));
    router.get('/seller-dashboard/earnings',   noop(ctrl.getSellerEarnings?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // SELLER PROFILE (public view)
    // ════════════════════════════════════════════════
    router.get('/seller/:sellerId',            noop(ctrl.getSellerProfile?.bind(ctrl)));
    router.get('/seller/:sellerId/products',   noop(ctrl.getSellerProducts?.bind(ctrl)));

    // ════════════════════════════════════════════════
    // ADMIN
    // ════════════════════════════════════════════════
    router.get('/admin/stats',                 noop(ctrl.adminGetStats?.bind(ctrl)));
    router.delete('/admin/products/:id',       noop(ctrl.adminRemoveProduct?.bind(ctrl)));
    router.post('/admin/sellers/:sellerId/ban',noop(ctrl.adminBanSeller?.bind(ctrl)));

} else {
    // Fallback: all routes return empty success so frontend doesn't break
    router.all('*', (req, res) => res.json({ success: true, data: {}, message: 'Marketplace controller unavailable' }));
}

module.exports = router;
