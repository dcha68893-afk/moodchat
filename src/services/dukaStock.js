'use strict';
/**
 * NECPRA DUKA SMART — shared "receive stock" primitive.
 * Used by manual purchases (waste service) and by Group Buying delivery allocation so both write the
 * same ledger rows: product balance + stock movement ('purchase') + batch (date, cost, shelf life), in ONE transaction.
 * Idempotent: the batch id is also the movement's client_op_id, so replays return the stored batch.
 * Product cost becomes the weighted average of existing stock and the new batch (sales snapshot it as COGS).
 */
async function receiveBatch(run, t, o) {
  const [p] = await run('SELECT * FROM duka_products WHERE id=:id AND shop_id=:shopId FOR UPDATE', { id: o.productId, shopId: o.shopId }, t);
  if (!p) { const e = new Error('Product not found'); e.status = 404; e.code = 'PRODUCT_NOT_FOUND'; throw e; }
  const [ex] = await run('SELECT * FROM duka_stock_batches WHERE id=:id AND shop_id=:shopId', { id: o.batchId, shopId: o.shopId }, t);
  if (ex) return { batch: ex, product: p, created: false };

  const oldQty = Number(p.stock_qty), oldCost = Number(p.buying_price);
  const newBal = Math.round((oldQty + o.qty) * 1000) / 1000;
  const avg = oldQty > 0
    ? Math.round(((oldQty * oldCost + o.qty * o.unitCost) / (oldQty + o.qty)) * 100) / 100
    : o.unitCost;
  const shelf = o.shelfLifeDays != null ? o.shelfLifeDays : (p.is_perishable && p.shelf_life_days ? Number(p.shelf_life_days) : null);
  const receivedAt = o.receivedAt || new Date().toISOString();
  const [after] = await run('UPDATE duka_products SET stock_qty=:bal, buying_price=:avg, updated_at=NOW() WHERE id=:id RETURNING *', { bal: newBal, avg, id: p.id }, t);
  await run(
    `INSERT INTO duka_stock_movements (shop_id,product_id,type,qty_change,balance_after,unit_cost,reference_type,reference_id,note,created_by,client_op_id)
     VALUES (:shopId,:pid,'purchase',:q,:bal,:cost,:rt,:rid,:note,:userId,:op) RETURNING id`,
    { shopId: o.shopId, pid: p.id, q: o.qty, bal: newBal, cost: o.unitCost, rt: o.source || 'purchase', rid: o.sourceRef || null, note: o.note || null, userId: o.userId, op: o.batchId }, t);
  const [batch] = await run(
    `INSERT INTO duka_stock_batches (id,shop_id,product_id,batch_ref,qty_received,unit_cost,supplier_id,source,source_ref,received_at,shelf_life_days,expected_spoil_at,condition_note,created_by)
     VALUES (:id,:shopId,:pid,:ref,:q,:cost,:sup,:source,:sref,:at,:shelf,
       CASE WHEN :shelf::numeric IS NULL THEN NULL ELSE :at::timestamptz + (:shelf::numeric * INTERVAL '1 day') END,:cond,:userId) RETURNING *`,
    { id: o.batchId, shopId: o.shopId, pid: p.id, ref: o.batchRef || null, q: o.qty, cost: o.unitCost, sup: o.supplierId || null,
      source: o.source || 'purchase', sref: o.sourceRef || null, at: receivedAt, shelf, cond: o.condition || null, userId: o.userId }, t);
  return { batch, product: after, created: true };
}
module.exports = { receiveBatch };
