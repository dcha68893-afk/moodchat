'use strict';
// marketplace.routes.js — Auto-generated shim
// Mounts all marketplace controller handlers as Express routes
const express = require('express');
const router  = express.Router();

let ctrl;
try {
    ctrl = require('../controllers/marketplace.controller');
} catch(e) {
    console.warn('[marketplace.routes] controller load failed:', e.message);
}

if (ctrl) {
    // Products
    router.get('/products',           ctrl.listProducts    || ((req,res)=>res.json({success:true,products:[]})));
    router.get('/products/:id',       ctrl.getProduct      || ((req,res)=>res.json({success:true,product:{}})));
    router.post('/products',          ctrl.createProduct   || ((req,res)=>res.json({success:true})));
    router.put('/products/:id',       ctrl.updateProduct   || ((req,res)=>res.json({success:true})));
    router.delete('/products/:id',    ctrl.deleteProduct   || ((req,res)=>res.json({success:true})));

    // Categories
    router.get('/categories',         ctrl.getCategories   || ((req,res)=>res.json({success:true,categories:[]})));

    // Cart
    router.get('/cart',               ctrl.getCart         || ((req,res)=>res.json({success:true,cart:[]})));
    router.post('/cart',              ctrl.addToCart       || ((req,res)=>res.json({success:true})));
    router.delete('/cart/:id',        ctrl.removeFromCart  || ((req,res)=>res.json({success:true})));

    // Orders
    router.get('/orders',             ctrl.getOrders       || ((req,res)=>res.json({success:true,orders:[]})));
    router.post('/orders',            ctrl.createOrder     || ((req,res)=>res.json({success:true})));
    router.get('/orders/:id',         ctrl.getOrder        || ((req,res)=>res.json({success:true,order:{}})));

    // Wishlist
    router.get('/wishlist',           ctrl.getWishlist     || ((req,res)=>res.json({success:true,wishlist:[]})));
    router.post('/wishlist',          ctrl.addToWishlist   || ((req,res)=>res.json({success:true})));
    router.delete('/wishlist/:id',    ctrl.removeWishlist  || ((req,res)=>res.json({success:true})));

    // Search
    router.get('/search',             ctrl.searchProducts  || ((req,res)=>res.json({success:true,results:[]})));

    // Reviews
    router.get('/products/:id/reviews', ctrl.getReviews   || ((req,res)=>res.json({success:true,reviews:[]})));
    router.post('/products/:id/reviews',ctrl.addReview    || ((req,res)=>res.json({success:true})));

    // Checkout / Payment
    router.post('/checkout',          ctrl.checkout        || ((req,res)=>res.json({success:true})));
    router.post('/payment/mpesa',     ctrl.mpesaPayment    || ((req,res)=>res.json({success:true})));
    router.post('/payment/card',      ctrl.cardPayment     || ((req,res)=>res.json({success:true})));

    // Seller / Dashboard
    router.get('/seller/products',    ctrl.sellerProducts  || ((req,res)=>res.json({success:true,products:[]})));
    router.get('/seller/orders',      ctrl.sellerOrders    || ((req,res)=>res.json({success:true,orders:[]})));
}

module.exports = router;
