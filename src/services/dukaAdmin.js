'use strict';
/**
 * NECPRA DUKA SMART — admin console data routes (mounted by routes/duka.js under /api/duka/admin).
 * Admin = a user id listed in DUKA_ADMIN_IDS (.env). Everyone else gets 403, except /admin/me which just answers { isAdmin }.
 * These routes only READ lists. Every action (approve/reject a device application, verify/suspend a supplier, resolve a dispute,
 * mark a refund paid out, link a device, update a repair) uses the existing admin routes in dukaFinancing.js and dukaGroupBuy.js,
 * which enforce the same DUKA_ADMIN_IDS check. Marketplace admin features are intentionally NOT included.
 *
 *   GET /admin/me
 *   GET /admin/overview                      counts of items waiting for an admin
 *   GET /admin/suppliers?status=pending|verified|suspended
 *   GET /admin/disputes?status=open|resolved
 *   GET /admin/refunds?status=pending|paid_out
 *   GET /admin/repairs?status=open|in_repair|resolved|rejected
 *   GET /admin/shops/:shopId/devices         devices registered on a trader's shop (to link to a financing plan)
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const adminIds = () => String(process.env.DUKA_ADMIN_IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);

function mount(ctx) {
  const { router, run, wrap, HttpError } = ctx;
  const isAdmin = (req) => !!req.user && adminIds().includes(Number(req.user.id));
  const need = (req) => { if (!isAdmin(req)) throw new HttpError(403, 'Not allowed', 'FORBIDDEN'); };
  const oneOf = (val, list, def) => { const s = String(val || def); if (!list.includes(s)) throw new HttpError(400, 'Unknown status', 'VALIDATION_ERROR'); return s; };

  router.get('/admin/me', wrap(async (req, res) => { res.json({ success: true, data: { isAdmin: isAdmin(req) } }); }));

  router.get('/admin/overview', wrap(async (req, res) => {
    need(req);
    const [r] = await run(`SELECT
      (SELECT COUNT(*) FROM duka_fin_plans WHERE status='applied') AS fin_applied,
      (SELECT COUNT(*) FROM duka_fin_repairs WHERE status IN ('open','in_repair')) AS repairs_open,
      (SELECT COUNT(*) FROM duka_gb_suppliers WHERE status='pending') AS suppliers_pending,
      (SELECT COUNT(*) FROM duka_gb_disputes WHERE status='open') AS disputes_open,
      (SELECT COUNT(*) FROM duka_gb_refunds WHERE status='pending') AS refunds_pending`);
    res.json({ success: true, data: { financingApplications: Number(r.fin_applied), openRepairs: Number(r.repairs_open), suppliersPending: Number(r.suppliers_pending), openDisputes: Number(r.disputes_open), pendingRefunds: Number(r.refunds_pending) } });
  }));

  router.get('/admin/suppliers', wrap(async (req, res) => {
    need(req);
    const st = oneOf(req.query.status, ['pending', 'verified', 'suspended'], 'pending');
    const rows = await run('SELECT id,user_id,business_name,phone,location,products,status,verified_at,created_at FROM duka_gb_suppliers WHERE status=:s ORDER BY created_at DESC LIMIT 100', { s: st });
    res.json({ success: true, data: { suppliers: rows.map((s) => ({ id: s.id, userId: s.user_id, businessName: s.business_name, phone: s.phone, location: s.location, products: s.products, status: s.status, verifiedAt: s.verified_at, createdAt: s.created_at })) } });
  }));

  router.get('/admin/disputes', wrap(async (req, res) => {
    need(req);
    const st = oneOf(req.query.status, ['open', 'resolved'], 'open');
    const rows = await run(`SELECT d.*, o.product_name, o.status AS order_status FROM duka_gb_disputes d JOIN duka_gb_orders o ON o.id=d.order_id WHERE d.status=:s ORDER BY d.created_at DESC LIMIT 100`, { s: st });
    res.json({ success: true, data: { disputes: rows.map((d) => ({ id: d.id, orderId: d.order_id, product: d.product_name, orderStatus: d.order_status, kind: d.kind, details: d.details, status: d.status, raisedBy: d.raised_by, createdAt: d.created_at })) } });
  }));

  router.get('/admin/refunds', wrap(async (req, res) => {
    need(req);
    const st = oneOf(req.query.status, ['pending', 'paid_out'], 'pending');
    const rows = await run(`SELECT r.*, o.product_name, s.name AS shop_name, s.phone AS shop_phone FROM duka_gb_refunds r JOIN duka_gb_orders o ON o.id=r.order_id
        JOIN duka_gb_participants p ON p.id=r.participant_id JOIN duka_shops s ON s.id=p.shop_id WHERE r.status=:s ORDER BY r.created_at DESC LIMIT 100`, { s: st });
    res.json({ success: true, data: { refunds: rows.map((r) => ({ id: r.id, orderId: r.order_id, product: r.product_name, shopName: r.shop_name, shopPhone: r.shop_phone, amount: Number(r.amount), reason: r.reason, status: r.status, payoutRef: r.payout_ref, createdAt: r.created_at })) } });
  }));

  router.get('/admin/repairs', wrap(async (req, res) => {
    need(req);
    const st = oneOf(req.query.status, ['open', 'in_repair', 'resolved', 'rejected'], 'open');
    const rows = await run(`SELECT r.*, p.device_model, s.name AS shop_name, s.phone AS shop_phone FROM duka_fin_repairs r JOIN duka_fin_plans p ON p.id=r.plan_id JOIN duka_shops s ON s.id=p.shop_id WHERE r.status=:s ORDER BY r.created_at DESC LIMIT 100`, { s: st });
    res.json({ success: true, data: { repairs: rows.map((r) => ({ id: r.id, planId: r.plan_id, deviceModel: r.device_model, shopName: r.shop_name, shopPhone: r.shop_phone, kind: r.kind, details: r.details, status: r.status, resolution: r.resolution, createdAt: r.created_at })) } });
  }));

  router.get('/admin/shops/:shopId/devices', wrap(async (req, res) => {
    need(req);
    if (!UUID_RE.test(req.params.shopId || '')) throw new HttpError(404, 'Shop not found', 'NOT_FOUND');
    const rows = await run(`SELECT id,serial_no,label,device_type,status,last_seen_at FROM duka_devices WHERE shop_id=:s ORDER BY created_at DESC`, { s: req.params.shopId.toLowerCase() });
    res.json({ success: true, data: { devices: rows.map((d) => ({ id: d.id, serialNo: d.serial_no, label: d.label, type: d.device_type, status: d.status, lastSeenAt: d.last_seen_at })) } });
  }));
}
module.exports = { mount };
