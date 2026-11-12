'use strict';
/**
 * NECPRA DUKA SMART — Group Buying (mounted by routes/duka.js under /api/duka/group-buy).
 *
 * Lifecycle:  open → locked (organiser picks ONE verified-supplier quote) → confirmed (every participant has PAID) →
 *             delivered (organiser records quantity received) → completed (every trader has received into stock)
 *             any time before 'confirmed': cancelled (refunds queued for anyone who had paid)
 *
 * Rules that protect traders (enforced here, not just in the UI):
 *  - Prices come ONLY from a supplier quote by a VERIFIED supplier. Nothing is invented; with no quote there is no price and no saving.
 *  - Charges (supplier price, transport share, platform fee) are computed server-side and shown BEFORE a trader confirms.
 *  - A payment counts only when its M-PESA receipt matches a PAID NECPRA STK transaction for at least that amount, and each
 *    receipt can be used once. An unverified code is rejected (nothing is marked paid).
 *  - Stock is added to a trader's inventory only after the organiser records the delivery AND that trader confirms receipt,
 *    at the trader's real cost per unit received (goods + their share of charges).
 *  - Refunds are RECORDED here (duka_gb_refunds, 'pending'). This service does not move money; an admin marks the payout done.
 *  - Savings are only reported against the trader's OWN stated reference price and labelled as such.
 *  - Trader business data is never shown to other traders; the organiser sees only participants' shop name, quantity and status.
 */
const crypto = require('crypto');
const { receiveBatch } = require('./dukaStock');

const MPESA_CODE_RE = /^[A-Z0-9]{10}$/;
const c = (x) => Math.round(Number(x) * 100);         // to cents
const m = (cents) => cents / 100;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const ACTIVE = ['joined', 'confirmed', 'paid', 'received'];
const platformPct = () => Math.min(Math.max(Number(process.env.DUKA_GB_PLATFORM_FEE_PCT || 0), 0), 10);
const adminIds = () => String(process.env.DUKA_ADMIN_IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);

/** Largest-remainder split of `total` cents over weights, so shares always add up exactly. */
function split(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !total) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum), base = raw.map(Math.floor);
  let rest = total - base.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest > 0) { base[i]++; rest--; } });
  return base;
}
/** Charges for a set of quantities at a quote. Pure function: also drives the pre-commitment preview. */
function priceShares(qtys, unitPrice, transportFee, feeSplit) {
  const goods = qtys.map((q) => Math.round(q * unitPrice * 100));
  const platform = goods.map((g) => Math.round((g * platformPct()) / 100));
  const transport = split(c(transportFee), feeSplit === 'equal' ? qtys.map(() => 1) : qtys);
  return qtys.map((q, i) => ({ goods: goods[i], platform: platform[i], transport: transport[i], total: goods[i] + platform[i] + transport[i] }));
}

