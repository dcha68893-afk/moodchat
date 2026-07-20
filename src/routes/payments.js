/**
 * payments.js — Payment Routes
 * PHASE14 FIX: Frontend marketplace-ecommerce.js calls /api/payments/*
 * These were previously unrouted (404). This file maps them to the
 * marketplace controller's payment handlers.
 */
'use strict';

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');

let ctrl;
try {
    ctrl = require('../controllers/marketplace.controller');
} catch(e) {
    console.warn('[payments.routes] marketplace controller load failed:', e.message);
}

// All payment routes require auth
router.use(authenticateToken);

if (ctrl) {
    // M-Pesa STK Push — frontend calls /api/payments/mpesa/stk-push
    router.post('/mpesa/stk-push',    ctrl.initiateMpesa.bind(ctrl));
    // M-Pesa verify — frontend calls /api/payments/mpesa/verify
    router.get('/mpesa/verify',       ctrl.verifyMpesa.bind(ctrl));
    // M-Pesa callback from Safaricom — no auth needed
    router.post('/mpesa/callback',    ctrl.mpesaCallback.bind(ctrl));

    // AUDIT FIX: These used to be fake stubs that always returned
    // success:true without charging anything. marketplace.controller.js
    // already has real, working implementations (Flutterwave card charge
    // with honest 503 when unconfigured; row-locked wallet DB debit with
    // transaction logging) — they were just never wired here. Use them.
    router.post('/card',   ctrl.cardPayment.bind(ctrl));
    router.post('/wallet', ctrl.walletPayment.bind(ctrl));
    router.get('/wallet/:userId/balance', ctrl.getWalletBalance.bind(ctrl));
    router.post('/wallet/topup', ctrl.walletTopup.bind(ctrl));
}

// Fallback for missing ctrl
if (!ctrl) {
    router.all('*', (req, res) => {
        res.status(503).json({ success: false, message: 'Payment service temporarily unavailable' });
    });
}

console.log('✅ Payment routes initialized at /api/payments');
module.exports = router;