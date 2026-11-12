'use strict';
/**
 * NECPRA DUKA SMART — Phase 1 + 2 API (mounted at /api/duka by routes/index.js).
 *
 *   Shops      GET/POST /shops · GET/PATCH/DELETE(archive) /shops/:shopId
 *   Products   GET/POST /shops/:shopId/products · GET/PATCH/DELETE .../products/:id
 *   Stock      POST .../products/:id/stock · GET .../products/:id/movements
 *   Customers  GET/POST /shops/:shopId/customers
 *   Sales/POS  POST /shops/:shopId/sales · GET /shops/:shopId/sales · GET /shops/:shopId/sales/:saleId (receipt)
 *   Dashboard  GET /shops/:shopId/dashboard
 *   Audit      GET /shops/:shopId/audit
 *   Finance    expenses, suppliers, debts, collections, reports → see services/dukaFinance.js (Phase 5)
 *
 * Sales (Phase 2)
 *  - The sale id is a client-generated UUID and is the idempotency key: replaying the same POST (a
 *    network retry or an offline-outbox resend) returns the stored sale and never touches stock again.
 *  - One DB transaction writes the sale, its items, its payments, the stock deductions + ledger rows and
 *    the audit entry — a sale is either fully recorded or not at all, and stock can never go negative.
 *  - All money is computed server-side in integer cents/milli-units (BigInt for qty x price), never floats.
 *  - Credit is NOT cash: amount_paid counts only real payments; balance_due is what the customer still owes.
 *  - M-PESA is never accepted without a receipt code. 'verified' is only set when that code matches a PAID
 *    NECPRA STK transaction for at least the amount; otherwise it is stored as 'receipt_recorded' (the
 *    shopkeeper's own attestation) and reported separately so it is never presented as verified.
 *
 * Security model
 *  - Every route requires a valid JWT (authenticateToken is applied here and by index.js).
 *  - Every shop lookup is `WHERE id = :shopId AND owner_id = :userId`. A shop that belongs to
 *    someone else is indistinguishable from one that does not exist (404), so ids cannot be probed.
 *  - Products / movements / audit rows are only ever reached through an owned shop id.
 *  - Stock is NEVER edited directly: it changes only through duka_stock_movements rows written in
 *    the same DB transaction as the product row (ledger + balance cannot drift).
 *  - Client-supplied UUIDs (shop id, product id, clientOpId) make every create/adjust idempotent,
 *    which is what the offline outbox (Phase 5) relies on to never duplicate a record on retry.
 */
const express = require('express');
const { QueryTypes } = require('sequelize');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SHOPS = () => Math.max(1, Number(process.env.DUKA_MAX_SHOPS || 5));
const MAX_MONEY = 99999999.99;
const MAX_QTY = 99999999.999;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'DUKA_ERROR';
  }
}

