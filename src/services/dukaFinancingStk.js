'use strict';
/**
 * NECPRA DUKA SMART — M-PESA prompt (STK push) for Smart Scale instalments. Uses the shared NECPRA STK ledger (mpesaStkService);
 * nothing here talks to Safaricom directly.
 *
 *   GET  /shops/:shopId/financing/pay-stk/enabled    is the prompt switched on? (so the app only offers it when it works)
 *   POST /shops/:shopId/financing/:planId/pay-stk    send the prompt   { id (uuid, one per attempt), amount (whole KSh), phone }
 *   GET  /shops/:shopId/financing/:planId/pay-stk?id=<attempt id>   where that attempt stands
 *
 * Rules:
 *  - OFF unless DUKA_FIN_STK_ENABLED=true in .env. Money is paid to the NECPRA receiving account configured for the 'main' STK profile
 *    (beneficiary type 'platform'), so the paybill/till for repayments is whatever NECPRA has set in the Daraja settings. Confirm that
 *    with NECPRA finance before switching this on.
 *  - Sending a prompt records NOTHING. A repayment is recorded only when Safaricom's callback confirms payment (stk status 'paid'); the
 *    settler below then writes it once (payment id = STK transaction id, receipt unique), so retries and replays cannot double count.
 *  - The amount asked for can never exceed the remaining balance. If the balance changed before the callback (e.g. a receipt was entered
 *    by hand in between), the money actually received is still recorded and a warning is logged for NECPRA staff to review.
 *  - A late instalment never disables the device; this module only collects payments.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const c = (x) => Math.round(Number(x) * 100);
const MODULE = 'duka_financing';
const enabled = () => String(process.env.DUKA_FIN_STK_ENABLED || '').toLowerCase() === 'true';

function mount(ctx) {
  const { router, run, tx, wrap, ownedShop, HttpError, v } = ctx;
  const { uuid, phoneKE, ensureObject, money } = v;
  const stk = require('./mpesaStkService');
  const fin = require('./dukaFinancing');
  const nf = (what) => new HttpError(404, `${what} not found`, 'NOT_FOUND');
  const planId = (req) => { if (!UUID_RE.test(req.params.planId || '')) throw nf('Plan'); return req.params.planId.toLowerCase(); };
  const paidOf = async (id, t) => c((await run('SELECT COALESCE(SUM(amount),0) AS s FROM duka_fin_payments WHERE plan_id=:p', { p: id }, t))[0].s);

  router.get('/shops/:shopId/financing/pay-stk/enabled', wrap(async (req, res) => {
    await ownedShop(req);
    res.json({ success: true, data: { enabled: enabled() } });
  }));

  router.post('/shops/:shopId/financing/:planId/pay-stk', wrap(async (req, res) => {
    if (!enabled()) throw new HttpError(503, 'M-PESA prompts for repayments are not switched on yet. Pay through NECPRA and enter the receipt code instead.', 'STK_DISABLED');
    const b = ensureObject(req.body), attempt = uuid(b.id, 'id', { required: true }), amount = money(b.amount, 'Amount');
    if (!Number.isInteger(amount) || amount < 1) throw new HttpError(400, 'Enter a whole amount in shillings', 'VALIDATION_ERROR');
    const phone = phoneKE(b.phone, 'Phone'); if (!phone) throw new HttpError(400, 'Enter the M-PESA phone number to send the prompt to', 'VALIDATION_ERROR');
    const shop = await ownedShop(req, { write: true });
    const [p] = await run('SELECT * FROM duka_fin_plans WHERE id=:id AND shop_id=:s', { id: planId(req), s: shop.id });
    if (!p) throw nf('Plan');
    if (!['approved', 'active'].includes(p.status)) throw new HttpError(409, 'This plan is not accepting payments', 'PLAN_NOT_PAYABLE');
    const remaining = c(p.device_price) - (await paidOf(p.id));
    if (c(amount) > remaining) throw new HttpError(409, `That is more than the remaining balance of KSh ${(remaining / 100).toFixed(2)}`, 'OVERPAYMENT');
    try {
      const out = await stk.initiate({
        req, module: MODULE, txType: 'device_repayment', reference: p.id, description: 'NECPRA Smart Scale instalment',
        stkReference: 'SCALEPAY', stkDesc: 'Scale payment',
        payer: { userId: req.user.id, phone }, amount,
        beneficiaries: [{ type: 'platform' }], payload: { planId: p.id, shopId: shop.id },
        idempotencyKey: `finpay:${attempt}`
      });
      res.status(201).json({ success: true, data: { attemptId: attempt, message: out.customerMessage, sandbox: !!out.sandbox, note: 'Nothing is recorded until M-PESA confirms the payment.' } });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e && e.status && e.code) throw new HttpError(e.status >= 500 ? 502 : e.status, e.message, e.code);
      throw e;
    }
  }));

  router.get('/shops/:shopId/financing/:planId/pay-stk', wrap(async (req, res) => {
    const shop = await ownedShop(req);
    const [p] = await run('SELECT id FROM duka_fin_plans WHERE id=:id AND shop_id=:s', { id: planId(req), s: shop.id });
    if (!p) throw nf('Plan');
    const attempt = String(req.query.id || ''); if (!UUID_RE.test(attempt)) throw nf('Payment attempt');
    const [t] = await run(`SELECT id,status,result_desc,mpesa_receipt FROM stk_transactions WHERE payer_user_id=:u AND module=:m AND reference=:r AND idempotency_key=:k`, { u: req.user.id, m: MODULE, r: p.id, k: `finpay:${attempt}` });
    if (!t) return res.json({ success: true, data: { state: 'unknown' } });
    const [rec] = await run('SELECT 1 AS x FROM duka_fin_payments WHERE id=:id', { id: t.id });
    const state = rec ? 'recorded' : t.status === 'paid' ? 'confirming' : ['failed', 'cancelled', 'expired', 'amount_mismatch'].includes(t.status) ? 'not_paid' : 'waiting';
    res.json({ success: true, data: { state, detail: state === 'not_paid' ? (t.result_desc || 'The payment was not completed. You have not been charged by NECPRA.') : null } });
  }));

  // Settler: called by mpesaStkService only after Safaricom confirmed the payment. Idempotent.
  stk.registerModule(MODULE, {
    async onPaid(t) {
      const planRef = String((t.payload && t.payload.planId) || t.reference || '');
      if (!UUID_RE.test(planRef)) throw new Error('Repayment has no valid plan');
      if (!t.mpesaReceipt) throw new Error('Confirmed payment has no M-PESA receipt');
      const received = Number(t.paidAmount != null ? t.paidAmount : t.amount);
      await tx(async (q) => {
        const [p] = await run('SELECT * FROM duka_fin_plans WHERE id=:id FOR UPDATE', { id: planRef }, q);
        if (!p) throw new Error('Plan not found for confirmed repayment');
        const [dup] = await run('SELECT 1 AS x FROM duka_fin_payments WHERE id=:id OR mpesa_receipt=:r', { id: t.id, r: String(t.mpesaReceipt).toUpperCase() }, q);
        if (dup) return;
        const before = await paidOf(p.id, q), price = c(p.device_price);
        await run('INSERT INTO duka_fin_payments (id,plan_id,amount,mpesa_receipt,recorded_by) VALUES (:id,:p,:a,:r,:u) RETURNING id', { id: t.id, p: p.id, a: received, r: String(t.mpesaReceipt).toUpperCase(), u: t.payerUserId }, q);
        const total = before + c(received);
        if (total > price) console.warn(`[duka-fin] repayment ${t.mpesaReceipt} pushed plan ${p.id} over its price by KSh ${((total - price) / 100).toFixed(2)}; staff should review a refund`);
        if (['approved', 'active'].includes(p.status)) {
          if (total >= price) await run(`UPDATE duka_fin_plans SET status='completed', ownership='owned', updated_at=NOW() WHERE id=:id RETURNING id`, { id: p.id }, q);
          else if (p.status === 'approved' && total >= c(p.deposit)) await run(`UPDATE duka_fin_plans SET status='active', ownership='financed', start_date=(NOW() AT TIME ZONE 'Africa/Nairobi')::date, updated_at=NOW() WHERE id=:id RETURNING id`, { id: p.id }, q);
        }
      });
      return { notApplicable: true };   // paid to NECPRA itself: there is no wallet to credit
    },
    async onFailed() {}
  });
  void fin;
}
module.exports = { mount };
