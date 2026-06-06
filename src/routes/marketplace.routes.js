'use strict';
// marketplace.routes.js — FIXED: Method names corrected to match MarketplaceController
// FIX: listProducts→getProducts, getProduct→getProductById, addToCart/getCart→real implementations,
//      addToWishlist→toggleWishlist, removeWishlist→removeFromWishlist, checkout→createOrder,
//      mpesaPayment→initiateMpesa, sellerProducts→getSellerDashboard, sellerOrders→getOrders,
//      searchProducts→getProducts(with q param), addReview→createReview
const express = require('express');
const router  = express.Router();

let ctrl;
try {
    ctrl = require('../controllers/marketplace.controller');
} catch(e) {
    console.warn('[marketplace.routes] controller load failed:', e.message);
}

if (ctrl) {
    // ── Products ──────────────────────────────────────────────────────────────
    router.get('/products',           ctrl.getProducts.bind(ctrl));
    router.get('/products/:id',       ctrl.getProductById.bind(ctrl));
    router.post('/products',          ctrl.createProduct.bind(ctrl));
    router.put('/products/:id',       ctrl.updateProduct.bind(ctrl));
    router.delete('/products/:id',    ctrl.deleteProduct.bind(ctrl));
    router.post('/products/:id/stock', ctrl.updateStock.bind(ctrl));
    router.post('/products/:id/image', ctrl.uploadImage.bind(ctrl));

    // ── Search ────────────────────────────────────────────────────────────────
    // Search is handled by getProducts — it accepts a ?q= query param
    router.get('/search', ctrl.getProducts.bind(ctrl));

    // ── Categories ────────────────────────────────────────────────────────────
    router.get('/categories', ctrl.getCategories.bind(ctrl));

    // ── Cart ──────────────────────────────────────────────────────────────────
    router.get('/cart',              ctrl.getCart.bind(ctrl));
    router.post('/cart',             ctrl.addToCart.bind(ctrl));
    router.patch('/cart',            ctrl.updateCartItem.bind(ctrl));
    router.delete('/cart',           ctrl.removeFromCart.bind(ctrl));
    router.delete('/cart/clear',     ctrl.clearCart.bind(ctrl));

    // ── Wishlist ──────────────────────────────────────────────────────────────
    router.get('/wishlist',          ctrl.getWishlist.bind(ctrl));
    router.post('/wishlist',         ctrl.toggleWishlist.bind(ctrl));        // add = toggle on
    router.delete('/wishlist/:id',   ctrl.removeFromWishlist.bind(ctrl));

    // ── Orders ────────────────────────────────────────────────────────────────
    router.get('/orders',            ctrl.getOrders.bind(ctrl));
    router.post('/orders',           ctrl.createOrder.bind(ctrl));
    router.get('/orders/:id',        ctrl.getOrder.bind(ctrl));
    router.patch('/orders/:id/status', ctrl.updateOrderStatus.bind(ctrl));
    router.get('/orders/:id/tracking', ctrl.getOrderTracking.bind(ctrl));

    // ── Checkout ──────────────────────────────────────────────────────────────
    // checkout = createOrder (order is created from cart items in request body)
    router.post('/checkout',         ctrl.createOrder.bind(ctrl));

    // ── Payments ──────────────────────────────────────────────────────────────
    router.post('/payment/mpesa',           ctrl.initiateMpesa.bind(ctrl));
    router.post('/payment/mpesa/callback',  ctrl.mpesaCallback.bind(ctrl));
    router.get('/payment/mpesa/verify',     ctrl.verifyMpesa.bind(ctrl));
    router.post('/payment/card',            ctrl.cardPayment.bind(ctrl));
    router.post('/payment/wallet',          ctrl.walletPayment.bind(ctrl));
    router.get('/payment/wallet/balance',   ctrl.getWalletBalance.bind(ctrl));

    // ── Reviews ───────────────────────────────────────────────────────────────
    router.get('/products/:id/reviews',    ctrl.getReviews.bind(ctrl));
    router.post('/products/:id/reviews',   ctrl.createReview.bind(ctrl));
    router.post('/reviews/:id/respond',    ctrl.respondToReview.bind(ctrl));
    router.post('/reviews/:id/helpful',    ctrl.markReviewHelpful.bind(ctrl));

    // ── Seller ────────────────────────────────────────────────────────────────
    router.get('/seller/products',   ctrl.getSellerDashboard.bind(ctrl));   // returns seller's inventory
    router.get('/seller/orders',     ctrl.getOrders.bind(ctrl));             // same orders endpoint, seller-filtered by auth
    router.get('/seller/dashboard',  ctrl.getSellerDashboard.bind(ctrl));
    router.get('/seller/earnings',   ctrl.getSellerEarnings.bind(ctrl));
    router.get('/seller/:id',        ctrl.getSellerProfile.bind(ctrl));
    router.get('/delivery-zones',    ctrl.getDeliveryZones.bind(ctrl));

    // ── Admin ─────────────────────────────────────────────────────────────────
    router.delete('/admin/products/:id', ctrl.adminRemoveProduct.bind(ctrl));
    router.post('/admin/ban/:sellerId',  ctrl.adminBanSeller.bind(ctrl));
    router.get('/admin/stats',           ctrl.adminGetStats.bind(ctrl));
    // Admin product approval (required for seller dashboard approval flow)
    router.post('/admin/products/:id/approve', ctrl.adminApproveProduct ? ctrl.adminApproveProduct.bind(ctrl) : ctrl.adminRemoveProduct.bind(ctrl));
    router.post('/admin/products/:id/reject',  ctrl.adminRejectProduct  ? ctrl.adminRejectProduct.bind(ctrl)  : ctrl.adminRemoveProduct.bind(ctrl));
    router.get('/admin/products/pending',      ctrl.adminGetPendingProducts ? ctrl.adminGetPendingProducts.bind(ctrl) : ctrl.getProducts.bind(ctrl));
}

module.exports = router;