'use strict';

const express = require('express');
const router = express.Router();
const { getInvoiceData, buildPdf } = require('../services/invoiceService');

const fail = (res, error) => res.status(error.statusCode || 500).json({
  success: false,
  message: error.message || 'Invoice request failed',
  code: error.code || 'INVOICE_ERROR',
});

function canAccess(req, invoice) {
  const id = String(req.user?.id || '');
  return id && (id === String(invoice.buyer.id) || id === String(invoice.seller.id) || req.user?.role === 'admin');
}

router.get('/orders/:orderId', async (req, res) => {
  try {
    const invoice = await getInvoiceData(req.params.orderId);
    if (!canAccess(req, invoice)) return res.status(403).json({ success:false, message:'You are not authorized to view this invoice' });
    return res.json({ success:true, data:{ invoice } });
  } catch (e) { return fail(res, e); }
});

router.get('/orders/:orderId/pdf', async (req, res) => {
  try {
    const invoice = await getInvoiceData(req.params.orderId);
    if (!canAccess(req, invoice)) return res.status(403).json({ success:false, message:'You are not authorized to download this invoice' });
    const pdf = buildPdf(invoice);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'private, no-store',
    });
    return res.send(pdf);
  } catch (e) { return fail(res, e); }
});

// Public verification endpoint. It intentionally exposes only verification-safe data.
router.get('/verify/:invoiceNumber', async (req, res) => {
  try {
    const models = require('../models');
    if (!models.Order) return res.status(503).json({ success:false, message:'Order model unavailable' });
    const order = await models.Order.findOne({ where:{ invoiceNumber:req.params.invoiceNumber } });
    if (!order) return res.status(404).json({ success:false, verified:false, message:'Invoice not found' });
    const invoice = await getInvoiceData(order.id);
    return res.json({
      success:true,
      verified:true,
      data:{ invoiceNumber:invoice.invoiceNumber, orderId:invoice.orderId, status:invoice.status, paymentStatus:invoice.paymentStatus, issuedAt:invoice.issuedAt, total:invoice.total, currency:invoice.currency, item:invoice.item.title, seller:invoice.seller.name },
    });
  } catch (e) { return fail(res, e); }
});

module.exports = router;
