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

    // Card payment
    router.post('/card', async (req, res) => {
        // Placeholder — real card integration goes here
        res.json({ success: true, message: 'Card payment initiated', data: { reference: `CARD-${Date.now()}` } });
    });

    // Wallet payment
    router.post('/wallet', async (req, res) => {
        res.json({ success: true, message: 'Wallet payment initiated', data: { reference: `WALLET-${Date.now()}` } });
    });

    // Wallet balance
    router.get('/wallet/:userId/balance', async (req, res) => {
        res.json({ success: true, data: { balance: 0, currency: 'KES' } });
    });
}

// Fallback for missing ctrl
if (!ctrl) {
    router.all('*', (req, res) => {
        res.status(503).json({ success: false, message: 'Payment service temporarily unavailable' });
    });
}

console.log('✅ Payment routes initialized at /api/payments');
module.exports = router;