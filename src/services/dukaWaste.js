'use strict';
/**
 * NECPRA DUKA SMART — Smart Waste Prevention + perishable batches (mounted by routes/duka.js).
 *
 *   POST /shops/:shopId/products/:productId/batches   receive stock as a batch (date, cost, shelf life, condition)
 *   GET  /shops/:shopId/products/:productId/batches
 *   POST /shops/:shopId/losses                        record confirmed spoiled/damaged stock (an inventory LOSS, never a sale)
 *   GET  /shops/:shopId/losses?days=30
 *   GET  /shops/:shopId/waste                         freshness, sell-through, at-risk value, discount + reorder suggestions
 *
 * How the numbers are made (all from recorded data; every projection is labelled an estimate):
 *  - Sell-through: average daily qty sold over the last WINDOW days from completed sales. Fewer than MIN_SALE_DAYS days of
 *    history => confidence:"preliminary" (shown, but never presented as a firm prediction).
 *  - Which batch holds the stock: product.stock_qty is the truth; FIFO means the NEWEST batches hold what is left.
 *  - Projected at-risk qty of a batch = qty still on hand from it minus what the average daily sales would clear
 *    (FIFO, oldest first) before its estimated spoil date. Value at risk = that qty x batch unit cost.
 *  - Freshness = fraction of the (seller-entered) shelf life already used: fresh <50%, monitor <75%, sell_soon <100%, at_risk >=100%.
 *    "spoiled" exists ONLY as a recorded loss — software cannot see produce, so it never declares spoilage by itself.
 *  - Discount suggestions are advice only: NOTHING changes a price. Suggested price never goes below cost unless flagged.
 *  - Reorder advice = demand over a cover period capped by shelf life, minus stock, shrunk by this shop's own recent spoilage rate.
 */
const { receiveBatch } = require('./dukaStock');

const WINDOW = 14, MIN_SALE_DAYS = 5, DISCOUNT_PCT = 0.15;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const REASONS = ['spoiled', 'damaged', 'expired', 'theft', 'other'];
const HANDLING = ['disposed', 'returned', 'discounted', 'other'];

