'use strict';
/**
 * NECPRA DUKA SMART — Chama (Money Circle) integration for Group Buying. Reuses the existing money_circles /
 * money_circle_members tables; creates no second Chama system and never changes a circle's balance or membership.
 *
 *   GET  /group-buy/chama/circles                         circles I am an active member of
 *   POST /group-buy/orders/:orderId/chama/link            organiser (who must be an active member) shares an order with a circle
 *   GET  /group-buy/chama/circles/:circleId/orders        members see linked orders and which circle members joined
 *   POST /group-buy/orders/:orderId/chama/funding         a participant asks the circle to fund their share
 *   GET  /group-buy/chama/circles/:circleId/funding       members see requests, votes and status
 *   POST /group-buy/chama/funding/:fundingId/vote         approve / reject (members only, never the requester)
 *   POST /group-buy/chama/funding/:fundingId/settle       circle OWNER records the payout once approved
 *   POST /group-buy/chama/funding/:fundingId/cancel       requester withdraws the request
 *
 * Money separation (explicit, because Chama funds belong to the members):
 *  - Funding is a REQUEST that needs the circle owner's approval plus a simple majority of the other active members.
 *    Nothing is approved implicitly, and the request amount can never exceed the participant's amount due.
 *  - This module does NOT move Chama money. After approval the owner pays out through the Money module and records the
 *    payout reference here; that reference is stored as "owner-recorded, unverified". The trader's order payment is a
 *    separate step that still needs a verified M-PESA receipt (duka_gb_payments), so contributions, purchasing funds and
 *    individual payments are three different records.
 *  - Every step is written to duka_gb_audit (action prefix "chama.").
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const c = (x) => Math.round(Number(x) * 100);
const m = (cents) => cents / 100;

function mount(ctx) {
  const { router, run, tx, wrap, HttpError, v } = ctx;
  const { money, uuid, str, ensureObject } = v;
  const bad = (msg, code) => new HttpError(400, msg, code || 'VALIDATION_ERROR');
  const nf = (what) => new HttpError(404, `${what} not found`, 'NOT_FOUND');
  const idp = (req, k) => { if (!UUID_RE.test(req.params[k] || '')) throw nf('Record'); return req.params[k].toLowerCase(); };
  const log = (t, orderId, userId, action, data) => run('INSERT INTO duka_gb_audit (order_id,user_id,action,data) VALUES (:o,:u,:a,:d::jsonb) RETURNING id', { o: orderId, u: userId, a: action, d: data ? JSON.stringify(data) : null }, t);

  async function circleFor(req, circleId, t) {
    const [row] = await run(`SELECT c.id, c.name, c.owner_id, c.status, c.collected_amount, mm.role
        FROM money_circles c JOIN money_circle_members mm ON mm.circle_id=c.id AND mm.user_id=:u AND mm.status='active'
        WHERE c.id=:c`, { c: circleId, u: req.user.id }, t);
    if (!row) throw new HttpError(404, 'Circle not found', 'NOT_FOUND');   // non-members learn nothing
    if (row.status !== 'active') throw new HttpError(409, 'This circle is not active', 'CIRCLE_INACTIVE');
    return row;
  }
  async function linked(orderId, circleId, t) {
    const [l] = await run('SELECT 1 AS x FROM duka_chama_links WHERE order_id=:o AND circle_id=:c', { o: orderId, c: circleId }, t);
    if (!l) throw new HttpError(409, 'This order has not been shared with that circle', 'NOT_LINKED');
  }
  /** Voting rules, recomputed from the stored votes every time. */
  async function tally(f, t) {
    const [circle] = await run('SELECT owner_id FROM money_circles WHERE id=:c', { c: f.circle_id }, t);
    const members = (await run(`SELECT user_id FROM money_circle_members WHERE circle_id=:c AND status='active'`, { c: f.circle_id }, t)).map((x) => x.user_id);
    const eligible = members.filter((u) => u !== f.requested_by);
    const required = Math.floor(eligible.length / 2) + 1;
    const votes = (await run('SELECT user_id, vote FROM duka_chama_votes WHERE funding_id=:f', { f: f.id }, t)).filter((x) => eligible.includes(x.user_id));
    const approvals = votes.filter((x) => x.vote === 'approve').length, rejections = votes.filter((x) => x.vote === 'reject').length;
    const ownerVotes = circle && f.requested_by !== circle.owner_id ? votes.find((x) => x.user_id === circle.owner_id) : null;
    const ownerNeeded = !!circle && f.requested_by !== circle.owner_id;
    const approved = approvals >= required && (!ownerNeeded || (ownerVotes && ownerVotes.vote === 'approve'));
    const rejected = (ownerNeeded && ownerVotes && ownerVotes.vote === 'reject') || rejections > eligible.length - required;
    return { eligible: eligible.length, required, approvals, rejections, ownerNeeded, ownerApproved: !!(ownerVotes && ownerVotes.vote === 'approve'), approved, rejected };
  }
  const fundingOut = (f, tl, extra = {}) => ({ id: f.id, orderId: f.order_id, circleId: f.circle_id, amount: Number(f.amount), status: f.status, createdAt: f.created_at,
    settlement: f.status === 'settled' ? { payoutRef: f.payout_ref, note: f.settle_note, settledAt: f.settled_at, verified: false, label: 'Recorded by the circle owner; not verified by NECPRA' } : null,
    voting: tl ? { eligibleVoters: tl.eligible, approvalsNeeded: tl.required, approvals: tl.approvals, rejections: tl.rejections, ownerApprovalNeeded: tl.ownerNeeded, ownerApproved: tl.ownerApproved } : undefined, ...extra });

  router.get('/group-buy/chama/circles', wrap(async (req, res) => {
    const rows = await run(`SELECT c.id, c.name, c.type, mm.role, (SELECT COUNT(*) FROM money_circle_members x WHERE x.circle_id=c.id AND x.status='active') AS members
        FROM money_circles c JOIN money_circle_members mm ON mm.circle_id=c.id AND mm.user_id=:u AND mm.status='active' WHERE c.status='active' ORDER BY c.name`, { u: req.user.id });
    res.json({ success: true, data: { circles: rows.map((r) => ({ id: r.id, name: r.name, type: r.type, role: r.role, members: Number(r.members) })) } });
  }));

  router.post('/group-buy/orders/:orderId/chama/link', wrap(async (req, res) => {
    const b = ensureObject(req.body), orderId = idp(req, 'orderId'), circleId = uuid(b.circleId, 'circleId', { required: true });
    const out = await tx(async (t) => {
      const [o] = await run('SELECT * FROM duka_gb_orders WHERE id=:id FOR UPDATE', { id: orderId }, t);
      if (!o) throw nf('Group order');
      if (o.organiser_id !== req.user.id) throw new HttpError(403, 'Only the organiser can share this order with a circle', 'FORBIDDEN');
      if (!['open', 'locked'].includes(o.status)) throw new HttpError(409, 'This order can no longer be shared', 'ORDER_NOT_OPEN');
      const circle = await circleFor(req, circleId, t);
      const [ins] = await run('INSERT INTO duka_chama_links (order_id,circle_id,linked_by) VALUES (:o,:c,:u) ON CONFLICT (order_id,circle_id) DO NOTHING RETURNING id', { o: orderId, c: circleId, u: req.user.id }, t);
      if (ins) await log(t, orderId, req.user.id, 'chama.link', { circleId });
      return { circle, created: !!ins };
    });
    res.status(out.created ? 201 : 200).json({ success: true, data: { linked: true, circle: { id: out.circle.id, name: out.circle.name }, note: 'Circle members can now see this order. Each member joins with their own shop and pays for their own share.' } });
  }));

  router.get('/group-buy/chama/circles/:circleId/orders', wrap(async (req, res) => {
    const circleId = idp(req, 'circleId'); await circleFor(req, circleId);
    const rows = await run(`SELECT o.* FROM duka_chama_links l JOIN duka_gb_orders o ON o.id=l.order_id WHERE l.circle_id=:c ORDER BY o.created_at DESC LIMIT 50`, { c: circleId });
    const orders = [];
    for (const o of rows) {
      // Only circle members' participation is shown, and only shop name, quantity and status.
      const ps = await run(`SELECT s.name AS shop_name, p.qty, p.status FROM duka_gb_participants p JOIN duka_shops s ON s.id=p.shop_id
          JOIN money_circle_members mm ON mm.user_id=p.user_id AND mm.circle_id=:c AND mm.status='active'
          WHERE p.order_id=:o AND p.status NOT IN ('withdrawn','removed') ORDER BY p.created_at`, { c: circleId, o: o.id });
      orders.push({ id: o.id, productName: o.product_name, unit: o.unit, market: o.market, status: o.status, closesAt: o.closes_at, expectedDelivery: o.expected_delivery,
        circleParticipants: ps.map((p) => ({ shopName: p.shop_name, qty: Number(p.qty), status: p.status })) });
    }
    res.json({ success: true, data: { orders } });
  }));

  router.post('/group-buy/orders/:orderId/chama/funding', wrap(async (req, res) => {
    const b = ensureObject(req.body), orderId = idp(req, 'orderId'), circleId = uuid(b.circleId, 'circleId', { required: true }), id = uuid(b.id, 'id', { required: true });
    const amount = money(b.amount, 'Amount'); if (!(amount > 0)) throw bad('Amount must be greater than zero');
    const out = await tx(async (t) => {
      const [ex] = await run('SELECT * FROM duka_chama_funding WHERE id=:id', { id }, t);
      if (ex) { if (ex.requested_by !== req.user.id) throw nf('Request'); return { f: ex, replay: true }; }
      const circle = await circleFor(req, circleId, t);
      await linked(orderId, circleId, t);
      const [p] = await run(`SELECT * FROM duka_gb_participants WHERE order_id=:o AND user_id=:u AND status IN ('joined','confirmed') FOR UPDATE`, { o: orderId, u: req.user.id }, t);
      if (!p) throw new HttpError(409, 'Join the order with your shop first (and it must not be fully paid yet)', 'NOT_A_PARTICIPANT');
      if (p.amount_due == null) throw new HttpError(409, 'The amount due is not known until the organiser locks a supplier quote', 'AMOUNT_NOT_FINAL');
      const [paid] = await run('SELECT COALESCE(SUM(amount),0) AS s FROM duka_gb_payments WHERE participant_id=:p', { p: p.id }, t);
      const remaining = c(p.amount_due) - c(paid.s);
      if (c(amount) > remaining) throw new HttpError(409, `You can ask for at most KSh ${m(Math.max(remaining, 0)).toFixed(2)} (your remaining amount due)`, 'EXCEEDS_AMOUNT_DUE');
      // Available = circle's recorded collections minus funding already approved or paid out (this module does not touch the circle balance).
      const [res1] = await run(`SELECT COALESCE(SUM(amount),0) AS s FROM duka_chama_funding WHERE circle_id=:c AND status IN ('approved','settled')`, { c: circleId }, t);
      const available = c(circle.collected_amount) - c(res1.s);
      if (c(amount) > available) throw new HttpError(409, `The circle has only KSh ${m(Math.max(available, 0)).toFixed(2)} available for purchases`, 'CIRCLE_INSUFFICIENT');
      const others = (await run(`SELECT COUNT(*) AS n FROM money_circle_members WHERE circle_id=:c AND status='active' AND user_id<>:u`, { c: circleId, u: req.user.id }, t))[0];
      if (Number(others.n) < 1) throw bad('A circle needs at least one other active member to approve funding');
      const [f] = await run('INSERT INTO duka_chama_funding (id,order_id,participant_id,circle_id,requested_by,amount) VALUES (:id,:o,:p,:c,:u,:a) RETURNING *', { id, o: orderId, p: p.id, c: circleId, u: req.user.id, a: amount }, t);
      await log(t, orderId, req.user.id, 'chama.funding.request', { fundingId: id, circleId, amount });
      return { f, tl: await tally(f, t) };
    });
    res.status(out.replay ? 200 : 201).json({ success: true, data: { funding: fundingOut(out.f, out.tl), note: 'Waiting for the circle owner and a majority of members. Nothing is paid until they approve.' } });
  }));

  router.get('/group-buy/chama/circles/:circleId/funding', wrap(async (req, res) => {
    const circleId = idp(req, 'circleId'); await circleFor(req, circleId);
    const rows = await run(`SELECT f.*, o.product_name, s.name AS shop_name FROM duka_chama_funding f JOIN duka_gb_orders o ON o.id=f.order_id
        JOIN duka_gb_participants p ON p.id=f.participant_id JOIN duka_shops s ON s.id=p.shop_id WHERE f.circle_id=:c ORDER BY f.created_at DESC LIMIT 50`, { c: circleId });
    const list = [];
    for (const f of rows) {
      const my = (await run('SELECT vote FROM duka_chama_votes WHERE funding_id=:f AND user_id=:u', { f: f.id, u: req.user.id }))[0];
      list.push(fundingOut(f, f.status === 'requested' ? await tally(f) : null, { productName: f.product_name, shopName: f.shop_name, mine: f.requested_by === req.user.id, myVote: my ? my.vote : null }));
    }
    res.json({ success: true, data: { funding: list } });
  }));

  router.post('/group-buy/chama/funding/:fundingId/vote', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idp(req, 'fundingId');
    if (!['approve', 'reject'].includes(b.vote)) throw bad('vote must be approve or reject');
    const out = await tx(async (t) => {
      const [f] = await run('SELECT * FROM duka_chama_funding WHERE id=:id FOR UPDATE', { id }, t);
      if (!f) throw nf('Request');
      await circleFor(req, f.circle_id, t);
      if (f.requested_by === req.user.id) throw new HttpError(403, 'You cannot vote on your own request', 'FORBIDDEN');
      if (f.status !== 'requested') throw new HttpError(409, 'Voting on this request has closed', 'NOT_VOTABLE');
      await run(`INSERT INTO duka_chama_votes (funding_id,user_id,vote) VALUES (:f,:u,:v) ON CONFLICT (funding_id,user_id) DO UPDATE SET vote=EXCLUDED.vote RETURNING funding_id`, { f: id, u: req.user.id, v: b.vote }, t);
      const tl = await tally(f, t);
      let next = f;
      if (tl.approved) [next] = await run(`UPDATE duka_chama_funding SET status='approved', updated_at=NOW() WHERE id=:id RETURNING *`, { id }, t);
      else if (tl.rejected) [next] = await run(`UPDATE duka_chama_funding SET status='rejected', updated_at=NOW() WHERE id=:id RETURNING *`, { id }, t);
      await log(t, f.order_id, req.user.id, 'chama.funding.vote', { fundingId: id, vote: b.vote, result: next.status });
      return { f: next, tl };
    });
    res.json({ success: true, data: { funding: fundingOut(out.f, out.tl) } });
  }));

  router.post('/group-buy/chama/funding/:fundingId/settle', wrap(async (req, res) => {
    const b = ensureObject(req.body), id = idp(req, 'fundingId');
    const ref = str(b.payoutRef, 'Payout reference', { max: 60, required: true }), note = str(b.note, 'Note', { max: 240 });
    const out = await tx(async (t) => {
      const [f] = await run('SELECT * FROM duka_chama_funding WHERE id=:id FOR UPDATE', { id }, t);
      if (!f) throw nf('Request');
      const circle = await circleFor(req, f.circle_id, t);
      if (circle.owner_id !== req.user.id) throw new HttpError(403, 'Only the circle owner can record the payout', 'FORBIDDEN');
      if (f.status !== 'approved') throw new HttpError(409, 'Only an approved request can be settled', 'NOT_APPROVED');
      const [u] = await run(`UPDATE duka_chama_funding SET status='settled', settled_by=:u, payout_ref=:r, settle_note=:n, settled_at=NOW(), updated_at=NOW() WHERE id=:id RETURNING *`, { u: req.user.id, r: ref, n: note, id }, t);
      await log(t, f.order_id, req.user.id, 'chama.funding.settle', { fundingId: id, payoutRef: ref, amount: Number(f.amount) });
      return u;
    });
    res.json({ success: true, data: { funding: fundingOut(out, null), note: 'Recorded. The trader must still pay the order with a verified M-PESA receipt; this record does not count as that payment.' } });
  }));

  router.post('/group-buy/chama/funding/:fundingId/cancel', wrap(async (req, res) => {
    const id = idp(req, 'fundingId');
    const out = await tx(async (t) => {
      const [f] = await run(`UPDATE duka_chama_funding SET status='cancelled', updated_at=NOW() WHERE id=:id AND requested_by=:u AND status IN ('requested','approved') RETURNING *`, { id, u: req.user.id }, t);
      if (!f) throw new HttpError(409, 'Only your own open request can be cancelled', 'NOT_CANCELLABLE');
      await log(t, f.order_id, req.user.id, 'chama.funding.cancel', { fundingId: id });
      return f;
    });
    res.json({ success: true, data: { funding: fundingOut(out, null) } });
  }));
}
module.exports = { mount };