function mount(ctx) {
  const { router, run, tx, wrap, HttpError, v } = ctx;
  const { has, str, money, qty, uuid, phoneKE, ensureObject } = v;
  const bad = (msg, code) => new HttpError(400, msg, code || 'VALIDATION_ERROR');
  const nf = (what) => new HttpError(404, `${what} not found`, 'NOT_FOUND');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idParam = (req, k) => { if (!UUID.test(req.params[k] || '')) throw nf('Record'); return req.params[k].toLowerCase(); };
  const isAdmin = (req) => adminIds().includes(req.user.id);
  const when = (val, field, { required = false, future = false } = {}) => {
    if (!has(val)) { if (required) throw bad(`${field} is required`); return null; }
    const d = new Date(val); if (isNaN(d)) throw bad(`${field} must be a date and time`);
    if (future && d.getTime() < Date.now() - 60000) throw bad(`${field} must be in the future`);
    return d.toISOString();
  };
  const log = (t, orderId, userId, action, data) => run(
    'INSERT INTO duka_gb_audit (order_id,user_id,action,data) VALUES (:o,:u,:a,:d::jsonb) RETURNING id', { o: orderId, u: userId, a: action, d: data ? JSON.stringify(data) : null }, t);

  async function myShop(req, shopId, t) {
    if (!UUID.test(shopId || '')) throw bad('shopId must be a valid id');
    const [s] = await run(`SELECT * FROM duka_shops WHERE id=:id AND owner_id=:u AND status='active'`, { id: shopId, u: req.user.id }, t);
    if (!s) throw new HttpError(404, 'Shop not found', 'SHOP_NOT_FOUND');
    return s;
  }
  async function supplierOf(req, t, verified = true) {
    const [s] = await run('SELECT * FROM duka_gb_suppliers WHERE user_id=:u', { u: req.user.id }, t);
    if (!s) throw new HttpError(403, 'Register as a supplier first', 'NOT_A_SUPPLIER');
    if (verified && s.status !== 'verified') throw new HttpError(403, 'Your supplier account is not verified yet', 'SUPPLIER_NOT_VERIFIED');
    return s;
  }
  async function getOrder(id, t, lock = false) {
    const [o] = await run(`SELECT * FROM duka_gb_orders WHERE id=:id ${lock ? 'FOR UPDATE' : ''}`, { id }, t);
    if (!o) throw nf('Group order');
    return o;
  }
  const parts = (orderId, t, statuses = ACTIVE) => run(
    `SELECT p.*, s.name AS shop_name FROM duka_gb_participants p JOIN duka_shops s ON s.id=p.shop_id WHERE p.order_id=:o AND p.status = ANY(:st::text[]) ORDER BY p.created_at`,
    { o: orderId, st: `{${statuses.join(',')}}` }, t);
  const netPaid = async (pid, t) => {
    const [r] = await run(`SELECT COALESCE((SELECT SUM(amount) FROM duka_gb_payments WHERE participant_id=:p),0) AS paid,
                                  COALESCE((SELECT SUM(amount) FROM duka_gb_refunds WHERE participant_id=:p),0) AS refunded`, { p: pid }, t);
    return c(r.paid) - c(r.refunded);
  };
  async function refund(t, order, part, cents, reason) {
    if (cents <= 0) return;
    await run('INSERT INTO duka_gb_refunds (order_id,participant_id,amount,reason) VALUES (:o,:p,:a,:r) RETURNING id', { o: order.id, p: part.id, a: m(cents), r: reason }, t);
  }
  const totalQty = async (orderId, t, statuses = ACTIVE) => Number((await run(
    `SELECT COALESCE(SUM(qty),0) AS q FROM duka_gb_participants WHERE order_id=:o AND status = ANY(:st::text[])`, { o: orderId, st: `{${statuses.join(',')}}` }, t))[0].q);

  /** Cancel an order; everyone who has net-paid gets a pending refund row. */
  async function cancelOrder(t, order, reason, userId) {
    for (const p of await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND status <> ALL('{withdrawn,removed}')`, { o: order.id }, t)) {
      const net = await netPaid(p.id, t);
      await refund(t, order, p, net, reason);
      await run(`UPDATE duka_gb_participants SET status=:s WHERE id=:id RETURNING id`, { s: net > 0 ? 'refund_due' : 'removed', id: p.id }, t);
    }
    await run(`UPDATE duka_gb_orders SET status='cancelled', cancel_reason=:r, updated_at=NOW() WHERE id=:id RETURNING id`, { r: reason.slice(0, 240), id: order.id }, t);
    await log(t, order.id, userId, 'order.cancel', { reason });
  }
  /** Re-price a locked order after someone leaves. Overpayments are queued for refund; increases need re-confirmation. */
  async function reprice(t, order, userId) {
    const [q] = await run('SELECT * FROM duka_gb_quotes WHERE id=:id', { id: order.chosen_quote_id }, t);
    const ps = await parts(order.id, t, ['joined', 'confirmed', 'paid']);
    const tot = ps.reduce((a, p) => a + Number(p.qty), 0);
    if (!ps.length || tot < Number(order.min_qty) || tot < Number(q.min_order_qty)) {
      await cancelOrder(t, order, 'Group fell below the minimum quantity', userId);
      return true;
    }
    const sh = priceShares(ps.map((p) => Number(p.qty)), Number(q.unit_price), Number(q.transport_fee), order.fee_split);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i], s = sh[i], net = await netPaid(p.id, t), due = s.total;
      if (net > due) await refund(t, order, p, net - due, 'Group changed; your share is now lower');
      const paidNow = Math.min(net, due) >= due;
      let status = p.status;
      if (due > c(p.amount_due || 0) && c(p.amount_due || 0) > 0) status = 'joined';           // must re-confirm a higher amount
      else if (paidNow) status = 'paid'; else if (status === 'paid') status = 'confirmed';
      await run(`UPDATE duka_gb_participants SET amount_due=:d, goods_cost=:g, fee_share=:f, qty_due=qty, status=:s WHERE id=:id RETURNING id`,
        { d: m(due), g: m(s.goods), f: m(s.platform + s.transport), s: status, id: p.id }, t);
    }
    await log(t, order.id, userId, 'order.reprice', { participants: ps.length, totalQty: tot });
    return false;
  }

  const orderOut = (o, extra) => ({
    id: o.id, productName: o.product_name, category: o.category, unit: o.unit, market: o.market, status: o.status,
    targetPrice: o.target_price == null ? null : Number(o.target_price), minQty: Number(o.min_qty), maxQty: o.max_qty == null ? null : Number(o.max_qty),
    closesAt: o.closes_at, paymentDeadline: o.payment_deadline, expectedDelivery: o.expected_delivery, deliveryMode: o.delivery_mode, feeSplit: o.fee_split,
    cancelReason: o.cancel_reason, receivedQty: o.received_qty == null ? null : Number(o.received_qty), createdAt: o.created_at, ...extra
  });
  const quoteOut = (q, mine) => ({
    id: q.id, supplierId: q.supplier_id, supplierName: q.business_name, unitPrice: Number(q.unit_price), availableQty: Number(q.available_qty),
    minOrderQty: Number(q.min_order_qty), transportFee: Number(q.transport_fee), terms: q.terms, validUntil: q.valid_until, status: q.status, ...(mine || {})
  });
  const partOut = (p) => ({
    id: p.id, shopId: p.shop_id, qty: Number(p.qty), status: p.status, referencePrice: p.reference_price == null ? null : Number(p.reference_price),
    amountDue: p.amount_due == null ? null : Number(p.amount_due), goodsCost: p.goods_cost == null ? null : Number(p.goods_cost),
    chargesShare: p.fee_share == null ? null : Number(p.fee_share), allocatedQty: p.allocated_qty == null ? null : Number(p.allocated_qty)
  });

  // Open orders past their closing time that never reached the minimum are cancelled (nobody has paid at that stage).
  async function sweep() {
    await run(`UPDATE duka_gb_orders o SET status='cancelled', cancel_reason='Closing time passed before the minimum quantity was reached', updated_at=NOW()
      WHERE status='open' AND closes_at < NOW() AND min_qty > COALESCE((SELECT SUM(qty) FROM duka_gb_participants p WHERE p.order_id=o.id AND p.status='joined'),0) RETURNING id`);
  }

  /* ───── suppliers ───── */
  router.post('/group-buy/suppliers', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = uuid(b.id, 'id', { required: true });
    const out = await tx(async (t) => {
      const [ex] = await run('SELECT * FROM duka_gb_suppliers WHERE user_id=:u', { u: req.user.id }, t);
      if (ex) return { s: ex, created: false };
      const [s] = await run(`INSERT INTO duka_gb_suppliers (id,user_id,business_name,phone,location,products) VALUES (:id,:u,:n,:ph,:loc,:pr) RETURNING *`,
        { id, u: req.user.id, n: str(b.businessName, 'Business name', { max: 140, required: true }), ph: phoneKE(b.phone, 'Phone') || (() => { throw bad('Phone is required'); })(),
          loc: str(b.location, 'Location', { max: 160 }), pr: str(b.products, 'Products', { max: 300 }) }, t);
      return { s, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { supplier: { id: out.s.id, businessName: out.s.business_name, status: out.s.status }, note: 'Pending verification. You cannot quote until NECPRA verifies your business.' } });
  }));
  router.get('/group-buy/suppliers/me', wrap(async (req, res) => {
    const [s] = await run('SELECT id,business_name,phone,location,products,status FROM duka_gb_suppliers WHERE user_id=:u', { u: req.user.id });
    res.json({ success: true, data: { supplier: s ? { id: s.id, businessName: s.business_name, phone: s.phone, location: s.location, products: s.products, status: s.status } : null } });
  }));
  const setSupplierStatus = (status) => wrap(async (req, res) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Admins only', 'FORBIDDEN');
    const [s] = await run(`UPDATE duka_gb_suppliers SET status=:st, verified_by=:u, verified_at=NOW() WHERE id=:id RETURNING id,status`, { st: status, u: req.user.id, id: idParam(req, 'supplierId') });
    if (!s) throw nf('Supplier');
    res.json({ success: true, data: { supplier: s } });
  });
  router.post('/group-buy/suppliers/:supplierId/verify', setSupplierStatus('verified'));
  router.post('/group-buy/suppliers/:supplierId/suspend', setSupplierStatus('suspended'));

  /* ───── orders ───── */
  router.post('/group-buy/orders', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = uuid(b.id, 'id', { required: true });
    const unit = str(b.unit, 'Unit', { max: 20, required: true });
    const minQ = has(b.minQty) ? qty(b.minQty, 'Minimum quantity') : 0, maxQ = has(b.maxQty) ? qty(b.maxQty, 'Maximum quantity') : null;
    if (maxQ != null && maxQ < minQ) throw bad('Maximum quantity cannot be below the minimum');
    const closes = when(b.closesAt, 'Closing time', { required: true, future: true });
    const payBy = when(b.paymentDeadline, 'Payment deadline'), expDel = has(b.expectedDelivery) ? String(b.expectedDelivery).slice(0, 10) : null;
    if (payBy && new Date(payBy) < new Date(closes)) throw bad('Payment deadline must be after the closing time');
    const mode = has(b.deliveryMode) ? b.deliveryMode : 'collection', fs = has(b.feeSplit) ? b.feeSplit : 'proportional';
    if (!['collection', 'delivery'].includes(mode)) throw bad('deliveryMode must be collection or delivery');
    if (!['proportional', 'equal'].includes(fs)) throw bad('feeSplit must be proportional or equal');
    const out = await tx(async (t) => {
      const shop = await myShop(req, b.shopId, t);
      const [ex] = await run('SELECT * FROM duka_gb_orders WHERE id=:id', { id }, t);
      if (ex) { if (ex.organiser_id !== req.user.id) throw nf('Group order'); return { o: ex, created: false }; }
      const [o] = await run(
        `INSERT INTO duka_gb_orders (id,organiser_id,organiser_shop_id,product_name,category,unit,market,target_price,min_qty,max_qty,closes_at,payment_deadline,expected_delivery,delivery_mode,fee_split)
         VALUES (:id,:u,:shop,:pn,:cat,:unit,:mk,:tp,:minq,:maxq,:cl,:pd,:ed,:mode,:fs) RETURNING *`,
        { id, u: req.user.id, shop: shop.id, pn: str(b.productName, 'Product name', { max: 160, required: true }), cat: str(b.category, 'Category', { max: 80 }), unit,
          mk: str(b.market, 'Market or delivery location', { max: 160, required: true }), tp: has(b.targetPrice) ? money(b.targetPrice, 'Target price') : null, minq: minQ, maxq: maxQ,
          cl: closes, pd: payBy, ed: expDel, mode, fs }, t);
      await log(t, id, req.user.id, 'order.create', { product: o.product_name, market: o.market });
      if (has(b.qty)) {
        const q = qty(b.qty, 'Your quantity', { required: true }); if (!(q > 0)) throw bad('Your quantity must be greater than zero');
        await run(`INSERT INTO duka_gb_participants (id,order_id,user_id,shop_id,qty,reference_price) VALUES (gen_random_uuid(),:o,:u,:s,:q,:rp) RETURNING id`,
          { o: id, u: req.user.id, s: shop.id, q, rp: has(b.referencePrice) ? money(b.referencePrice, 'Reference price') : null }, t);
      }
      return { o, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { order: orderOut(out.o), idempotent: !out.created } });
  }));

  router.get('/group-buy/orders', wrap(async (req, res) => {
    await sweep();
    const status = has(req.query.status) ? String(req.query.status) : 'open';
    const mk = has(req.query.market) ? `%${String(req.query.market).slice(0, 60).toLowerCase()}%` : '%';
    const rows = await run(
      `SELECT o.*, COALESCE((SELECT SUM(qty) FROM duka_gb_participants p WHERE p.order_id=o.id AND p.status IN ('joined','confirmed','paid','received')),0) AS total_qty,
              (SELECT COUNT(*) FROM duka_gb_participants p WHERE p.order_id=o.id AND p.status IN ('joined','confirmed','paid','received'))::int AS n,
              (SELECT MIN(q.unit_price) FROM duka_gb_quotes q WHERE q.order_id=o.id AND q.status IN ('active','chosen')) AS best_price,
              EXISTS (SELECT 1 FROM duka_gb_participants p WHERE p.order_id=o.id AND p.user_id=:u AND p.status NOT IN ('withdrawn','removed')) AS joined
       FROM duka_gb_orders o WHERE o.status=:st AND lower(o.market) LIKE :mk ORDER BY o.closes_at LIMIT 100`, { st: status, mk, u: req.user.id });
    res.json({ success: true, data: { orders: rows.map((o) => orderOut(o, {
      combinedQty: Number(o.total_qty), participants: o.n, needsMoreQty: Math.max(0, Number(o.min_qty) - Number(o.total_qty)), bestQuotedPrice: o.best_price == null ? null : Number(o.best_price), joinedByMe: o.joined, organisedByMe: o.organiser_id === req.user.id })) } });
  }));

  router.get('/group-buy/orders/:orderId', wrap(async (req, res) => {
    await sweep();
    const id = idParam(req, 'orderId'), o = await getOrder(id);
    const mine = (await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status NOT IN ('withdrawn','removed') `, { o: id, u: req.user.id }))[0];
    const [sup] = await run('SELECT id FROM duka_gb_suppliers WHERE user_id=:u', { u: req.user.id });
    const isOrg = o.organiser_id === req.user.id;
    const ps = await parts(id, null);
    const tot = ps.reduce((a, p) => a + Number(p.qty), 0);
    const quotes = await run(`SELECT q.*, s.business_name FROM duka_gb_quotes q JOIN duka_gb_suppliers s ON s.id=q.supplier_id WHERE q.order_id=:o AND q.status IN ('active','chosen') ORDER BY q.unit_price`, { o: id });
    const myQty = mine ? Number(mine.qty) : null;
    const qs = quotes.filter((q) => isOrg || mine || o.status === 'open' || (sup && q.supplier_id === sup.id)).map((q) => {
      let preview = null;
      if (myQty) {
        // The charges this trader would pay if the order locked at the current group size (all charges shown before committing).
        const all = ps.map((p) => Number(p.qty)), idx = ps.findIndex((p) => p.user_id === req.user.id);
        const s = priceShares(all, Number(q.unit_price), Number(q.transport_fee), o.fee_split)[idx];
        preview = { goods: m(s.goods), transportShare: m(s.transport), platformFee: m(s.platform), totalPayable: m(s.total),
          groupSizeUsed: r3(tot), meetsMinimum: tot >= Number(o.min_qty) && tot >= Number(q.min_order_qty),
          savingVsYourReferencePrice: mine.reference_price == null ? null : m(Math.round(myQty * Number(mine.reference_price) * 100) - s.total),
          savingNote: mine.reference_price == null ? 'Add your usual price to see a comparison. Nothing is claimed without it.' : 'Estimate against the price YOU entered; it becomes a recorded result only after delivery.' };
      }
      return quoteOut(q, { isMine: !!(sup && sup.id === q.supplier_id), yourCostPreview: preview });
    });
    res.json({ success: true, data: {
      order: orderOut(o, { combinedQty: r3(tot), participants: ps.length, needsMoreQty: Math.max(0, r3(Number(o.min_qty) - tot)), chosenQuoteId: o.chosen_quote_id, isOrganiser: isOrg }),
      quotes: qs,
      you: mine ? partOut(mine) : null,
      participants: isOrg ? ps.map((p) => ({ ...partOut(p), shopName: p.shop_name, amountDue: undefined, goodsCost: undefined, chargesShare: undefined, referencePrice: undefined })) : undefined
    } });
  }));

  router.get('/group-buy/orders/:orderId/recommendation', wrap(async (req, res) => {
    const o = await getOrder(idParam(req, 'orderId'));
    const shop = await myShop(req, String(req.query.shopId || ''));
    const a = await ctx.waste.analyse(shop.id);
    const it = a.items.find((x) => x.name.toLowerCase() === o.product_name.toLowerCase());
    if (!it) return res.json({ success: true, data: { recommendedQty: null, message: 'No sales or stock history for this product in your shop yet, so no recommendation. Choose the quantity you can sell.', canOverride: true } });
    res.json({ success: true, data: { recommendedQty: it.reorder.suggestedQty, unit: o.unit, currentStock: it.stockQty, recentDailyDemand: it.reorder.recentDailyDemand,
      recentSpoilageRatePct: it.reorder.recentSpoilageRatePct, reason: it.reorder.reason, confidence: it.reorder.confidence, estimate: true, canOverride: true } });
  }));

  router.post('/group-buy/orders/:orderId/join', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId');
    const q = qty(b.qty, 'Quantity', { required: true }); if (!(q > 0)) throw bad('Quantity must be greater than zero');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      const shop = await myShop(req, b.shopId, t);
      if (o.status !== 'open') throw new HttpError(409, 'This order is no longer open', 'ORDER_NOT_OPEN');
      if (new Date(o.closes_at) < new Date()) throw new HttpError(409, 'This order has closed', 'ORDER_CLOSED');
      const [ex] = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status NOT IN ('withdrawn','removed')`, { o: id, u: req.user.id }, t);
      const others = (await totalQty(id, t)) - (ex ? Number(ex.qty) : 0);
      if (o.max_qty != null && others + q > Number(o.max_qty)) throw new HttpError(409, `Only ${r3(Number(o.max_qty) - others)} ${o.unit} left in this order`, 'ORDER_FULL');
      const rp = has(b.referencePrice) ? money(b.referencePrice, 'Reference price') : null;
      let p;
      if (ex) [p] = await run('UPDATE duka_gb_participants SET qty=:q, shop_id=:s, reference_price=COALESCE(:rp,reference_price) WHERE id=:id RETURNING *', { q, s: shop.id, rp, id: ex.id }, t);
      else [p] = await run('INSERT INTO duka_gb_participants (id,order_id,user_id,shop_id,qty,reference_price) VALUES (gen_random_uuid(),:o,:u,:s,:q,:rp) RETURNING *', { o: id, u: req.user.id, s: shop.id, q, rp }, t);
      await log(t, id, req.user.id, ex ? 'participant.update' : 'participant.join', { qty: q });
      return { p, updated: !!ex };
    });
    res.status(out.updated ? 200 : 201).json({ success: true, data: { you: partOut(out.p) } });
  }));

  router.post('/group-buy/orders/:orderId/withdraw', wrap(async (req, res) => {
    const id = idParam(req, 'orderId');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      const [p] = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status IN ('joined','confirmed','paid') FOR UPDATE`, { o: id, u: req.user.id }, t);
      if (!p) throw nf('Your participation');
      if (!['open', 'locked'].includes(o.status)) throw new HttpError(409, 'You cannot withdraw once the order is confirmed with the supplier. Raise a dispute instead.', 'WITHDRAW_NOT_ALLOWED');
      const net = await netPaid(p.id, t);
      await refund(t, o, p, net, 'You withdrew before order confirmation');
      await run(`UPDATE duka_gb_participants SET status=:s WHERE id=:id RETURNING id`, { s: net > 0 ? 'refund_due' : 'withdrawn', id: p.id }, t);
      await log(t, id, req.user.id, 'participant.withdraw', { refundCents: net });
      let cancelled = false;
      if (o.status === 'locked') cancelled = await reprice(t, o, req.user.id);
      return { refund: m(net), orderCancelled: cancelled };
    });
    res.json({ success: true, data: out });
  }));

  /* ───── quotes ───── */
  router.post('/group-buy/orders/:orderId/quotes', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId'), qid = uuid(b.id, 'id', { required: true });
    const price = money(b.unitPrice, 'Unit price', { required: true }); if (!(price > 0)) throw bad('Unit price must be greater than zero');
    const avail = qty(b.availableQty, 'Available quantity', { required: true }); if (!(avail > 0)) throw bad('Available quantity must be greater than zero');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true), sup = await supplierOf(req, t);
      const [ex] = await run('SELECT q.*, s.business_name FROM duka_gb_quotes q JOIN duka_gb_suppliers s ON s.id=q.supplier_id WHERE q.id=:id', { id: qid }, t);
      if (ex) { if (ex.supplier_id !== sup.id) throw nf('Quote'); return { q: ex, created: false }; }
      if (o.status !== 'open') throw new HttpError(409, 'Quotes can only be added while the order is open', 'ORDER_NOT_OPEN');
      await run(`UPDATE duka_gb_quotes SET status='changed' WHERE order_id=:o AND supplier_id=:s AND status='active' RETURNING id`, { o: id, s: sup.id }, t);
      const [q] = await run(
        `INSERT INTO duka_gb_quotes (id,order_id,supplier_id,unit_price,available_qty,min_order_qty,transport_fee,terms,valid_until) VALUES (:id,:o,:s,:p,:a,:mo,:tf,:terms,:vu) RETURNING *`,
        { id: qid, o: id, s: sup.id, p: price, a: avail, mo: has(b.minOrderQty) ? qty(b.minOrderQty, 'Minimum order quantity') : 0,
          tf: has(b.transportFee) ? money(b.transportFee, 'Transport fee') : 0, terms: str(b.terms, 'Terms', { max: 300 }), vu: when(b.validUntil, 'Valid until') }, t);
      await log(t, id, req.user.id, 'quote.create', { quoteId: qid, price, supplier: sup.business_name });
      return { q: { ...q, business_name: sup.business_name }, created: true };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { quote: quoteOut(out.q) } });
  }));

  /** A supplier withdraws/rejects. If their quote was chosen, the order is cancelled and every payer is queued for refund. */
  router.post('/group-buy/quotes/:quoteId/withdraw', wrap(async (req, res) => {
    const qid = idParam(req, 'quoteId');
    const out = await tx(async (t) => {
      const sup = await supplierOf(req, t, false);
      const [q] = await run(`SELECT * FROM duka_gb_quotes WHERE id=:id AND supplier_id=:s FOR UPDATE`, { id: qid, s: sup.id }, t);
      if (!q) throw nf('Quote');
      const o = await getOrder(q.order_id, t, true);
      if (['delivered', 'completed', 'cancelled'].includes(o.status)) throw new HttpError(409, 'This order can no longer be changed', 'ORDER_FINAL');
      await run(`UPDATE duka_gb_quotes SET status='withdrawn' WHERE id=:id RETURNING id`, { id: qid }, t);
      if (o.chosen_quote_id === qid) await cancelOrder(t, o, 'The supplier could not fulfil the order', req.user.id);
      await log(t, o.id, req.user.id, 'quote.withdraw', { quoteId: qid });
      return { orderCancelled: o.chosen_quote_id === qid };
    });
    res.json({ success: true, data: out });
  }));

  /* ───── lock → confirm → pay → confirm order ───── */
  router.post('/group-buy/orders/:orderId/lock', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId'), qid = uuid(b.quoteId, 'quoteId', { required: true });
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      if (o.organiser_id !== req.user.id) throw new HttpError(403, 'Only the organiser can do this', 'FORBIDDEN');
      if (o.status !== 'open') throw new HttpError(409, 'Order is not open', 'ORDER_NOT_OPEN');
      const [q] = await run(`SELECT q.*, s.status AS sup_status FROM duka_gb_quotes q JOIN duka_gb_suppliers s ON s.id=q.supplier_id WHERE q.id=:id AND q.order_id=:o AND q.status='active' FOR UPDATE OF q`, { id: qid, o: id }, t);
      if (!q) throw nf('Active quote');
      if (q.sup_status !== 'verified') throw new HttpError(409, 'That supplier is not verified', 'SUPPLIER_NOT_VERIFIED');
      if (q.valid_until && new Date(q.valid_until) < new Date()) throw new HttpError(409, 'That quote has expired', 'QUOTE_EXPIRED');
      const tot = await totalQty(id, t, ['joined']);
      if (tot < Number(o.min_qty)) throw new HttpError(409, `The group needs ${o.min_qty} ${o.unit} but has ${r3(tot)}`, 'MINIMUM_NOT_REACHED');
      if (tot < Number(q.min_order_qty)) throw new HttpError(409, `The supplier's minimum order is ${q.min_order_qty} ${o.unit}`, 'SUPPLIER_MINIMUM_NOT_REACHED');
      if (tot > Number(q.available_qty)) throw new HttpError(409, `The supplier only has ${q.available_qty} ${o.unit} available; reduce the order`, 'EXCEEDS_SUPPLY');
      await run(`UPDATE duka_gb_quotes SET status='chosen' WHERE id=:id RETURNING id`, { id: qid }, t);
      await run(`UPDATE duka_gb_quotes SET status='rejected' WHERE order_id=:o AND id<>:id AND status='active' RETURNING id`, { o: id, id: qid }, t);
      await run(`UPDATE duka_gb_orders SET status='locked', chosen_quote_id=:q, updated_at=NOW() WHERE id=:id RETURNING id`, { q: qid, id }, t);
      const ps = await parts(id, t, ['joined']);
      const sh = priceShares(ps.map((p) => Number(p.qty)), Number(q.unit_price), Number(q.transport_fee), o.fee_split);
      for (let i = 0; i < ps.length; i++) {
        await run(`UPDATE duka_gb_participants SET amount_due=:d, goods_cost=:g, fee_share=:f, qty_due=qty WHERE id=:id RETURNING id`, { d: m(sh[i].total), g: m(sh[i].goods), f: m(sh[i].platform + sh[i].transport), id: ps[i].id }, t);
      }
      await log(t, id, req.user.id, 'order.lock', { quoteId: qid, totalQty: tot });
      return { totalQty: r3(tot) };
    });
    res.json({ success: true, data: out });
  }));

  router.post('/group-buy/orders/:orderId/participants/me/confirm', wrap(async (req, res) => {
    const id = idParam(req, 'orderId');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      if (o.status !== 'locked') throw new HttpError(409, 'The order is not waiting for confirmations', 'ORDER_NOT_LOCKED');
      const [p] = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status IN ('joined','confirmed','paid') FOR UPDATE`, { o: id, u: req.user.id }, t);
      if (!p) throw nf('Your participation');
      const seen = has(req.body && req.body.amountDue) ? money(req.body.amountDue, 'Amount due', { required: true }) : null;
      if (seen == null || c(seen) !== c(p.amount_due)) throw new HttpError(409, `Please confirm the amount you were shown: it is currently KSh ${Number(p.amount_due).toFixed(2)}`, 'AMOUNT_MISMATCH');
      if (p.status === 'joined') await run(`UPDATE duka_gb_participants SET status=CASE WHEN :net >= :due THEN 'paid' ELSE 'confirmed' END WHERE id=:id RETURNING id`, { net: await netPaid(p.id, t), due: c(p.amount_due), id: p.id }, t);
      await log(t, id, req.user.id, 'participant.confirm', { amountDue: seen });
      return p;
    });
    res.json({ success: true, data: { amountDue: Number(out.amount_due) } });
  }));

  router.post('/group-buy/orders/:orderId/pay', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId'), payId = uuid(b.id, 'id', { required: true });
    const amount = money(b.amount, 'Amount', { required: true }); if (!(amount > 0)) throw bad('Amount must be greater than zero');
    const code = String(b.mpesaReceipt || '').trim().toUpperCase();
    if (!MPESA_CODE_RE.test(code)) throw bad('Enter the 10-character M-PESA receipt code');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      const [dup] = await run('SELECT * FROM duka_gb_payments WHERE id=:id', { id: payId }, t);
      if (dup) return { status: 200, pay: dup };
      if (o.status !== 'locked') throw new HttpError(409, 'Payments are only accepted while the order is awaiting payment', 'ORDER_NOT_LOCKED');
      const [p] = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status='confirmed' FOR UPDATE`, { o: id, u: req.user.id }, t);
      if (!p) throw new HttpError(409, 'Confirm your amount first, or your share is already fully paid', 'NOT_READY_TO_PAY');
      const owing = c(p.amount_due) - await netPaid(p.id, t);
      if (c(amount) > owing) throw new HttpError(409, `You only owe KSh ${m(owing).toFixed(2)}`, 'OVERPAYMENT');
      const [used] = await run('SELECT 1 AS x FROM duka_gb_payments WHERE mpesa_receipt=:c', { c: code }, t);
      if (used) throw new HttpError(409, 'That M-PESA receipt was already used', 'RECEIPT_USED');
      let ok = []; // Counted ONLY if it matches a PAID NECPRA STK transaction for at least this amount.
      try { ok = await run(`SELECT 1 AS ok FROM stk_transactions WHERE mpesa_receipt=:c AND status='paid' AND paid_amount >= :a LIMIT 1`, { c: code, a: amount }, t); } catch (_) { ok = []; }
      if (!ok[0]) throw new HttpError(409, `M-PESA receipt ${code} could not be confirmed as a paid NECPRA payment of KSh ${amount.toFixed(2)}. Nothing was recorded.`, 'MPESA_NOT_VERIFIED');
      const [pay] = await run('INSERT INTO duka_gb_payments (id,order_id,participant_id,amount,mpesa_receipt) VALUES (:id,:o,:p,:a,:c) RETURNING *', { id: payId, o: id, p: p.id, a: amount, c: code }, t);
      const net = await netPaid(p.id, t);
      if (net >= c(p.amount_due)) await run(`UPDATE duka_gb_participants SET status='paid' WHERE id=:id RETURNING id`, { id: p.id }, t);
      await log(t, id, req.user.id, 'payment.verified', { amount, receipt: code });
      return { status: 201, pay, fullyPaid: net >= c(p.amount_due), remaining: m(Math.max(0, c(p.amount_due) - net)) };
    });
    res.status(out.status).json({ success: true, data: { paymentId: out.pay.id, amount: Number(out.pay.amount), fullyPaid: out.fullyPaid, remaining: out.remaining } });
  }));

  router.post('/group-buy/orders/:orderId/expire-unpaid', wrap(async (req, res) => {
    const id = idParam(req, 'orderId');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      if (o.organiser_id !== req.user.id) throw new HttpError(403, 'Only the organiser can do this', 'FORBIDDEN');
      if (o.status !== 'locked') throw new HttpError(409, 'Order is not awaiting payment', 'ORDER_NOT_LOCKED');
      if (!o.payment_deadline || new Date(o.payment_deadline) > new Date()) throw new HttpError(409, 'The payment deadline has not passed', 'DEADLINE_NOT_PASSED');
      const late = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND status IN ('joined','confirmed') FOR UPDATE`, { o: id }, t);
      for (const p of late) {
        const net = await netPaid(p.id, t);
        await refund(t, o, p, net, 'Payment not completed by the deadline');
        await run(`UPDATE duka_gb_participants SET status=:s WHERE id=:id RETURNING id`, { s: net > 0 ? 'refund_due' : 'removed', id: p.id }, t);
      }
      const cancelled = late.length ? await reprice(t, o, req.user.id) : false;
      await log(t, id, req.user.id, 'order.expire_unpaid', { removed: late.length });
      return { removed: late.length, orderCancelled: cancelled };
    });
    res.json({ success: true, data: out });
  }));

  router.post('/group-buy/orders/:orderId/confirm', wrap(async (req, res) => {
    const id = idParam(req, 'orderId');
    await tx(async (t) => {
      const o = await getOrder(id, t, true);
      if (o.organiser_id !== req.user.id) throw new HttpError(403, 'Only the organiser can do this', 'FORBIDDEN');
      if (o.status !== 'locked') throw new HttpError(409, 'Order is not awaiting confirmation', 'ORDER_NOT_LOCKED');
      const ps = await parts(id, t, ['joined', 'confirmed', 'paid']);
      if (!ps.length || ps.some((p) => p.status !== 'paid')) throw new HttpError(409, 'Every participant must have paid before the order can be confirmed', 'PAYMENTS_INCOMPLETE');
      for (const p of ps) if ((await netPaid(p.id, t)) < c(p.amount_due)) throw new HttpError(409, 'A payment is short; the order cannot be confirmed', 'PAYMENTS_INCOMPLETE');
      await run(`UPDATE duka_gb_orders SET status='confirmed', updated_at=NOW() WHERE id=:id RETURNING id`, { id }, t);
      await log(t, id, req.user.id, 'order.confirm', { participants: ps.length });
    });
    res.json({ success: true, data: { status: 'confirmed' } });
  }));

  router.post('/group-buy/orders/:orderId/cancel', wrap(async (req, res) => {
    const id = idParam(req, 'orderId'), reason = str((req.body || {}).reason, 'Reason', { max: 200 }) || 'Cancelled by the organiser';
    await tx(async (t) => {
      const o = await getOrder(id, t, true);
      if (o.organiser_id !== req.user.id) throw new HttpError(403, 'Only the organiser can do this', 'FORBIDDEN');
      if (!['open', 'locked'].includes(o.status)) throw new HttpError(409, 'This order can no longer be cancelled; raise a dispute instead', 'ORDER_FINAL');
      await cancelOrder(t, o, reason, req.user.id);
    });
    res.json({ success: true, data: { status: 'cancelled' } });
  }));

  /* ───── delivery, allocation, stock ───── */
  router.post('/group-buy/orders/:orderId/delivery', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId');
    const got = qty(b.receivedQty, 'Received quantity', { required: true }); if (!(got > 0)) throw bad('Received quantity must be greater than zero');
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      if (o.organiser_id !== req.user.id) throw new HttpError(403, 'Only the organiser can do this', 'FORBIDDEN');
      if (o.status !== 'confirmed') throw new HttpError(409, 'Delivery can only be recorded for a confirmed (fully paid) order', 'ORDER_NOT_CONFIRMED');
      const ps = await parts(id, t, ['paid']);
      const ordered = ps.reduce((a, p) => a + Number(p.qty), 0);
      const usable = Math.min(got, ordered);
      // Shortfall is shared in proportion to each trader's quantity (largest remainder, exact to 0.001).
      const units = split(Math.round(usable * 1000), ps.map((p) => Number(p.qty)));
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i], alloc = units[i] / 1000, ratio = alloc / Number(p.qty);
        const goodsNew = Math.round(c(p.goods_cost) * ratio);
        await refund(t, o, p, c(p.goods_cost) - goodsNew, 'Shortage on delivery: refund for goods not received');
        await run(`UPDATE duka_gb_participants SET allocated_qty=:a, goods_cost=:g, allocated_at=NOW() WHERE id=:id RETURNING id`, { a: alloc, g: m(goodsNew), id: p.id }, t);
      }
      const short = got < ordered - 0.0005;
      await run(`UPDATE duka_gb_orders SET status='delivered', received_qty=:q, delivery_note=:n, updated_at=NOW() WHERE id=:id RETURNING id`, { q: got, n: str(b.note, 'Note', { max: 300 }), id }, t);
      await log(t, id, req.user.id, 'order.delivery', { ordered: r3(ordered), received: got, shortage: short });
      return { ordered: r3(ordered), received: got, shortage: short ? r3(ordered - got) : 0, note: short ? 'Shortage shared proportionally. Refunds for goods not received are queued.' : null };
    });
    res.json({ success: true, data: out });
  }));

  router.post('/group-buy/orders/:orderId/receive', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId'), batchId = uuid(b.id, 'id', { required: true });
    const out = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      const [p] = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status IN ('paid','received') FOR UPDATE`, { o: id, u: req.user.id }, t);
      if (!p) throw nf('Your participation');
      if (p.status === 'received') { const [bt] = await run('SELECT * FROM duka_stock_batches WHERE id=:id', { id: batchId }, t); return { batch: bt, created: false }; }
      if (!['delivered', 'disputed'].includes(o.status) || p.allocated_qty == null) throw new HttpError(409, 'Stock is added only after the organiser records the delivery', 'DELIVERY_NOT_RECORDED');
      let productId = has(b.productId) ? uuid(b.productId, 'productId') : null;
      if (!productId) {
        const found = await run(`SELECT id FROM duka_products WHERE shop_id=:s AND lower(name)=lower(:n) AND is_active`, { s: p.shop_id, n: o.product_name }, t);
        if (found.length !== 1) throw bad(`Choose which product in your shop this is (no single product named "${o.product_name}" found)`, 'PRODUCT_REQUIRED');
        productId = found[0].id;
      }
      const alloc = Number(p.allocated_qty);
      if (!(alloc > 0)) throw new HttpError(409, 'You received nothing from this delivery', 'NOTHING_TO_RECEIVE');
      const unitCost = Math.round(((c(p.goods_cost) + c(p.fee_share)) / alloc)) / 100;
      const r = await receiveBatch(run, t, { shopId: p.shop_id, productId, batchId, qty: alloc, unitCost, source: 'group_buy', sourceRef: p.id, userId: req.user.id,
        shelfLifeDays: has(b.shelfLifeDays) ? qty(b.shelfLifeDays, 'Shelf life (days)') : null, batchRef: `GB-${id.slice(0, 8)}`, condition: str(b.condition, 'Condition', { max: 160 }), note: `Group buy: ${o.product_name}` });
      await run(`UPDATE duka_gb_participants SET status='received' WHERE id=:id RETURNING id`, { id: p.id }, t);
      await log(t, id, req.user.id, 'participant.receive', { qty: alloc, unitCost });
      const left = await run(`SELECT 1 FROM duka_gb_participants WHERE order_id=:o AND status='paid' LIMIT 1`, { o: id }, t);
      if (!left.length && o.status === 'delivered') await run(`UPDATE duka_gb_orders SET status='completed', updated_at=NOW() WHERE id=:id RETURNING id`, { id }, t);
      return { batch: r.batch, created: r.created, unitCost };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { batchId: out.batch.id, qtyAdded: Number(out.batch.qty_received), unitCost: Number(out.batch.unit_cost) } });
  }));

  /* ───── disputes, refunds, dashboard, audit ───── */
  router.post('/group-buy/orders/:orderId/disputes', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idParam(req, 'orderId'), did = uuid(b.id, 'id', { required: true });
    if (!['shortage', 'damaged', 'quality', 'late', 'other'].includes(b.kind)) throw bad('kind must be shortage, damaged, quality, late or other');
    const d = await tx(async (t) => {
      const o = await getOrder(id, t, true);
      const [mine] = await run(`SELECT 1 AS x FROM duka_gb_participants WHERE order_id=:o AND user_id=:u`, { o: id, u: req.user.id }, t);
      if (!mine && o.organiser_id !== req.user.id) throw nf('Group order');
      const [ex] = await run('SELECT * FROM duka_gb_disputes WHERE id=:id AND order_id=:o', { id: did, o: id }, t);
      if (ex) return ex;
      const [row] = await run('INSERT INTO duka_gb_disputes (id,order_id,raised_by,kind,details) VALUES (:id,:o,:u,:k,:d) RETURNING *', { id: did, o: id, u: req.user.id, k: b.kind, d: str(b.details, 'Details', { max: 400, required: true }) }, t);
      if (['confirmed', 'delivered'].includes(o.status)) await run(`UPDATE duka_gb_orders SET status='disputed', updated_at=NOW() WHERE id=:id RETURNING id`, { id }, t);
      await log(t, id, req.user.id, 'dispute.open', { kind: b.kind });
      return row;
    });
    res.status(201).json({ success: true, data: { dispute: { id: d.id, kind: d.kind, status: d.status } } });
  }));
  router.post('/group-buy/disputes/:disputeId/resolve', wrap(async (req, res) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Admins only', 'FORBIDDEN');
    await tx(async (t) => {
      const [d] = await run(`UPDATE duka_gb_disputes SET status='resolved' WHERE id=:id RETURNING *`, { id: idParam(req, 'disputeId') }, t);
      if (!d) throw nf('Dispute');
      const open = await run(`SELECT 1 FROM duka_gb_disputes WHERE order_id=:o AND status='open' LIMIT 1`, { o: d.order_id }, t);
      if (!open.length) await run(`UPDATE duka_gb_orders SET status=CASE WHEN received_qty IS NULL THEN 'confirmed' ELSE 'delivered' END, updated_at=NOW() WHERE id=:o AND status='disputed' RETURNING id`, { o: d.order_id }, t);
      await log(t, d.order_id, req.user.id, 'dispute.resolve', { disputeId: d.id });
    });
    res.json({ success: true, data: { resolved: true } });
  }));
  router.get('/group-buy/refunds', wrap(async (req, res) => {
    const rows = await run(`SELECT r.*, o.product_name FROM duka_gb_refunds r JOIN duka_gb_participants p ON p.id=r.participant_id JOIN duka_gb_orders o ON o.id=r.order_id WHERE p.user_id=:u ORDER BY r.created_at DESC`, { u: req.user.id });
    res.json({ success: true, data: { refunds: rows.map((r) => ({ id: r.id, orderId: r.order_id, product: r.product_name, amount: Number(r.amount), reason: r.reason, status: r.status, payoutRef: r.payout_ref })),
      note: 'Refunds are recorded here and paid out by NECPRA staff. "pending" means not yet paid out.' } });
  }));
  router.post('/group-buy/refunds/:refundId/paid-out', wrap(async (req, res) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Admins only', 'FORBIDDEN');
    const [r] = await run(`UPDATE duka_gb_refunds SET status='paid_out', payout_ref=:ref WHERE id=:id AND status='pending' RETURNING id,status`, { ref: str((req.body || {}).payoutRef, 'Payout reference', { max: 40, required: true }), id: idParam(req, 'refundId') });
    if (!r) throw nf('Pending refund');
    res.json({ success: true, data: { refund: r } });
  }));

  router.get('/group-buy/dashboard', wrap(async (req, res) => {
    await sweep();
    const [open] = await run(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE min_qty > COALESCE((SELECT SUM(qty) FROM duka_gb_participants p WHERE p.order_id=o.id AND p.status='joined'),0))::int AS needs_more FROM duka_gb_orders o WHERE status='open'`);
    const mineRows = await run(
      `SELECT o.id, o.product_name, o.unit, o.status AS order_status, o.market, p.status AS my_status, p.qty, p.amount_due, p.goods_cost, p.fee_share, p.allocated_qty, p.reference_price,
              COALESCE((SELECT SUM(amount) FROM duka_gb_payments x WHERE x.participant_id=p.id),0) AS paid
       FROM duka_gb_participants p JOIN duka_gb_orders o ON o.id=p.order_id WHERE p.user_id=:u AND p.status NOT IN ('withdrawn','removed') ORDER BY o.created_at DESC LIMIT 100`, { u: req.user.id });
    let saved = 0, savedOrders = 0;
    mineRows.forEach((r) => { if (r.my_status === 'received' && r.reference_price != null && Number(r.allocated_qty) > 0) {
      const actual = (c(r.goods_cost) + c(r.fee_share)) / Number(r.allocated_qty) / 100; const d = (Number(r.reference_price) - actual) * Number(r.allocated_qty);
      if (d > 0) { saved += d; savedOrders++; } } });
    const count = (f) => mineRows.filter(f).length;
    res.json({ success: true, data: {
      marketplace: { openOrders: open.n, ordersNeedingMoreParticipants: open.needs_more },
      mine: { orders: mineRows.map((r) => ({ orderId: r.id, product: r.product_name, market: r.market, orderStatus: r.order_status, myStatus: r.my_status, qty: Number(r.qty), unit: r.unit,
        amountDue: r.amount_due == null ? null : Number(r.amount_due), amountPaid: Number(r.paid) })),
        awaitingPayment: count((r) => r.order_status === 'locked'), pendingDeliveries: count((r) => ['confirmed', 'delivered'].includes(r.order_status) && r.my_status !== 'received'),
        completed: count((r) => r.my_status === 'received'), cancelledOrDisputed: count((r) => ['cancelled', 'disputed'].includes(r.order_status)) },
      verifiedSavings: { amount: Math.round(saved * 100) / 100, ordersCounted: savedOrders,
        basis: 'Only completed purchases where you entered your own reference price. Difference between that price and your actual cost per unit (goods + charges).' }
    } });
  }));

  router.get('/group-buy/orders/:orderId/audit', wrap(async (req, res) => {
    const id = idParam(req, 'orderId'), o = await getOrder(id);
    if (o.organiser_id !== req.user.id && !isAdmin(req)) throw nf('Group order');
    const rows = await run('SELECT id,user_id,action,data,created_at FROM duka_gb_audit WHERE order_id=:o ORDER BY id', { o: id });
    res.json({ success: true, data: { entries: rows.map((r) => ({ id: Number(r.id), action: r.action, userId: r.user_id, data: r.data, at: r.created_at })) } });
  }));
}
module.exports = { mount, priceShares, split };