/* ───────────── validation helpers (hand-rolled: no extra dependency) ───────────── */
const has = (v) => v !== undefined && v !== null && v !== '';
function str(v, field, { max, required = false } = {}) {
  if (!has(v)) {
    if (required) throw new HttpError(400, `${field} is required`, 'VALIDATION_ERROR');
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`, 'VALIDATION_ERROR');
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s && required) throw new HttpError(400, `${field} is required`, 'VALIDATION_ERROR');
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`, 'VALIDATION_ERROR');
  return s || null;
}
function num(v, field, { dp, min = 0, max, required = false, allowNegative = false } = {}) {
  if (!has(v)) {
    if (required) throw new HttpError(400, `${field} is required`, 'VALIDATION_ERROR');
    return null;
  }
  if (typeof v !== 'number' && !(typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) {
    throw new HttpError(400, `${field} must be a number`, 'VALIDATION_ERROR');
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`, 'VALIDATION_ERROR');
  if (!allowNegative && n < min) throw new HttpError(400, `${field} cannot be less than ${min}`, 'VALIDATION_ERROR');
  if (n > max) throw new HttpError(400, `${field} is too large`, 'VALIDATION_ERROR');
  const f = Math.pow(10, dp);
  if (Math.abs(Math.round(n * f) / f - n) > 1e-9) {
    throw new HttpError(400, `${field} can have at most ${dp} decimal places`, 'VALIDATION_ERROR');
  }
  return Math.round(n * f) / f;
}
const money = (v, field, o = {}) => num(v, field, { dp: 2, max: MAX_MONEY, ...o });
const qty = (v, field, o = {}) => num(v, field, { dp: 3, max: MAX_QTY, ...o });
function uuid(v, field, { required = false } = {}) {
  if (!has(v)) {
    if (required) throw new HttpError(400, `${field} is required`, 'VALIDATION_ERROR');
    return null;
  }
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `${field} must be a valid id`, 'VALIDATION_ERROR');
  return v.toLowerCase();
}
function phoneKE(v, field) {
  const s = str(v, field, { max: 20 });
  if (!s) return null;
  let p = s.replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '+254' + p.slice(1);
  else if (/^254[17]\d{8}$/.test(p)) p = '+' + p;
  if (!/^\+254[17]\d{8}$/.test(p)) throw new HttpError(400, `${field} must be a valid Kenyan number`, 'VALIDATION_ERROR');
  return p;
}
const ensureObject = (b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Request body must be a JSON object', 'VALIDATION_ERROR');
  return b;
};

/* ───────────── exact money maths (integer cents / milli-units; BigInt where products can exceed 2^53) ───────────── */
const toCents = (v) => Math.round(v * 100);
const toMilli = (v) => Math.round(v * 1000);
const fromCents = (c) => c / 100;
// qty(milli) x price(cents) / 1000, rounded half-up → cents
const lineCents = (qMilli, pCents) => Number((BigInt(qMilli) * BigInt(pCents) + 500n) / 1000n);
const MAX_CENTS = Math.round(MAX_MONEY * 100);
const MPESA_CODE_RE = /^[A-Z0-9]{10}$/;
const MAX_SALE_LINES = 100;
const SOLD_AT_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // offline sales may be synced up to 90 days late
const SOLD_AT_MAX_FUTURE_MS = 10 * 60 * 1000;     // tolerate small device clock drift

/* ───────────── serializers ───────────── */
const N = (v) => (v === null || v === undefined ? null : Number(v));
const shopOut = (r) => ({
  id: r.id, name: r.name, businessType: r.business_type, phone: r.phone, location: r.location,
  kraPin: r.kra_pin, currency: r.currency, receiptFooter: r.receipt_footer, status: r.status,
  createdAt: r.created_at, updatedAt: r.updated_at
});
const productOut = (r) => {
  const stock = N(r.stock_qty), min = N(r.min_stock);
  const buy = N(r.buying_price), sell = N(r.selling_price);
  return {
    id: r.id, shopId: r.shop_id, name: r.name, barcode: r.barcode, category: r.category, unit: r.unit,
    buyingPrice: buy, sellingPrice: sell, stockQty: stock, minStock: min, isActive: r.is_active,
    isLowStock: stock <= 0 || (min > 0 && stock <= min),
    isOutOfStock: stock <= 0,
    marginPerUnit: Math.round((sell - buy) * 100) / 100,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
};
const movementOut = (r) => ({
  id: r.id, productId: r.product_id, type: r.type, qtyChange: N(r.qty_change), balanceAfter: N(r.balance_after),
  unitCost: N(r.unit_cost), referenceType: r.reference_type, referenceId: r.reference_id, note: r.note,
  clientOpId: r.client_op_id, createdAt: r.created_at
});
const customerOut = (r) => ({
  id: r.id, name: r.name, phone: r.phone, isActive: r.is_active, createdAt: r.created_at,
  outstandingBalance: r.outstanding === undefined ? undefined : N(r.outstanding)
});
const saleOut = (r) => ({
  id: r.id, shopId: r.shop_id, receiptNo: r.receipt_no, customerId: r.customer_id, customerName: r.customer_name,
  subtotal: N(r.subtotal), discountAmount: N(r.discount_amount), total: N(r.total), amountPaid: N(r.amount_paid),
  balanceDue: N(r.balance_due), cogs: N(r.cogs), grossProfit: Math.round((N(r.total) - N(r.cogs)) * 100) / 100,
  paymentStatus: r.payment_status, status: r.status, note: r.note, soldAt: r.sold_at, createdAt: r.created_at
});
const saleItemOut = (r) => ({
  id: r.id, productId: r.product_id, name: r.product_name, unit: r.unit,
  qty: N(r.qty), unitPrice: N(r.unit_price), unitCost: N(r.unit_cost), lineTotal: N(r.line_total)
});
const paymentOut = (r) => ({
  id: r.id, method: r.method, amount: N(r.amount), mpesaReceipt: r.mpesa_receipt, payerPhone: r.payer_phone,
  verification: r.verification, createdAt: r.created_at
});

/* ───────────── router factory (injectable for tests) ───────────── */
function buildRouter(opts = {}) {
  const router = express.Router();
  const getSequelize = opts.getSequelize || (() => require('../models').sequelize);
  // Lazy so merely loading this module never needs JWT config (tests inject their own authenticate).
  const authenticate = opts.authenticate || ((req, res, next) => require('../middleware/auth').authenticateToken(req, res, next));

  const run = (sql, replacements, t) =>
    getSequelize().query(sql, { replacements, type: QueryTypes.SELECT, transaction: t });
  const tx = (fn) => getSequelize().transaction(fn);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  async function audit(t, req, shopId, action, entity, entityId, before, after) {
    await run(
      `INSERT INTO duka_audit_log (shop_id,user_id,action,entity,entity_id,before_data,after_data,ip)
       VALUES (:shopId,:userId,:action,:entity,:entityId,:before::jsonb,:after::jsonb,:ip) RETURNING id`,
      {
        shopId, userId: req.user.id, action, entity, entityId: entityId || null,
        before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null,
        ip: String(req.ip || '').slice(0, 64)
      }, t);
  }

  // Ownership gate: returns the shop only if it belongs to the caller.
  async function ownedShop(req, { write = false, t, lock = false } = {}) {
    const shopId = req.params.shopId;
    if (!UUID_RE.test(shopId || '')) throw new HttpError(404, 'Shop not found', 'SHOP_NOT_FOUND');
    const rows = await run(
      `SELECT * FROM duka_shops WHERE id = :shopId AND owner_id = :userId ${lock ? 'FOR UPDATE' : ''}`,
      { shopId, userId: req.user.id }, t);
    if (!rows[0]) throw new HttpError(404, 'Shop not found', 'SHOP_NOT_FOUND');
    if (write && rows[0].status !== 'active') throw new HttpError(409, 'This shop is archived', 'SHOP_ARCHIVED');
    return rows[0];
  }
  function requireProductId(req) {
    const id = req.params.productId;
    if (!UUID_RE.test(id || '')) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    return id.toLowerCase();
  }

  router.use(authenticate);
  router.use((req, res, next) => {
    if (!req.user || !Number.isInteger(Number(req.user.id))) {
      return res.status(401).json({ success: false, message: 'Authentication required', errorCode: 'UNAUTHORIZED' });
    }
    req.user.id = Number(req.user.id);
    res.set('Cache-Control', 'no-store');
    next();
  });

  /* ───── Shops ───── */
  router.get('/shops', wrap(async (req, res) => {
    const rows = await run(
      `SELECT s.*, (SELECT COUNT(*) FROM duka_products p WHERE p.shop_id = s.id AND p.is_active) AS product_count
         FROM duka_shops s WHERE s.owner_id = :userId AND s.status = 'active' ORDER BY s.created_at ASC`,
      { userId: req.user.id });
    res.json({
      success: true,
      data: { shops: rows.map((r) => ({ ...shopOut(r), productCount: Number(r.product_count) })), maxShops: MAX_SHOPS() }
    });
  }));

  router.post('/shops', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'id');
    const data = {
      name: str(b.name, 'Shop name', { max: 120, required: true }),
      businessType: str(b.businessType, 'Business type', { max: 60 }),
      phone: phoneKE(b.phone, 'Phone'),
      location: str(b.location, 'Location', { max: 160 }),
      kraPin: str(b.kraPin, 'KRA PIN', { max: 20 }),
      receiptFooter: str(b.receiptFooter, 'Receipt footer', { max: 200 })
    };
    const out = await tx(async (t) => {
      // Serialise shop creation per owner so the shop limit cannot be raced past.
      await run('SELECT pg_advisory_xact_lock(:k)', { k: 8800000000 + req.user.id }, t);
      if (id) {
        const ex = (await run('SELECT * FROM duka_shops WHERE id = :id', { id }, t))[0];
        if (ex) {
          if (ex.owner_id !== req.user.id) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
          return { shop: ex, created: false };
        }
      }
      const [{ n }] = await run(
        `SELECT COUNT(*)::int AS n FROM duka_shops WHERE owner_id = :userId AND status = 'active'`, { userId: req.user.id }, t);
      if (n >= MAX_SHOPS()) throw new HttpError(409, `You can have at most ${MAX_SHOPS()} shops`, 'SHOP_LIMIT');
      const [shop] = await run(
        `INSERT INTO duka_shops (id,owner_id,name,business_type,phone,location,kra_pin,receipt_footer)
         VALUES (COALESCE(:id::uuid, gen_random_uuid()),:userId,:name,:businessType,:phone,:location,:kraPin,:receiptFooter)
         RETURNING *`,
        { id, userId: req.user.id, ...data }, t);
      await audit(t, req, shop.id, 'shop.create', 'shop', shop.id, null, shopOut(shop));
      return { shop, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { shop: shopOut(out.shop), idempotent: !out.created } });
  }));

  router.get('/shops/:shopId', wrap(async (req, res) => {
    res.json({ success: true, data: { shop: shopOut(await ownedShop(req)) } });
  }));

  router.patch('/shops/:shopId', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const shop = await tx(async (t) => {
      const before = await ownedShop(req, { write: true, t, lock: true });
      const f = {
        name: 'name' in b ? str(b.name, 'Shop name', { max: 120, required: true }) : before.name,
        business_type: 'businessType' in b ? str(b.businessType, 'Business type', { max: 60 }) : before.business_type,
        phone: 'phone' in b ? phoneKE(b.phone, 'Phone') : before.phone,
        location: 'location' in b ? str(b.location, 'Location', { max: 160 }) : before.location,
        kra_pin: 'kraPin' in b ? str(b.kraPin, 'KRA PIN', { max: 20 }) : before.kra_pin,
        receipt_footer: 'receiptFooter' in b ? str(b.receiptFooter, 'Receipt footer', { max: 200 }) : before.receipt_footer
      };
      const [after] = await run(
        `UPDATE duka_shops SET name=:name,business_type=:business_type,phone=:phone,location=:location,
           kra_pin=:kra_pin,receipt_footer=:receipt_footer,updated_at=NOW() WHERE id=:id RETURNING *`,
        { ...f, id: before.id }, t);
      await audit(t, req, before.id, 'shop.update', 'shop', before.id, shopOut(before), shopOut(after));
      return after;
    });
    res.json({ success: true, data: { shop: shopOut(shop) } });
  }));

  // Shops are archived, never hard-deleted: sales/expense/debt history must survive.
  router.delete('/shops/:shopId', wrap(async (req, res) => {
    await tx(async (t) => {
      const before = await ownedShop(req, { write: true, t, lock: true });
      await run(`UPDATE duka_shops SET status='archived', updated_at=NOW() WHERE id=:id RETURNING id`, { id: before.id }, t);
      await audit(t, req, before.id, 'shop.archive', 'shop', before.id, shopOut(before), { status: 'archived' });
    });
    res.json({ success: true, data: { archived: true } });
  }));

  /* ───── Products ───── */
  router.get('/shops/:shopId/products', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = ['p.shop_id = :shopId'];
    const repl = { shopId: shop.id, limit, offset };
    if (req.query.includeArchived !== 'true') where.push('p.is_active');
    if (has(req.query.search)) {
      repl.search = `%${String(req.query.search).slice(0, 80).replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(p.name ILIKE :search OR p.barcode ILIKE :search OR p.category ILIKE :search)`);
    }
    if (has(req.query.category)) { repl.category = String(req.query.category).slice(0, 80); where.push('lower(p.category) = lower(:category)'); }
    if (req.query.lowStock === 'true') where.push('(p.stock_qty <= 0 OR (p.min_stock > 0 AND p.stock_qty <= p.min_stock))');
    const w = where.join(' AND ');
    const [rows, [{ total }], cats] = await Promise.all([
      run(`SELECT p.* FROM duka_products p WHERE ${w} ORDER BY lower(p.name) ASC LIMIT :limit OFFSET :offset`, repl),
      run(`SELECT COUNT(*)::int AS total FROM duka_products p WHERE ${w}`, repl),
      run(`SELECT DISTINCT category FROM duka_products WHERE shop_id = :shopId AND is_active AND category IS NOT NULL ORDER BY category`, { shopId: shop.id })
    ]);
    res.json({ success: true, data: { products: rows.map(productOut), total, limit, offset, categories: cats.map((c) => c.category) } });
  }));

  router.post('/shops/:shopId/products', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'id');
    const clientOpId = uuid(b.clientOpId, 'clientOpId');
    const d = {
      name: str(b.name, 'Product name', { max: 160, required: true }),
      barcode: str(b.barcode, 'Barcode', { max: 64 }),
      category: str(b.category, 'Category', { max: 80 }),
      unit: str(b.unit, 'Unit', { max: 20 }) || 'piece',
      buyingPrice: money(b.buyingPrice, 'Buying price', { required: true }),
      sellingPrice: money(b.sellingPrice, 'Selling price', { required: true }),
      minStock: qty(b.minStock, 'Minimum stock') || 0,
      openingStock: qty(b.stockQty ?? b.openingStock, 'Available stock') || 0
    };
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      if (id) {
        const ex = (await run('SELECT * FROM duka_products WHERE id = :id', { id }, t))[0];
        if (ex) {
          if (ex.shop_id !== shop.id) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
          return { product: ex, created: false };
        }
      }
      const [product] = await run(
        `INSERT INTO duka_products (id,shop_id,name,barcode,category,unit,buying_price,selling_price,stock_qty,min_stock)
         VALUES (COALESCE(:id::uuid, gen_random_uuid()),:shopId,:name,:barcode,:category,:unit,:buyingPrice,:sellingPrice,:openingStock,:minStock)
         RETURNING *`,
        { id, shopId: shop.id, ...d }, t);
      if (d.openingStock > 0) {
        await run(
          `INSERT INTO duka_stock_movements (shop_id,product_id,type,qty_change,balance_after,unit_cost,note,created_by,client_op_id)
           VALUES (:shopId,:productId,'opening',:q,:q,:cost,'Opening stock',:userId,:op) RETURNING id`,
          { shopId: shop.id, productId: product.id, q: d.openingStock, cost: d.buyingPrice, userId: req.user.id, op: clientOpId }, t);
      }
      await audit(t, req, shop.id, 'product.create', 'product', product.id, null, productOut(product));
      return { product, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { product: productOut(out.product), idempotent: !out.created } });
  }));

  router.get('/shops/:shopId/products/:productId', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const [p] = await run('SELECT * FROM duka_products WHERE id=:id AND shop_id=:shopId', { id: requireProductId(req), shopId: shop.id });
    if (!p) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    res.json({ success: true, data: { product: productOut(p) } });
  }));

  // Edits NEVER touch stock_qty — use POST .../stock so every change lands in the ledger.
  router.patch('/shops/:shopId/products/:productId', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    if ('stockQty' in b) throw new HttpError(400, 'Use the stock adjustment endpoint to change stock', 'USE_STOCK_ENDPOINT');
    const product = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const [before] = await run('SELECT * FROM duka_products WHERE id=:id AND shop_id=:shopId FOR UPDATE',
        { id: requireProductId(req), shopId: shop.id }, t);
      if (!before) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      const f = {
        name: 'name' in b ? str(b.name, 'Product name', { max: 160, required: true }) : before.name,
        barcode: 'barcode' in b ? str(b.barcode, 'Barcode', { max: 64 }) : before.barcode,
        category: 'category' in b ? str(b.category, 'Category', { max: 80 }) : before.category,
        unit: 'unit' in b ? (str(b.unit, 'Unit', { max: 20 }) || 'piece') : before.unit,
        buying: 'buyingPrice' in b ? money(b.buyingPrice, 'Buying price', { required: true }) : before.buying_price,
        selling: 'sellingPrice' in b ? money(b.sellingPrice, 'Selling price', { required: true }) : before.selling_price,
        min: 'minStock' in b ? (qty(b.minStock, 'Minimum stock') || 0) : before.min_stock,
        active: 'isActive' in b ? !!b.isActive : before.is_active
      };
      const [after] = await run(
        `UPDATE duka_products SET name=:name,barcode=:barcode,category=:category,unit=:unit,buying_price=:buying,
           selling_price=:selling,min_stock=:min,is_active=:active,updated_at=NOW() WHERE id=:id RETURNING *`,
        { ...f, id: before.id }, t);
      await audit(t, req, shop.id, 'product.update', 'product', before.id, productOut(before), productOut(after));
      return after;
    });
    res.json({ success: true, data: { product: productOut(product) } });
  }));

  // Delete with transaction-history protection:
  //   no history beyond opening stock → hard delete;  any history → archive (kept for reports).
  router.delete('/shops/:shopId/products/:productId', wrap(async (req, res) => {
    const outcome = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const [p] = await run('SELECT * FROM duka_products WHERE id=:id AND shop_id=:shopId FOR UPDATE',
        { id: requireProductId(req), shopId: shop.id }, t);
      if (!p) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      // Extend this query as later phases add tables that reference products (purchases).
      const [{ n }] = await run(
        `SELECT (SELECT COUNT(*) FROM duka_stock_movements WHERE product_id = :id AND type <> 'opening')::int
              + (SELECT COUNT(*) FROM duka_sale_items WHERE product_id = :id)::int AS n`, { id: p.id }, t);
      if (n > 0) {
        await run('UPDATE duka_products SET is_active=FALSE, updated_at=NOW() WHERE id=:id RETURNING id', { id: p.id }, t);
        await audit(t, req, shop.id, 'product.archive', 'product', p.id, productOut(p), { isActive: false });
        return { archived: true, deleted: false };
      }
      await run('DELETE FROM duka_stock_movements WHERE product_id=:id RETURNING id', { id: p.id }, t);
      await run('DELETE FROM duka_products WHERE id=:id RETURNING id', { id: p.id }, t);
      await audit(t, req, shop.id, 'product.delete', 'product', p.id, productOut(p), null);
      return { archived: false, deleted: true };
    });
    res.json({
      success: true,
      message: outcome.archived ? 'Product has transaction history, so it was archived instead of deleted' : 'Product deleted',
      data: outcome
    });
  }));

  router.post('/shops/:shopId/products/:productId/stock', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const clientOpId = uuid(b.clientOpId, 'clientOpId');
    const change = qty(b.qtyChange, 'Quantity change', { required: true, allowNegative: true });
    if (change === 0) throw new HttpError(400, 'Quantity change cannot be zero', 'VALIDATION_ERROR');
    const type = b.type === 'damage' ? 'damage' : 'adjustment';
    if (type === 'damage' && change > 0) throw new HttpError(400, 'Damaged stock must be a reduction', 'VALIDATION_ERROR');
    const note = str(b.note, 'Note', { max: 240 });
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const [p] = await run('SELECT * FROM duka_products WHERE id=:id AND shop_id=:shopId FOR UPDATE',
        { id: requireProductId(req), shopId: shop.id }, t);
      if (!p) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      if (clientOpId) {
        const [ex] = await run('SELECT * FROM duka_stock_movements WHERE shop_id=:shopId AND client_op_id=:op', { shopId: shop.id, op: clientOpId }, t);
        if (ex) return { product: p, movement: ex, created: false };
      }
      const newBal = Math.round((Number(p.stock_qty) + change) * 1000) / 1000;
      if (newBal < 0) throw new HttpError(409, `Not enough stock: only ${Number(p.stock_qty)} ${p.unit} available`, 'INSUFFICIENT_STOCK');
      const [after] = await run('UPDATE duka_products SET stock_qty=:bal, updated_at=NOW() WHERE id=:id RETURNING *', { bal: newBal, id: p.id }, t);
      const [mv] = await run(
        `INSERT INTO duka_stock_movements (shop_id,product_id,type,qty_change,balance_after,unit_cost,note,created_by,client_op_id)
         VALUES (:shopId,:productId,:type,:change,:bal,:cost,:note,:userId,:op) RETURNING *`,
        { shopId: shop.id, productId: p.id, type, change, bal: newBal, cost: p.buying_price, note, userId: req.user.id, op: clientOpId }, t);
      await audit(t, req, shop.id, 'stock.adjust', 'product', p.id, { stockQty: N(p.stock_qty) }, { stockQty: newBal, change, type, note });
      return { product: after, movement: mv, created: true };
    });
    res.status(out.created ? 201 : 200).json({
      success: true, data: { product: productOut(out.product), movement: movementOut(out.movement), idempotent: !out.created }
    });
  }));

  router.get('/shops/:shopId/products/:productId/movements', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const id = requireProductId(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await run(
      `SELECT * FROM duka_stock_movements WHERE product_id=:id AND shop_id=:shopId ORDER BY created_at DESC, id DESC LIMIT :limit`,
      { id, shopId: shop.id, limit });
    res.json({ success: true, data: { movements: rows.map(movementOut) } });
  }));

  /* ───── Customers (needed so credit / partial-payment sales have a named debtor) ───── */
  router.get('/shops/:shopId/customers', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const repl = { shopId: shop.id, limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500) };
    let w = 'c.shop_id = :shopId AND c.is_active';
    if (has(req.query.search)) {
      repl.search = `%${String(req.query.search).slice(0, 80).replace(/[\\%_]/g, '\\$&')}%`;
      w += ' AND (c.name ILIKE :search OR c.phone ILIKE :search)';
    }
    const rows = await run(
      `SELECT c.*, COALESCE((SELECT SUM(s.balance_due) FROM duka_sales s
                              WHERE s.customer_id = c.id AND s.status = 'completed'), 0) AS outstanding
         FROM duka_customers c WHERE ${w} ORDER BY lower(c.name) ASC LIMIT :limit`, repl);
    res.json({ success: true, data: { customers: rows.map(customerOut) } });
  }));

  router.post('/shops/:shopId/customers', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'id');
    const name = str(b.name, 'Customer name', { max: 120, required: true });
    const phone = phoneKE(b.phone, 'Phone');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true });
      if (id) {
        const ex = (await run('SELECT * FROM duka_customers WHERE id = :id', { id }, t))[0];
        if (ex) {
          if (ex.shop_id !== shop.id) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
          return { customer: ex, created: false };
        }
      }
      const [customer] = await run(
        `INSERT INTO duka_customers (id,shop_id,name,phone) VALUES (COALESCE(:id::uuid, gen_random_uuid()),:shopId,:name,:phone) RETURNING *`,
        { id, shopId: shop.id, name, phone }, t);
      await audit(t, req, shop.id, 'customer.create', 'customer', customer.id, null, customerOut(customer));
      return { customer, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { customer: customerOut(out.customer), idempotent: !out.created } });
  }));

  /* ───── Sales / POS ───── */
  function parseSaleBody(b) {
    const id = uuid(b.id, 'Sale id', { required: true });
    if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, 'Add at least one product to the sale', 'VALIDATION_ERROR');
    if (b.items.length > MAX_SALE_LINES) throw new HttpError(400, `A sale can have at most ${MAX_SALE_LINES} lines`, 'VALIDATION_ERROR');
    const seen = new Set();
    const items = b.items.map((it, i) => {
      const o = ensureObject(it);
      const productId = uuid(o.productId, `Item ${i + 1} product`, { required: true });
      if (seen.has(productId)) throw new HttpError(400, 'The same product appears twice — combine it into one line', 'VALIDATION_ERROR');
      seen.add(productId);
      const q = qty(o.qty, `Item ${i + 1} quantity`, { required: true });
      if (!(q > 0)) throw new HttpError(400, `Item ${i + 1} quantity must be greater than zero`, 'VALIDATION_ERROR');
      const price = has(o.unitPrice) ? money(o.unitPrice, `Item ${i + 1} price`) : null;
      return { productId, qMilli: toMilli(q), priceCents: price === null ? null : toCents(price) };
    });

    let discount = { type: 'amount', cents: 0, pctHundredths: 0 };
    if (has(b.discount)) {
      const d = ensureObject(b.discount);
      if (d.type === 'percent') {
        const pct = num(d.value, 'Discount percent', { dp: 2, max: 100, required: true });
        discount = { type: 'percent', cents: 0, pctHundredths: Math.round(pct * 100) };
      } else if (d.type === 'amount' || d.type === undefined) {
        discount = { type: 'amount', cents: toCents(money(d.value, 'Discount', { required: true })), pctHundredths: 0 };
      } else {
        throw new HttpError(400, 'Discount type must be "amount" or "percent"', 'VALIDATION_ERROR');
      }
    }

    const rawPays = has(b.payments) ? b.payments : [];
    if (!Array.isArray(rawPays) || rawPays.length > 10) throw new HttpError(400, 'Invalid payments', 'VALIDATION_ERROR');
    const codes = new Set();
    const payments = rawPays.map((p, i) => {
      const o = ensureObject(p);
      if (o.method !== 'cash' && o.method !== 'mpesa') throw new HttpError(400, `Payment ${i + 1}: method must be "cash" or "mpesa"`, 'VALIDATION_ERROR');
      const amount = money(o.amount, `Payment ${i + 1} amount`, { required: true });
      if (!(amount > 0)) throw new HttpError(400, `Payment ${i + 1} amount must be greater than zero`, 'VALIDATION_ERROR');
      const out = { method: o.method, cents: toCents(amount), mpesaReceipt: null, payerPhone: null };
      if (o.method === 'mpesa') {
        const code = str(o.mpesaReceipt, 'M-PESA receipt code', { max: 20 });
        const norm = code ? code.toUpperCase().replace(/\s/g, '') : '';
        // Never record an M-PESA payment as received without the receipt code that proves it.
        if (!MPESA_CODE_RE.test(norm)) {
          throw new HttpError(400, 'An M-PESA payment needs the 10-character M-PESA receipt code (e.g. SGH7K2L9QX)', 'MPESA_RECEIPT_REQUIRED');
        }
        if (codes.has(norm)) throw new HttpError(400, 'The same M-PESA receipt code is used twice', 'VALIDATION_ERROR');
        codes.add(norm);
        out.mpesaReceipt = norm;
        out.payerPhone = phoneKE(o.payerPhone, 'Payer phone');
      }
      return out;
    });

    let soldAt = null;
    if (has(b.soldAt)) {
      const d = new Date(b.soldAt);
      if (typeof b.soldAt !== 'string' || Number.isNaN(d.getTime())) throw new HttpError(400, 'soldAt must be a valid date-time', 'VALIDATION_ERROR');
      if (d.getTime() > Date.now() + SOLD_AT_MAX_FUTURE_MS) throw new HttpError(400, 'soldAt cannot be in the future', 'VALIDATION_ERROR');
      if (d.getTime() < Date.now() - SOLD_AT_MAX_AGE_MS) throw new HttpError(400, 'soldAt is too old to record', 'VALIDATION_ERROR');
      soldAt = d.toISOString();
    }
    return {
      id, items, discount, payments, soldAt,
      customerId: uuid(b.customerId, 'customerId'),
      note: str(b.note, 'Note', { max: 240 })
    };
  }

  async function loadSaleDetail(shopId, saleId, t) {
    const [sale] = await run('SELECT * FROM duka_sales WHERE id = :saleId AND shop_id = :shopId', { saleId, shopId }, t);
    if (!sale) return null;
    const [items, payments] = await Promise.all([
      run('SELECT * FROM duka_sale_items WHERE sale_id = :saleId ORDER BY product_name', { saleId }, t),
      run('SELECT * FROM duka_sale_payments WHERE sale_id = :saleId ORDER BY created_at, id', { saleId }, t)
    ]);
    return { sale, items, payments };
  }
  const receiptOut = (shop, d) => ({
    shop: { name: shop.name, phone: shop.phone, location: shop.location, kraPin: shop.kra_pin, receiptFooter: shop.receipt_footer, currency: shop.currency },
    sale: saleOut(d.sale), items: d.items.map(saleItemOut), payments: d.payments.map(paymentOut)
  });

  router.post('/shops/:shopId/sales', wrap(async (req, res) => {
    const b = parseSaleBody(ensureObject(req.body));
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t, lock: true }); // serialises sales per shop (receipt numbers, stock)

      // Idempotency: same sale id → return what was stored, change nothing.
      const [dupe] = await run('SELECT shop_id FROM duka_sales WHERE id = :id', { id: b.id }, t);
      if (dupe) {
        if (dupe.shop_id !== shop.id) throw new HttpError(409, 'This id is already in use', 'ID_CONFLICT');
        return { shop, detail: await loadSaleDetail(shop.id, b.id, t), created: false };
      }

      const ids = b.items.map((i) => i.productId);
      const prods = await run(
        'SELECT * FROM duka_products WHERE shop_id = :shopId AND id IN (:ids) ORDER BY id FOR UPDATE', { shopId: shop.id, ids }, t);
      const byId = new Map(prods.map((p) => [p.id, p]));

      // Price lines, check stock, compute totals — all in integer cents.
      let subtotal = 0, cogs = 0;
      const lines = b.items.map((it) => {
        const p = byId.get(it.productId);
        if (!p) throw new HttpError(404, 'A product in this sale was not found in your shop', 'PRODUCT_NOT_FOUND');
        if (!p.is_active) throw new HttpError(409, `"${p.name}" is archived and cannot be sold`, 'PRODUCT_INACTIVE');
        const stockMilli = toMilli(Number(p.stock_qty));
        if (it.qMilli > stockMilli) {
          throw new HttpError(409, `Not enough stock for "${p.name}": only ${Number(p.stock_qty)} ${p.unit} available`, 'INSUFFICIENT_STOCK');
        }
        const priceCents = it.priceCents === null ? toCents(Number(p.selling_price)) : it.priceCents;
        const costCents = toCents(Number(p.buying_price));
        const lineTotal = lineCents(it.qMilli, priceCents);
        if (lineTotal > MAX_CENTS) throw new HttpError(400, 'A line total is too large', 'VALIDATION_ERROR');
        subtotal += lineTotal;
        cogs += lineCents(it.qMilli, costCents);
        return { it, p, priceCents, costCents, lineTotal, newBal: (stockMilli - it.qMilli) / 1000 };
      });
      if (subtotal > MAX_CENTS) throw new HttpError(400, 'The sale total is too large', 'VALIDATION_ERROR');

      const discountCents = b.discount.type === 'percent'
        ? Number((BigInt(subtotal) * BigInt(b.discount.pctHundredths) + 5000n) / 10000n)
        : b.discount.cents;
      if (discountCents > subtotal) throw new HttpError(400, 'The discount cannot be more than the sale subtotal', 'DISCOUNT_TOO_LARGE');
      const total = subtotal - discountCents;
      if (total <= 0) throw new HttpError(400, 'The sale total must be greater than zero', 'VALIDATION_ERROR');

      const paid = b.payments.reduce((s, p) => s + p.cents, 0);
      if (paid > total) throw new HttpError(400, 'The payments are more than the sale total', 'OVERPAYMENT');
      const balance = total - paid;

      // Credit / partial payment needs a named customer who belongs to THIS shop.
      let customer = null;
      if (b.customerId) {
        [customer] = await run('SELECT * FROM duka_customers WHERE id = :id AND shop_id = :shopId AND is_active', { id: b.customerId, shopId: shop.id }, t);
        if (!customer) throw new HttpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
      }
      if (balance > 0 && !customer) {
        throw new HttpError(400, 'Choose or add the customer who owes the balance (credit and part-payments need a customer)', 'CUSTOMER_REQUIRED');
      }

      // M-PESA evidence: 'verified' only if the code matches a PAID NECPRA STK transaction for >= amount.
      const hasStk = (await run(`SELECT to_regclass('stk_transactions') IS NOT NULL AS ok`, {}, t))[0].ok;
      for (const p of b.payments) {
        p.verification = 'none';
        if (p.method !== 'mpesa') continue;
        p.verification = 'receipt_recorded';
        if (hasStk) {
          const [stk] = await run(
            `SELECT 1 AS ok FROM stk_transactions WHERE mpesa_receipt = :code AND status = 'paid' AND paid_amount >= :amt LIMIT 1`,
            { code: p.mpesaReceipt, amt: fromCents(p.cents) }, t);
          if (stk) p.verification = 'verified';
        }
      }

      const [{ last_no: receiptNo }] = await run(
        `INSERT INTO duka_receipt_counters (shop_id, last_no) VALUES (:shopId, 1)
         ON CONFLICT (shop_id) DO UPDATE SET last_no = duka_receipt_counters.last_no + 1 RETURNING last_no`, { shopId: shop.id }, t);

      const paymentStatus = balance === 0 ? 'paid' : paid === 0 ? 'credit' : 'partial';
      const [sale] = await run(
        `INSERT INTO duka_sales (id,shop_id,receipt_no,customer_id,customer_name,subtotal,discount_amount,total,amount_paid,
                                 balance_due,cogs,payment_status,note,sold_at,created_by)
         VALUES (:id,:shopId,:receiptNo,:customerId,:customerName,:subtotal,:discount,:total,:paid,:balance,:cogs,:status,:note,
                 COALESCE(:soldAt::timestamptz, NOW()),:userId) RETURNING *`,
        {
          id: b.id, shopId: shop.id, receiptNo, customerId: customer ? customer.id : null, customerName: customer ? customer.name : null,
          subtotal: fromCents(subtotal), discount: fromCents(discountCents), total: fromCents(total), paid: fromCents(paid),
          balance: fromCents(balance), cogs: fromCents(cogs), status: paymentStatus, note: b.note, soldAt: b.soldAt, userId: req.user.id
        }, t);

      for (const l of lines) {
        await run(
          `INSERT INTO duka_sale_items (sale_id,shop_id,product_id,product_name,unit,qty,unit_price,unit_cost,line_total)
           VALUES (:saleId,:shopId,:productId,:name,:unit,:qty,:price,:cost,:lineTotal) RETURNING id`,
          {
            saleId: sale.id, shopId: shop.id, productId: l.p.id, name: l.p.name, unit: l.p.unit, qty: l.it.qMilli / 1000,
            price: fromCents(l.priceCents), cost: fromCents(l.costCents), lineTotal: fromCents(l.lineTotal)
          }, t);
        await run('UPDATE duka_products SET stock_qty = :bal, updated_at = NOW() WHERE id = :id RETURNING id', { bal: l.newBal, id: l.p.id }, t);
        await run(
          `INSERT INTO duka_stock_movements (shop_id,product_id,type,qty_change,balance_after,unit_cost,reference_type,reference_id,note,created_by)
           VALUES (:shopId,:productId,'sale',:change,:bal,:cost,'sale',:saleId,:note,:userId) RETURNING id`,
          {
            shopId: shop.id, productId: l.p.id, change: -(l.it.qMilli / 1000), bal: l.newBal, cost: fromCents(l.costCents),
            saleId: sale.id, note: `Sale #${receiptNo}`, userId: req.user.id
          }, t);
      }
      for (const p of b.payments) {
        await run(
          `INSERT INTO duka_sale_payments (sale_id,shop_id,method,amount,mpesa_receipt,payer_phone,verification)
           VALUES (:saleId,:shopId,:method,:amount,:code,:phone,:ver) RETURNING id`,
          { saleId: sale.id, shopId: shop.id, method: p.method, amount: fromCents(p.cents), code: p.mpesaReceipt, phone: p.payerPhone, ver: p.verification }, t);
      }
      await audit(t, req, shop.id, 'sale.create', 'sale', sale.id, null,
        { receiptNo, total: fromCents(total), paid: fromCents(paid), balanceDue: fromCents(balance), lines: lines.length, paymentStatus });
      return { shop, detail: await loadSaleDetail(shop.id, sale.id, t), created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { ...receiptOut(out.shop, out.detail), idempotent: !out.created } });
  }));

  router.get('/shops/:shopId/sales', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = ['s.shop_id = :shopId'];
    const repl = { shopId: shop.id, limit, offset };
    // from / to are Nairobi calendar dates (YYYY-MM-DD), inclusive.
    for (const [key, op] of [['from', '>='], ['to', '<=']]) {
      if (has(req.query[key])) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query[key])) || Number.isNaN(Date.parse(req.query[key]))) {
          throw new HttpError(400, `${key} must be a date like 2026-11-11`, 'VALIDATION_ERROR');
        }
        repl[key] = req.query[key];
        where.push(`(s.sold_at AT TIME ZONE 'Africa/Nairobi')::date ${op} :${key}::date`);
      }
    }
    if (has(req.query.customerId)) { repl.customerId = uuid(req.query.customerId, 'customerId'); where.push('s.customer_id = :customerId'); }
    if (req.query.unpaid === 'true') where.push(`s.balance_due > 0 AND s.status = 'completed'`);
    const w = where.join(' AND ');
    const [rows, [sum]] = await Promise.all([
      run(`SELECT s.* FROM duka_sales s WHERE ${w} ORDER BY s.sold_at DESC, s.receipt_no DESC LIMIT :limit OFFSET :offset`, repl),
      run(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(amount_paid),0) AS paid,
                  COALESCE(SUM(balance_due),0) AS due, COALESCE(SUM(cogs),0) AS cogs
             FROM duka_sales s WHERE ${w} AND s.status = 'completed'`, repl)
    ]);
    res.json({
      success: true,
      data: {
        sales: rows.map(saleOut),
        summary: {
          count: sum.n, total: N(sum.total), amountPaid: N(sum.paid), balanceDue: N(sum.due), cogs: N(sum.cogs),
          grossProfit: Math.round((N(sum.total) - N(sum.cogs)) * 100) / 100
        },
        limit, offset
      }
    });
  }));

  router.get('/shops/:shopId/sales/:saleId', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const saleId = req.params.saleId;
    const detail = UUID_RE.test(saleId || '') ? await loadSaleDetail(shop.id, saleId.toLowerCase()) : null;
    if (!detail) throw new HttpError(404, 'Sale not found', 'SALE_NOT_FOUND');
    res.json({ success: true, data: receiptOut(shop, detail) });
  }));

  /* ───── Dashboard (real data only; sections whose tables arrive in later phases report null, not 0) ───── */
  router.get('/shops/:shopId/dashboard', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const [s] = await run(
      `SELECT COUNT(*)::int AS products,
              COALESCE(SUM(stock_qty),0) AS units,
              COALESCE(SUM(GREATEST(stock_qty,0) * buying_price),0) AS stock_cost,
              COALESCE(SUM(GREATEST(stock_qty,0) * selling_price),0) AS stock_retail,
              COUNT(*) FILTER (WHERE stock_qty <= 0)::int AS out_of_stock,
              COUNT(*) FILTER (WHERE stock_qty > 0 AND min_stock > 0 AND stock_qty <= min_stock)::int AS low_stock
         FROM duka_products WHERE shop_id = :shopId AND is_active`, { shopId: shop.id });
    const low = await run(
      `SELECT * FROM duka_products WHERE shop_id = :shopId AND is_active
          AND (stock_qty <= 0 OR (min_stock > 0 AND stock_qty <= min_stock))
        ORDER BY (stock_qty <= 0) DESC, stock_qty ASC, lower(name) LIMIT 20`, { shopId: shop.id });
    const recent = await run(
      `SELECT m.*, p.name AS product_name FROM duka_stock_movements m JOIN duka_products p ON p.id = m.product_id
        WHERE m.shop_id = :shopId ORDER BY m.created_at DESC, m.id DESC LIMIT 10`, { shopId: shop.id });
    // "Today" is the Nairobi calendar day. Cash/M-PESA received counts only real payments; credit is shown apart.
    const [td] = await run(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(cogs),0) AS cogs,
              COALESCE(SUM(balance_due),0) AS credit
         FROM duka_sales WHERE shop_id = :shopId AND status = 'completed'
          AND (sold_at AT TIME ZONE 'Africa/Nairobi')::date = (NOW() AT TIME ZONE 'Africa/Nairobi')::date`, { shopId: shop.id });
    const rcv = await run(
      `SELECT p.method, p.verification, COALESCE(SUM(p.amount),0) AS amt
         FROM duka_sale_payments p JOIN duka_sales s ON s.id = p.sale_id
        WHERE s.shop_id = :shopId AND s.status = 'completed'
          AND (s.sold_at AT TIME ZONE 'Africa/Nairobi')::date = (NOW() AT TIME ZONE 'Africa/Nairobi')::date
        GROUP BY p.method, p.verification`, { shopId: shop.id });
    const sumRcv = (f) => Math.round(rcv.filter(f).reduce((s, r) => s + N(r.amt), 0) * 100) / 100;
    const [debt] = await run(
      `SELECT COALESCE(SUM(balance_due),0) AS owed, COUNT(*) FILTER (WHERE balance_due > 0)::int AS n
         FROM duka_sales WHERE shop_id = :shopId AND status = 'completed'`, { shopId: shop.id });
    // Phase 5: real expense / supplier / collection figures (Nairobi "today").
    const [ex] = await run(
      `SELECT COALESCE(SUM(amount),0) AS amt FROM duka_expenses WHERE shop_id = :shopId AND status = 'active'
          AND expense_date = (NOW() AT TIME ZONE 'Africa/Nairobi')::date`, { shopId: shop.id });
    const [sup] = await run(
      `SELECT COALESCE(SUM(CASE WHEN type='bill' THEN amount ELSE -amount END),0) AS owed FROM duka_supplier_entries WHERE shop_id = :shopId`, { shopId: shop.id });
    const [col] = await run(
      `SELECT COALESCE(SUM(amount),0) AS amt FROM duka_debt_payments WHERE shop_id = :shopId
          AND (received_at AT TIME ZONE 'Africa/Nairobi')::date = (NOW() AT TIME ZONE 'Africa/Nairobi')::date`, { shopId: shop.id });
    const recentSales = await run(
      `SELECT * FROM duka_sales WHERE shop_id = :shopId AND status = 'completed' ORDER BY sold_at DESC, receipt_no DESC LIMIT 8`, { shopId: shop.id });
    res.json({
      success: true,
      data: {
        shop: shopOut(shop),
        stock: {
          productCount: s.products, totalUnits: N(s.units),
          valueAtCost: Math.round(N(s.stock_cost) * 100) / 100,
          valueAtRetail: Math.round(N(s.stock_retail) * 100) / 100,
          outOfStockCount: s.out_of_stock, lowStockCount: s.low_stock
        },
        lowStockProducts: low.map(productOut),
        recentStockMovements: recent.map((r) => ({ ...movementOut(r), productName: r.product_name })),
        // Phase 2: sales are tracked, so these are real (a genuine 0 when nothing was sold).
        todaySales: {
          count: td.n, total: N(td.total),
          cashReceived: sumRcv((r) => r.method === 'cash'),
          mpesaReceived: sumRcv((r) => r.method === 'mpesa'),
          mpesaVerified: sumRcv((r) => r.method === 'mpesa' && r.verification === 'verified'),
          creditGiven: N(td.credit)
        },
        // Gross profit on today's sales (revenue − cost of goods sold). Expenses are deducted in netProfit (Phase 5).
        estimatedProfit: Math.round((N(td.total) - N(td.cogs)) * 100) / 100,
        customerDebts: { total: N(debt.owed), openSales: debt.n },
        recentSales: recentSales.map(saleOut),
        // Phase 5. estimatedProfit stays GROSS profit; netProfit = gross profit − today's expenses.
        totalExpenses: Math.round(N(ex.amt) * 100) / 100,
        netProfit: Math.round((N(td.total) - N(td.cogs) - N(ex.amt)) * 100) / 100,
        debtCollectedToday: Math.round(N(col.amt) * 100) / 100,
        supplierDebts: Math.round(N(sup.owed) * 100) / 100
      }
    });
  }));

  router.get('/shops/:shopId/audit', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await run(
      `SELECT id,user_id,action,entity,entity_id,created_at FROM duka_audit_log WHERE shop_id=:shopId ORDER BY id DESC LIMIT :limit`,
      { shopId: shop.id, limit });
    res.json({
      success: true,
      data: { entries: rows.map((r) => ({ id: Number(r.id), userId: r.user_id, action: r.action, entity: r.entity, entityId: r.entity_id, createdAt: r.created_at })) }
    });
  }));

  // Phase 5 — expenses, suppliers, debts, collections and daily/weekly/monthly reports.
  require('../services/dukaFinance').mount({
    router, run, tx, wrap, audit, ownedShop, HttpError,
    v: { has, str, money, uuid, phoneKE, ensureObject }
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message, errorCode: err.code });
    if (err && err.original && err.original.code === '23505') {
      const c = String(err.original.constraint || '');
      const message = /sale_payments_receipt/.test(c) ? 'That M-PESA receipt code was already recorded in this shop'
        : /barcode/.test(c) ? 'Another product in this shop already uses that barcode'
        : /debt_payments_receipt/.test(c) ? 'That M-PESA receipt code was already recorded in this shop'
        : /suppliers_shop_name/.test(c) ? 'You already have a supplier with that name'
        : /shops_owner_name/.test(c) ? 'You already have a shop with that name'
        : /products_shop_name/.test(c) ? 'This shop already has a product with that name' : 'Duplicate record';
      return res.status(409).json({ success: false, message, errorCode: 'DUPLICATE' });
    }
    console.error('[duka]', err && err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', errorCode: 'DUKA_INTERNAL' });
  });

  return router;
}

module.exports = buildRouter();
module.exports.buildRouter = buildRouter;
module.exports.HttpError = HttpError;
