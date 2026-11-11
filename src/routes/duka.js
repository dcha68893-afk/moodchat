'use strict';
/**
 * NECPRA DUKA SMART — Phase 1 API (mounted at /api/duka by routes/index.js).
 *
 *   Shops      GET/POST /shops · GET/PATCH/DELETE(archive) /shops/:shopId
 *   Products   GET/POST /shops/:shopId/products · GET/PATCH/DELETE .../products/:id
 *   Stock      POST .../products/:id/stock · GET .../products/:id/movements
 *   Dashboard  GET /shops/:shopId/dashboard
 *   Audit      GET /shops/:shopId/audit
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
      // Extend this query as later phases add tables that reference products (sale items, purchases).
      const [{ n }] = await run(
        `SELECT COUNT(*)::int AS n FROM duka_stock_movements WHERE product_id = :id AND type <> 'opening'`, { id: p.id }, t);
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
        // Filled in by Phases 2–4. null = "not tracked yet" so the UI never shows a made-up zero.
        todaySales: null, estimatedProfit: null, totalExpenses: null, customerDebts: null, supplierDebts: null
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

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message, errorCode: err.code });
    if (err && err.original && err.original.code === '23505') {
      const c = String(err.original.constraint || '');
      const message = /barcode/.test(c) ? 'Another product in this shop already uses that barcode'
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