function mount(ctx) {
  const { router, run, tx, wrap, audit, ownedShop, HttpError, v } = ctx;
  const { has, str, money, qty, uuid, ensureObject } = v;
  const bad = (m, c) => new HttpError(400, m, c || 'VALIDATION_ERROR');

  const batchOut = (b, remaining) => ({
    id: b.id, productId: b.product_id, batchRef: b.batch_ref, qtyReceived: Number(b.qty_received), unitCost: Number(b.unit_cost),
    source: b.source, receivedAt: b.received_at, shelfLifeDays: b.shelf_life_days == null ? null : Number(b.shelf_life_days),
    expectedSpoilAt: b.expected_spoil_at, conditionNote: b.condition_note, qtyRemainingEstimate: remaining === undefined ? undefined : remaining
  });

  router.patch('/shops/:shopId/products/:productId/perishable', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const isP = b.isPerishable === true;
      const days = isP && has(b.shelfLifeDays) ? qty(b.shelfLifeDays, 'Shelf life (days)', { required: true }) : null;
      if (isP && days != null && !(days > 0 && days <= 365)) throw bad('Shelf life must be between 0 and 365 days');
      if (!/^[0-9a-f-]{36}$/i.test(req.params.productId || '')) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      const [p] = await run(
        `UPDATE duka_products SET is_perishable=:isP, shelf_life_days=:days, storage_note=:note, updated_at=NOW()
         WHERE id=:id AND shop_id=:shopId RETURNING id,name,is_perishable,shelf_life_days,storage_note`,
        { isP, days, note: str(b.storageNote, 'Storage note', { max: 160 }), id: req.params.productId, shopId: shop.id }, t);
      if (!p) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      await audit(t, req, shop.id, 'product.perishable', 'product', p.id, null, { isPerishable: isP, shelfLifeDays: days });
      return p;
    });
    res.json({ success: true, data: { product: { id: out.id, name: out.name, isPerishable: out.is_perishable, shelfLifeDays: out.shelf_life_days == null ? null : Number(out.shelf_life_days), storageNote: out.storage_note } } });
  }));

  router.post('/shops/:shopId/products/:productId/batches', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'id', { required: true });
    // Buying in packs (crate/tray/sack): send packs + packCost (price of ONE pack). The server converts to selling units
    // using the product's pack size, so 2 crates of 30 eggs at KSh 360 each = 60 eggs at KSh 12 each. Otherwise qty + unitCost.
    const inPacks = has(b.packs) || has(b.packCost);
    let q, unitCost, packsIn = null;
    if (inPacks) {
      if (has(b.qty) || has(b.unitCost)) throw bad('Send either packs + packCost, or qty + unitCost, not both');
      packsIn = qty(b.packs, 'Number of packs', { required: true });
      if (!(packsIn > 0)) throw bad('Number of packs must be greater than zero');
    } else {
      q = qty(b.qty, 'Quantity', { required: true });
      if (!(q > 0)) throw bad('Quantity must be greater than zero');
      unitCost = money(b.unitCost, 'Unit cost', { required: true });
    }
    const shelf = has(b.shelfLifeDays) ? qty(b.shelfLifeDays, 'Shelf life (days)') : null;
    if (shelf != null && !(shelf > 0 && shelf <= 365)) throw bad('Shelf life must be between 0 and 365 days');
    let receivedAt = null;
    if (has(b.receivedAt)) {
      const d = new Date(b.receivedAt);
      if (isNaN(d) || d.getTime() > Date.now() + 10 * 60000) throw bad('Received date cannot be in the future');
      if (Date.now() - d.getTime() > 400 * 86400000) throw bad('Received date is too old');
      receivedAt = d.toISOString();
    }
    if (!/^[0-9a-f-]{36}$/i.test(req.params.productId || '')) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const supplierId = uuid(b.supplierId, 'supplierId');
      if (supplierId) {
        const [s] = await run('SELECT 1 AS ok FROM duka_suppliers WHERE id=:id AND shop_id=:shopId', { id: supplierId, shopId: shop.id }, t);
        if (!s) throw bad('Supplier not found in this shop');
      }
      if (inPacks) {
        const [pp] = await run('SELECT pack_unit, pack_size FROM duka_products WHERE id=:id AND shop_id=:shopId', { id: req.params.productId, shopId: shop.id }, t);
        if (!pp) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
        if (!pp.pack_size) throw bad('This product has no pack size yet. Set its pack (for example crate = 30 eggs) first.');
        const packCost = money(b.packCost, 'Price per pack', { required: true });
        q = r3(packsIn * Number(pp.pack_size));
        if (!(q > 0)) throw bad('Quantity must be greater than zero');
        unitCost = r2(packCost / Number(pp.pack_size));
      }
      const r = await receiveBatch(run, t, {
        shopId: shop.id, productId: req.params.productId, batchId: id, qty: q, unitCost, shelfLifeDays: shelf, receivedAt,
        batchRef: str(b.batchRef, 'Batch reference', { max: 60 }), supplierId, condition: str(b.condition, 'Condition', { max: 160 }),
        userId: req.user.id, source: 'purchase', note: 'Stock received'
      });
      if (r.created) await audit(t, req, shop.id, 'stock.batch', 'product', r.product.id, null, { batchId: id, qty: q, unitCost, packs: packsIn });
      return r;
    });
    res.status(out.created ? 201 : 200).json({
      success: true, data: { batch: batchOut(out.batch), stockQty: Number(out.product.stock_qty), buyingPrice: Number(out.product.buying_price), idempotent: !out.created }
    });
  }));

  router.get('/shops/:shopId/products/:productId/batches', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.productId || '')) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    const [p] = await run('SELECT id,stock_qty FROM duka_products WHERE id=:id AND shop_id=:shopId', { id: req.params.productId, shopId: shop.id });
    if (!p) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    const rows = await run('SELECT * FROM duka_stock_batches WHERE product_id=:id ORDER BY received_at DESC', { id: p.id });
    let left = Number(p.stock_qty);
    res.json({ success: true, data: { batches: rows.map((b) => { const rem = Math.min(left, Number(b.qty_received)); left = r3(left - rem); return batchOut(b, r3(rem)); }), untrackedQty: r3(Math.max(0, left)) } });
  }));

  router.post('/shops/:shopId/losses', wrap(async (req, res) => {
    const b = ensureObject(req.body);
    const id = uuid(b.id, 'id', { required: true });
    const productId = uuid(b.productId, 'productId', { required: true });
    const q = qty(b.qty, 'Quantity', { required: true });
    if (!(q > 0)) throw bad('Quantity must be greater than zero');
    const reason = has(b.reason) ? b.reason : 'spoiled';
    if (!REASONS.includes(reason)) throw bad(`Reason must be one of: ${REASONS.join(', ')}`);
    const handling = has(b.handling) ? b.handling : 'disposed';
    if (!HANDLING.includes(handling)) throw bad(`Handling must be one of: ${HANDLING.join(', ')}`);
    const photo = str(b.photoUrl, 'Photo', { max: 500 });
    if (photo && !/^https:\/\//i.test(photo)) throw bad('Photo must be a secure https link');
    const out = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const [ex] = await run('SELECT * FROM duka_stock_losses WHERE id=:id AND shop_id=:shopId', { id, shopId: shop.id }, t);
      if (ex) return { loss: ex, created: false };
      const [p] = await run('SELECT * FROM duka_products WHERE id=:id AND shop_id=:shopId FOR UPDATE', { id: productId, shopId: shop.id }, t);
      if (!p) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
      if (q > Number(p.stock_qty)) throw new HttpError(409, `Cannot write off ${q}: only ${Number(p.stock_qty)} ${p.unit} in stock`, 'INSUFFICIENT_STOCK');
      let batch = null;
      if (has(b.batchId)) {
        [batch] = await run('SELECT * FROM duka_stock_batches WHERE id=:id AND product_id=:pid', { id: uuid(b.batchId, 'batchId'), pid: p.id }, t);
        if (!batch) throw bad('Batch not found for this product');
      }
      const unitCost = batch ? Number(batch.unit_cost) : Number(p.buying_price);
      const lossValue = r2(q * unitCost);
      const newBal = r3(Number(p.stock_qty) - q);
      const mvId = require('crypto').randomUUID();
      await run('UPDATE duka_products SET stock_qty=:bal, updated_at=NOW() WHERE id=:id RETURNING id', { bal: newBal, id: p.id }, t);
      await run(
        `INSERT INTO duka_stock_movements (id,shop_id,product_id,type,qty_change,balance_after,unit_cost,reference_type,reference_id,note,created_by,client_op_id)
         VALUES (:mv,:shopId,:pid,'damage',:chg,:bal,:cost,'loss',:id,:note,:userId,:id) RETURNING id`,
        { mv: mvId, shopId: shop.id, pid: p.id, chg: -q, bal: newBal, cost: unitCost, id, note: `${reason}`.slice(0, 40), userId: req.user.id }, t);
      const [loss] = await run(
        `INSERT INTO duka_stock_losses (id,shop_id,product_id,batch_id,qty,unit_cost,loss_value,reason,handling,condition_note,photo_url,detected_on,movement_id,created_by)
         VALUES (:id,:shopId,:pid,:bid,:q,:cost,:val,:reason,:handling,:cond,:photo,COALESCE(:on::date,(NOW() AT TIME ZONE 'Africa/Nairobi')::date),:mv,:userId) RETURNING *`,
        { id, shopId: shop.id, pid: p.id, bid: batch ? batch.id : null, q, cost: unitCost, val: lossValue, reason, handling,
          cond: str(b.condition, 'Condition', { max: 200 }), photo, on: has(b.detectedOn) ? b.detectedOn : null, mv: mvId, userId: req.user.id }, t);
      await audit(t, req, shop.id, 'stock.loss', 'product', p.id, { stockQty: Number(p.stock_qty) }, { stockQty: newBal, qty: q, reason, lossValue });
      return { loss, created: true, name: p.name };
    });
    const l = out.loss;
    res.status(out.created ? 201 : 200).json({
      success: true, data: { loss: { id: l.id, productId: l.product_id, qty: Number(l.qty), unitCost: Number(l.unit_cost), lossValue: Number(l.loss_value), reason: l.reason, handling: l.handling, detectedOn: l.detected_on }, idempotent: !out.created }
    });
  }));

  router.get('/shops/:shopId/losses', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 400);
    const rows = await run(
      `SELECT l.*, p.name AS product_name, p.unit FROM duka_stock_losses l JOIN duka_products p ON p.id=l.product_id
       WHERE l.shop_id=:shopId AND l.detected_on >= (NOW() AT TIME ZONE 'Africa/Nairobi')::date - :days::int ORDER BY l.created_at DESC LIMIT 500`, { shopId: shop.id, days });
    const byProduct = {};
    rows.forEach((l) => { const k = l.product_id; byProduct[k] = byProduct[k] || { productId: k, name: l.product_name, qty: 0, value: 0, incidents: 0 }; byProduct[k].qty = r3(byProduct[k].qty + Number(l.qty)); byProduct[k].value = r2(byProduct[k].value + Number(l.loss_value)); byProduct[k].incidents++; });
    res.json({ success: true, data: {
      days, totalLossValue: r2(rows.reduce((s, l) => s + Number(l.loss_value), 0)),
      note: 'Losses are inventory write-offs at cost. They are not sales and are not counted in revenue.',
      frequentlyWasted: Object.values(byProduct).sort((a, b) => b.value - a.value),
      losses: rows.map((l) => ({ id: l.id, productId: l.product_id, name: l.product_name, qty: Number(l.qty), unit: l.unit, lossValue: Number(l.loss_value), reason: l.reason, handling: l.handling, detectedOn: l.detected_on, condition: l.condition_note }))
    } });
  }));

  /* ───── analysis (also used by Group Buying to size a trader's allocation) ───── */
  async function analyse(shopId, t) {
    const prods = await run(
      `SELECT * FROM duka_products WHERE shop_id=:shopId AND is_active AND (is_perishable OR EXISTS (SELECT 1 FROM duka_stock_batches b WHERE b.product_id=duka_products.id))`, { shopId }, t);
    if (!prods.length) return { items: [], totals: { valueAtRisk: 0, productsAtRisk: 0 } };
    const ids = prods.map((p) => p.id);
    const sold = await run(
      `SELECT i.product_id, COALESCE(SUM(i.qty),0) AS q, COUNT(DISTINCT (s.sold_at AT TIME ZONE 'Africa/Nairobi')::date)::int AS sale_days,
              COALESCE(SUM(i.qty) FILTER (WHERE s.sold_at >= NOW() - INTERVAL '7 days'),0) AS q7,
              COALESCE(SUM(i.qty) FILTER (WHERE s.sold_at < NOW() - INTERVAL '7 days'),0) AS qprev
       FROM duka_sale_items i JOIN duka_sales s ON s.id=i.sale_id
       WHERE i.shop_id=:shopId AND s.status='completed' AND s.sold_at >= NOW() - (:w::int * INTERVAL '1 day') AND i.product_id = ANY(:ids::uuid[])
       GROUP BY i.product_id`, { shopId, w: WINDOW, ids: `{${ids.join(',')}}` }, t);
    const soldBy = {}; sold.forEach((s) => { soldBy[s.product_id] = s; });
    const batches = await run(`SELECT * FROM duka_stock_batches WHERE shop_id=:shopId AND product_id = ANY(:ids::uuid[]) ORDER BY received_at DESC`, { shopId, ids: `{${ids.join(',')}}` }, t);
    const lossRows = await run(
      `SELECT product_id, COALESCE(SUM(qty),0) AS q FROM duka_stock_losses WHERE shop_id=:shopId AND detected_on >= CURRENT_DATE - 60 GROUP BY product_id`, { shopId }, t);
    const recvRows = await run(
      `SELECT product_id, COALESCE(SUM(qty_received),0) AS q FROM duka_stock_batches WHERE shop_id=:shopId AND received_at >= NOW() - INTERVAL '60 days' GROUP BY product_id`, { shopId }, t);
    const lossBy = {}; lossRows.forEach((r) => { lossBy[r.product_id] = Number(r.q); });
    const recvBy = {}; recvRows.forEach((r) => { recvBy[r.product_id] = Number(r.q); });
    const now = Date.now();
    const items = [];
    let valueAtRisk = 0, productsAtRisk = 0;

    for (const p of prods) {
      const s = soldBy[p.id] || { q: 0, sale_days: 0, q7: 0, qprev: 0 };
      const firstBatch = batches.filter((b) => b.product_id === p.id).slice(-1)[0];
      const stock = Number(p.stock_qty);
      const avgDaily = Number(s.q) / WINDOW;
      const confidence = Number(s.sale_days) >= MIN_SALE_DAYS ? 'based_on_sales' : 'preliminary';
      const trend = Number(s.qprev) > 0 && Number(s.q7) < Number(s.qprev) * 0.7 ? 'slowing' : Number(s.qprev) > 0 && Number(s.q7) > Number(s.qprev) * 1.3 ? 'rising' : 'steady';
      const daysLeft = avgDaily > 0 ? r2(stock / avgDaily) : null;

      // FIFO: newest batches hold the remaining stock; clear oldest first at the average daily rate.
      let left = stock; const held = [];
      for (const b of batches.filter((x) => x.product_id === p.id)) { if (left <= 0) break; const q = Math.min(left, Number(b.qty_received)); held.push({ b, q }); left = r3(left - q); }
      held.reverse(); // oldest first
      let cum = 0; const bOut = []; let itemRisk = 0, itemRiskQty = 0;
      for (const { b, q } of held) {
        cum += q;
        const shelf = b.shelf_life_days == null ? null : Number(b.shelf_life_days);
        const ageDays = (now - new Date(b.received_at).getTime()) / 86400000;
        const used = shelf ? ageDays / shelf : null;
        let state = 'unknown';
        if (used != null) state = used < 0.5 ? 'fresh' : used < 0.75 ? 'monitor' : used < 1 ? 'sell_soon' : 'at_risk';
        let riskQty = 0;
        if (b.expected_spoil_at) {
          const daysToSpoil = Math.max(0, (new Date(b.expected_spoil_at).getTime() - now) / 86400000);
          riskQty = r3(Math.min(q, Math.max(0, cum - avgDaily * daysToSpoil)));
        }
        const riskValue = r2(riskQty * Number(b.unit_cost));
        itemRisk += riskValue; itemRiskQty += riskQty;
        bOut.push({ batchId: b.id, batchRef: b.batch_ref, qtyOnHandEstimate: r3(q), unitCost: Number(b.unit_cost), receivedAt: b.received_at, expectedSpoilAt: b.expected_spoil_at,
          ageDays: r2(ageDays), freshness: state, estimatedAtRiskQty: riskQty, estimatedAtRiskValue: riskValue, estimate: true });
      }
      const sell = Number(p.selling_price), cost = Number(p.buying_price);
      let suggestion = null;
      if (itemRiskQty > 0 || (trend === 'slowing' && bOut.some((x) => x.freshness === 'sell_soon' || x.freshness === 'at_risk'))) {
        let sugg = r2(sell * (1 - DISCOUNT_PCT));
        const belowCost = sugg < cost;
        if (belowCost) sugg = r2(cost);
        const qtyAffected = itemRiskQty > 0 ? itemRiskQty : r3(stock);
        suggestion = {
          action: 'temporary_discount', requiresSellerApproval: true, priceChangedAutomatically: false,
          originalPrice: sell, suggestedPrice: sugg, discountPct: sell > 0 ? r2((1 - sugg / sell) * 100) : 0, qtyAffected,
          expectedRevenue: r2(qtyAffected * sugg), marginPerUnitNow: r2(sell - cost), marginPerUnitAfter: r2(sugg - cost),
          potentialLossReduction: r2(itemRiskQty * cost), basis: 'estimate',
          warning: belowCost ? `A ${Math.round(DISCOUNT_PCT * 100)}% discount would sell below your cost (KSh ${cost}). The suggestion is held at cost. Selling below cost is your decision and needs your explicit approval.` : null,
          alternatives: ['bundle offer (e.g. 3 for the price of 2.5)', 'smaller purchase next time']
        };
      }
      const spoilRate = recvBy[p.id] > 0 ? Math.min(1, (lossBy[p.id] || 0) / recvBy[p.id]) : 0;
      const shelfDays = p.shelf_life_days ? Number(p.shelf_life_days) : (firstBatch && firstBatch.shelf_life_days ? Number(firstBatch.shelf_life_days) : 3);
      const cover = Math.min(Math.max(shelfDays * 0.6, 1), 7);
      const rawNeed = Math.max(0, avgDaily * cover - stock);
      const suggestedQty = r3(rawNeed * (1 - Math.min(spoilRate, 0.5)));
      const reorder = {
        suggestedQty, coverDays: r2(cover), recentDailyDemand: r3(avgDaily), recentSpoilageRatePct: r2(spoilRate * 100),
        reason: avgDaily === 0 ? 'No recent sales recorded; not recommending a purchase.'
          : stock >= avgDaily * cover ? 'You already hold enough for the cover period; buying more risks overstock.'
          : spoilRate > 0.15 ? `About ${Math.round(spoilRate * 100)}% of what you bought in the last 60 days was written off, so the amount is reduced — buy smaller and more often.` : 'Based on recent demand and shelf life.',
        confidence, estimate: true
      };
      if (itemRiskQty > 0) productsAtRisk++;
      valueAtRisk += itemRisk;
      items.push({
        productId: p.id, name: p.name, unit: p.unit, isPerishable: p.is_perishable, stockQty: stock, stockValue: r2(stock * cost),
        sales: { avgDailyQty: r3(avgDaily), windowDays: WINDOW, saleDays: Number(s.sale_days), trend, daysOfStockLeft: daysLeft, confidence },
        valueAtRisk: r2(itemRisk), qtyAtRisk: r3(itemRiskQty), batches: bOut, discountSuggestion: suggestion, reorder
      });
    }
    return { items, totals: { valueAtRisk: r2(valueAtRisk), productsAtRisk } };
  }

  router.get('/shops/:shopId/waste', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const a = await analyse(shop.id);
    const [l30] = await run(`SELECT COALESCE(SUM(loss_value),0) AS v, COUNT(*)::int AS n FROM duka_stock_losses WHERE shop_id=:s AND detected_on >= CURRENT_DATE - 30`, { s: shop.id });
    const [l60] = await run(`SELECT COALESCE(SUM(loss_value),0) AS v FROM duka_stock_losses WHERE shop_id=:s AND detected_on >= CURRENT_DATE - 60 AND detected_on < CURRENT_DATE - 30`, { s: shop.id });
    res.json({ success: true, data: {
      summary: { stockAtRiskValue: a.totals.valueAtRisk, productsAtRisk: a.totals.productsAtRisk, lossesLast30Days: r2(l30.v), lossIncidentsLast30Days: l30.n, lossesPrevious30Days: r2(l60.v),
        lossesAvoided: null, lossesAvoidedNote: 'Not reported: avoided loss cannot be proven from sales records alone, so no figure is shown rather than an invented one.' },
      items: a.items.sort((x, y) => y.valueAtRisk - x.valueAtRisk),
      disclaimer: 'Risk figures are estimates from your sales and the shelf life you entered. Only recorded losses are confirmed spoilage.'
    } });
  }));

  ctx.waste = { analyse };
}
module.exports = { mount };
