'use strict';
/**
 * NECPRA DUKA SMART — Smart Scale / device API (same products, prices, stock and sales as the phone app).
 *
 * Owner (JWT)   POST /shops/:shopId/devices            register → returns the device key ONCE (only its SHA-256 is stored)
 *               GET  /shops/:shopId/devices            list (battery, firmware, last seen/sync, offline-reading count)
 *               POST /shops/:shopId/devices/:id/revoke
 *               GET  /shops/:shopId/devices/:id/readings   weights the scale sent (the phone adds them to a bill)
 * Device        headers  x-device-serial + x-device-key   (no user JWT: firmware has no login screen)
 *               POST /device/heartbeat   battery, charging, firmware, calibration status
 *               GET  /device/catalog     weighable products + prices of the owning shop only
 *               POST /device/sync        batch of offline readings; idempotent per opId; price calculated SERVER-side
 *
 * Honest limits: this is the software side only. Real scale firmware, load-cell calibration and legal-metrology
 * (Kenya Weights & Measures) approval are hardware work; stable/overload/tare values are reported by the device and recorded as sent.
 * Tested with a simulated device, not physical hardware.
 */
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEIGHT_UNITS = { kg: 1000, g: 1 };

function mountDevice({ router, run, wrap, HttpError, tx, v }) {
  const { has, str, uuid, ensureObject } = v;
  async function deviceAuth(req) {
    const serial = String(req.headers['x-device-serial'] || ''), key = String(req.headers['x-device-key'] || '');
    if (!serial || !key) throw new HttpError(401, 'Device credentials required', 'DEVICE_UNAUTHORIZED');
    const [d] = await run('SELECT * FROM duka_devices WHERE serial_no=:s', { s: serial });
    const a = Buffer.from(sha(key)), b = Buffer.from(d ? d.key_hash : '0'.repeat(64));
    if (!d || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Invalid device credentials', 'DEVICE_UNAUTHORIZED');
    if (d.status !== 'active') throw new HttpError(403, 'This device has been revoked', 'DEVICE_REVOKED');
    return d;
  }
  router.post('/device/heartbeat', wrap(async (req, res) => {
    const d = await deviceAuth(req), b = ensureObject(req.body);
    const battery = has(b.batteryPct) ? Math.round(Number(b.batteryPct)) : null;
    if (battery != null && !(battery >= 0 && battery <= 100)) throw new HttpError(400, 'batteryPct must be 0-100', 'VALIDATION_ERROR');
    await run(`UPDATE duka_devices SET last_seen_at=NOW(), battery_pct=COALESCE(:b,battery_pct), charging=COALESCE(:c,charging), firmware=COALESCE(:f,firmware), calibration_status=COALESCE(:cal,calibration_status) WHERE id=:id RETURNING id`,
      { b: battery, c: typeof b.charging === 'boolean' ? b.charging : null, f: str(b.firmware, 'firmware', { max: 30 }), cal: str(b.calibration, 'calibration', { max: 20 }), id: d.id });
    res.json({ success: true, data: { serverTime: new Date().toISOString() } });
  }));
  router.get('/device/catalog', wrap(async (req, res) => {
    const d = await deviceAuth(req);
    const rows = await run(`SELECT id,name,unit,selling_price,barcode FROM duka_products WHERE shop_id=:s AND is_active AND unit = ANY('{kg,g}') ORDER BY name`, { s: d.shop_id });
    res.json({ success: true, data: { products: rows.map((p) => ({ id: p.id, name: p.name, unit: p.unit, pricePerUnit: Number(p.selling_price), barcode: p.barcode })), capacityKg: Number(d.capacity_kg) } });
  }));
  router.post('/device/sync', wrap(async (req, res) => {
    const d = await deviceAuth(req), b = ensureObject(req.body);
    if (!Array.isArray(b.readings) || b.readings.length < 1 || b.readings.length > 200) throw new HttpError(400, 'readings must be 1-200 items', 'VALIDATION_ERROR');
    const results = [];
    for (const r of b.readings) {
      const res1 = { opId: r && r.opId };
      try {
        const opId = uuid(r.opId, 'opId', { required: true }), productId = uuid(r.productId, 'productId');
        const grams = Number(r.weightGrams), tare = Number(r.tareGrams || 0);
        if (!Number.isInteger(grams) || grams < 0 || grams > 200000 || !Number.isInteger(tare) || tare < 0) throw new Error('Invalid weight');
        const at = new Date(r.measuredAt); if (isNaN(at) || at.getTime() > Date.now() + 600000) throw new Error('Invalid measuredAt');
        const overload = r.overload === true || grams > Number(d.capacity_kg) * 1000, stable = r.stable !== false;
        const [ex] = await run('SELECT line_total FROM duka_device_readings WHERE device_id=:d AND op_id=:o', { d: d.id, o: opId });
        if (ex) { results.push({ opId, status: 'duplicate', lineTotal: ex.line_total == null ? null : Number(ex.line_total) }); continue; }
        let price = null, total = null;
        if (productId) {
          const [p] = await run('SELECT unit,selling_price FROM duka_products WHERE id=:id AND shop_id=:s AND is_active', { id: productId, s: d.shop_id });
          if (!p) throw new Error('Product not in this shop');
          if (!WEIGHT_UNITS[p.unit]) throw new Error('Product is not sold by weight');
          price = Number(p.selling_price);
          total = p.unit === 'kg'
            ? Number((BigInt(Math.round(price * 100)) * BigInt(grams) + 500n) / 1000n) / 100
            : Math.round(price * grams * 100) / 100;
        }
        await run(`INSERT INTO duka_device_readings (device_id,shop_id,op_id,product_id,weight_g,tare_g,stable,overload,unit_price,line_total,measured_at)
                   VALUES (:d,:s,:o,:p,:g,:t,:st,:ov,:up,:lt,:at) RETURNING id`, { d: d.id, s: d.shop_id, o: opId, p: productId, g: grams, t: tare, st: stable, ov: overload, up: price, lt: total, at: at.toISOString() });
        results.push({ opId, status: overload ? 'recorded_overload_warning' : stable ? 'recorded' : 'recorded_unstable', lineTotal: total });
      } catch (e) { results.push({ ...res1, status: 'rejected', error: e.message }); }
    }
    await run('UPDATE duka_devices SET last_sync_at=NOW(), last_seen_at=NOW() WHERE id=:id RETURNING id', { id: d.id });
    res.json({ success: true, data: { results } });
  }));
}

function mountOwner({ router, run, tx, wrap, audit, ownedShop, HttpError, v }) {
  const { has, str, uuid, ensureObject } = v;
  const out = (d) => ({ id: d.id, serialNo: d.serial_no, label: d.label, deviceType: d.device_type, capacityKg: Number(d.capacity_kg), firmware: d.firmware, batteryPct: d.battery_pct,
    charging: d.charging, calibrationStatus: d.calibration_status, status: d.status, lastSeenAt: d.last_seen_at, lastSyncAt: d.last_sync_at, offlineReadingsSynced: d.n === undefined ? undefined : Number(d.n) });
  router.post('/shops/:shopId/devices', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = uuid(b.id, 'id', { required: true });
    const serial = str(b.serialNo, 'Serial number', { max: 60, required: true });
    if (!/^[A-Za-z0-9._-]{4,60}$/.test(serial)) throw new HttpError(400, 'Serial number may only contain letters, digits, . _ -', 'VALIDATION_ERROR');
    const type = has(b.deviceType) ? b.deviceType : 'smart_scale';
    if (!['smart_scale', 'bt_scale', 'simulator'].includes(type)) throw new HttpError(400, 'Unknown device type', 'VALIDATION_ERROR');
    const result = await tx(async (t) => {
      const shop = await ownedShop(req, { write: true, t });
      const [ex] = await run('SELECT * FROM duka_devices WHERE id=:id', { id }, t);
      if (ex) { if (ex.shop_id !== shop.id) throw new HttpError(404, 'Device not found', 'NOT_FOUND'); return { d: ex, key: null }; }
      const [dup] = await run('SELECT 1 AS x FROM duka_devices WHERE serial_no=:s', { s: serial }, t);
      if (dup) throw new HttpError(409, 'That serial number is already registered', 'DUPLICATE');
      const key = crypto.randomBytes(32).toString('hex');
      const [d] = await run(`INSERT INTO duka_devices (id,shop_id,serial_no,device_type,label,key_hash,capacity_kg,created_by) VALUES (:id,:s,:sn,:ty,:l,:h,:cap,:u) RETURNING *`,
        { id, s: shop.id, sn: serial, ty: type, l: str(b.label, 'Label', { max: 80 }), h: sha(key), cap: has(b.capacityKg) ? Math.min(Math.max(Number(b.capacityKg) || 30, 1), 200) : 30, u: req.user.id }, t);
      await audit(t, req, shop.id, 'device.register', 'device', d.id, null, { serial });
      return { d, key };
    });
    res.status(result.key ? 201 : 200).json({ success: true, data: { device: out(result.d), deviceKey: result.key, note: result.key ? 'Store this key on the device now. It is shown only once and cannot be recovered.' : 'Already registered; the key is not shown again.' } });
  }));
  router.get('/shops/:shopId/devices', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const rows = await run(`SELECT d.*, (SELECT COUNT(*) FROM duka_device_readings r WHERE r.device_id=d.id) AS n FROM duka_devices d WHERE d.shop_id=:s ORDER BY d.created_at`, { s: shop.id });
    res.json({ success: true, data: { devices: rows.map(out) } });
  }));
  router.post('/shops/:shopId/devices/:deviceId/revoke', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    if (!UUID_RE.test(req.params.deviceId)) throw new HttpError(404, 'Device not found', 'NOT_FOUND');
    const [d] = await run(`UPDATE duka_devices SET status='revoked' WHERE id=:id AND shop_id=:s RETURNING *`, { id: req.params.deviceId, s: shop.id });
    if (!d) throw new HttpError(404, 'Device not found', 'NOT_FOUND');
    res.json({ success: true, data: { device: out(d) } });
  }));
  router.get('/shops/:shopId/devices/:deviceId/readings', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    if (!UUID_RE.test(req.params.deviceId)) throw new HttpError(404, 'Device not found', 'NOT_FOUND');
    const rows = await run(`SELECT r.*, p.name FROM duka_device_readings r LEFT JOIN duka_products p ON p.id=r.product_id WHERE r.device_id=:d AND r.shop_id=:s ORDER BY r.id DESC LIMIT 100`, { d: req.params.deviceId, s: shop.id });
    res.json({ success: true, data: { readings: rows.map((r) => ({ opId: r.op_id, productId: r.product_id, name: r.name, weightGrams: r.weight_g, tareGrams: r.tare_g, stable: r.stable, overload: r.overload, unitPrice: r.unit_price == null ? null : Number(r.unit_price), lineTotal: r.line_total == null ? null : Number(r.line_total), measuredAt: r.measured_at })) } });
  }));
}
module.exports = { mountDevice, mountOwner };
