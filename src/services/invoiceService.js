'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const PDFDocument = null;

function db() {
  return require('../models');
}

function escapePdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function money(value, currency = 'KES') {
  const n = Number(value || 0);
  return `${currency} ${n.toFixed(2)}`;
}

function makeInvoiceNumber() {
  const year = new Date().getUTCFullYear();
  const random = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `NCP-${year}-${random}`;
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function loadOrder(orderId) {
  const models = db();
  const Order = models.Order;
  if (!Order) throw Object.assign(new Error('Marketplace order model is unavailable'), { statusCode: 503 });

  const order = await Order.findByPk(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  return order;
}

function isPaid(order) {
  return ['paid', 'shipped', 'delivered'].includes(String(order.status || '').toLowerCase()) || Boolean(order.paidAt);
}

async function ensureInvoice(order) {
  if (!isPaid(order)) {
    throw Object.assign(new Error('Invoice is available after payment is confirmed'), { statusCode: 409, code: 'PAYMENT_NOT_CONFIRMED' });
  }

  const changes = {};
  if (!order.invoiceNumber) changes.invoiceNumber = makeInvoiceNumber();
  if (!order.invoiceToken) changes.invoiceToken = makeToken();
  if (!order.invoiceIssuedAt) changes.invoiceIssuedAt = order.paidAt || new Date();

  if (Object.keys(changes).length) {
    try {
      await order.update(changes);
    } catch (e) {
      // A rare invoice-number collision should be retried once with a fresh value.
      if (changes.invoiceNumber && /unique|duplicate/i.test(e.message || '')) {
        changes.invoiceNumber = makeInvoiceNumber();
        await order.update(changes);
      } else {
        throw e;
      }
    }
  }
  return order;
}

async function getInvoiceData(orderId) {
  const models = db();
  const order = await loadOrder(orderId);
  await ensureInvoice(order);

  let product = null;
  let buyer = null;
  let seller = null;
  try {
    if (models.Tool) product = await models.Tool.findByPk(order.productId);
    if (models.Users) {
      [buyer, seller] = await Promise.all([
        models.Users.findByPk(order.buyerId),
        models.Users.findByPk(order.sellerId),
      ]);
    }
  } catch (_) {}

  const metadata = product?.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  const buyerName = buyer?.name || buyer?.username || buyer?.email || `User ${order.buyerId}`;
  const sellerName = seller?.name || seller?.username || seller?.email || `Seller ${order.sellerId}`;
  const unitPrice = Number(order.totalPrice || 0) / Math.max(1, Number(order.quantity || 1));

  return {
    invoiceNumber: order.invoiceNumber,
    verificationToken: order.invoiceToken,
    issuedAt: order.invoiceIssuedAt || order.paidAt || order.createdAt,
    orderId: order.id,
    status: order.status,
    paymentStatus: isPaid(order) ? 'paid' : 'pending',
    paymentMethod: order.paymentMethod || 'Not specified',
    paymentReference: order.paymentRef || 'Not specified',
    paidAt: order.paidAt,
    currency: order.currency || 'KES',
    buyer: { id: order.buyerId, name: buyerName, email: buyer?.email || '', phone: buyer?.phone || '' },
    seller: { id: order.sellerId, name: sellerName, email: seller?.email || '', phone: seller?.phone || '' },
    item: {
      productId: order.productId,
      title: product?.title || metadata.title || 'Marketplace item',
      type: product?.type || 'physical',
      sku: metadata.sku || '',
      quantity: Number(order.quantity || 1),
      unitPrice,
      subtotal: Number(order.totalPrice || 0),
    },
    deliveryAddress: order.deliveryAddress || {},
    notes: order.notes || '',
    total: Number(order.totalPrice || 0),
  };
}

function buildPdf(invoice) {
  const lines = [];
  const add = (x, y, text, size = 10, bold = false) => {
    lines.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 50 ${y} Td (${escapePdfText(text)}) Tj ET`);
  };

  add(50, 760, 'NECPRA', 24, true);
  add(50, 735, 'Marketplace Invoice / Receipt', 13, true);
  add(400, 760, `Invoice: ${invoice.invoiceNumber}`, 10, true);
  add(400, 742, `Order: ${invoice.orderId}`, 9);
  add(400, 724, `Issued: ${new Date(invoice.issuedAt).toLocaleString()}`, 9);

  add(50, 690, 'BUYER', 11, true);
  add(50, 672, invoice.buyer.name, 10);
  if (invoice.buyer.email) add(50, 656, invoice.buyer.email, 9);
  if (invoice.buyer.phone) add(50, 642, invoice.buyer.phone, 9);

  add(300, 690, 'SELLER', 11, true);
  add(300, 672, invoice.seller.name, 10);
  if (invoice.seller.email) add(300, 656, invoice.seller.email, 9);
  if (invoice.seller.phone) add(300, 642, invoice.seller.phone, 9);

  add(50, 605, 'ITEM', 10, true);
  add(50, 585, invoice.item.title, 10, true);
  add(50, 568, `Type: ${invoice.item.type}${invoice.item.sku ? ` | SKU: ${invoice.item.sku}` : ''}`, 9);
  add(50, 550, `Quantity: ${invoice.item.quantity}`, 9);
  add(300, 568, `Unit price: ${money(invoice.item.unitPrice, invoice.currency)}`, 9);
  add(300, 550, `Subtotal: ${money(invoice.item.subtotal, invoice.currency)}`, 9);

  add(50, 510, 'PAYMENT', 10, true);
  add(50, 492, `Status: ${invoice.paymentStatus.toUpperCase()}`, 9);
  add(50, 476, `Method: ${invoice.paymentMethod}`, 9);
  add(50, 460, `Reference: ${invoice.paymentReference}`, 9);

  add(350, 510, 'TOTAL', 12, true);
  add(350, 488, money(invoice.total, invoice.currency), 16, true);

  if (invoice.deliveryAddress && Object.keys(invoice.deliveryAddress).length) {
    add(50, 420, 'DELIVERY ADDRESS', 10, true);
    const address = Object.entries(invoice.deliveryAddress).map(([k, v]) => `${k}: ${v}`).join(', ');
    add(50, 402, address.slice(0, 110), 8);
  }

  add(50, 340, 'This document is generated by Necpra from the recorded marketplace order.', 8);
  add(50, 325, `Verify invoice: /api/invoices/verify/${invoice.invoiceNumber}`, 8);
  add(50, 300, 'Thank you for using Necpra.', 10, true);

  const stream = lines.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => { offsets[i + 1] = Buffer.byteLength(pdf, 'ascii'); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

module.exports = { getInvoiceData, ensureInvoice, buildPdf, isPaid };
