'use strict';
/**
 * NECPRA ecosystem glue: Groups <-> Chama (Money Circle) <-> Wallet payments <-> Messenger updates <-> DUKA group buying.
 * One action creates connected records, so members never type the same thing twice.
 *
 *  - A Chama can be linked to a group chat: circle.settings.groupChatId (no schema change).
 *  - Linking adds the group's members to the Chama (they get the usual "you were added" notice) and tells them.
 *  - Every verified contribution (M-PESA, wallet, or cash recorded by the owner) is announced to the circle:
 *    who paid, amount collected, how many have paid, who is still outstanding.
 *  - DUKA group-buy steps (quotation, locked, confirmed, delivery, cancelled) are announced to every linked circle.
 *  - Updates are durable in-app notifications that carry groupChatId, so the app can show them as the group's feed.
 *    Group CHAT messages are end-to-end encrypted: the server cannot write into the conversation (it has no key),
 *    so nothing here pretends to. The notices are delivered to each member instead.
 */
const W = require('./moneyReminderWorker');
const fmt = (n) => 'KSh ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });

const groupChatIdOf = (circle) => { const v = Number(circle && circle.settings && circle.settings.groupChatId); return Number.isInteger(v) && v > 0 ? v : null; };

async function activeMemberIds(d, circleId) {
  const rows = await d.MoneyCircleMember.findAll({ where: { circleId, status: 'active' }, attributes: ['userId'] });
  return rows.map((r) => Number(r.userId)).filter((n) => n > 0);
}

/** Notify every active circle member (optionally except one). Never throws: an update must not break a payment. */
async function announce(d, circle, kind, title, body, opts = {}) {
  try {
    const svc = require('./notificationService');
    const ids = await activeMemberIds(d, circle.id);
    const groupChatId = groupChatIdOf(circle);
    await Promise.all(ids.filter((id) => id !== opts.exceptUserId).map((uid) => svc.createNotification(uid, {
      type: 'system', title: String(title).slice(0, 200), body: String(body).slice(0, 500),
      data: { kind: 'ecosystem_' + kind, circleId: circle.id, groupChatId, orderId: opts.orderId || null, module: opts.module || 'money' },
      actionUrl: opts.actionUrl || '/money.html', priority: 'high'
    }).catch((e) => console.warn('[ecosystem] notify failed', e.message))));
  } catch (e) { console.warn('[ecosystem] announce failed', e.message); }
}

/** Who has paid this cycle, who has not. Uses the same verified-payment rule as the reminders. */
async function summary(d, circle) {
  const sched = (circle.settings && circle.settings.schedule) || {};
  const [members, paid] = await Promise.all([
    d.MoneyCircleMember.findAll({ where: { circleId: circle.id, status: 'active' }, attributes: ['userId', 'role'] }),
    W.paidByMember(d, circle)
  ]);
  const need = Number(sched.amountPerMember || 0);
  const rows = members.map((m) => { const p = paid.get(Number(m.userId)) || 0; return { userId: Number(m.userId), paid: p, hasPaid: W.hasPaid(sched, p), owes: need > 0 ? Math.max(0, need - p) : 0 }; });
  return { memberCount: rows.length, paidCount: rows.filter((r) => r.hasPaid).length, collected: Number(circle.collectedAmount || 0), amountPerMember: need || null, dueDate: sched.dueDate || null, members: rows };
}

async function announcePaid(d, circleId, contributorId, amount) {
  try {
    const circle = await d.MoneyCircle.findByPk(circleId); if (!circle) return;
    const s = await summary(d, circle);
    let who = 'A member';
    if (contributorId) { const U = d.User || d.Users; const u = U ? await U.findByPk(contributorId, { attributes: ['id', 'username', 'firstName', 'lastName'] }).catch(() => null) : null; if (u) who = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || who; }
    const tail = s.amountPerMember ? ` ${s.paidCount} of ${s.memberCount} have paid.` : '';
    await announce(d, circle, 'paid', circle.name + ': payment received', `${who} paid ${fmt(amount)}. Collected so far: ${fmt(s.collected)}.${tail}`, { exceptUserId: Number(contributorId) || undefined });
  } catch (e) { console.warn('[ecosystem] announcePaid failed', e.message); }
}

/** Add every member of the group chat to the Chama. Returns how many were newly added. */
async function syncGroupMembers(d, circle, chatId) {
  const CP = d.ChatParticipant; if (!CP) return 0;
  const people = await CP.findAll({ where: { chatId }, attributes: ['userId'] });
  let added = 0; const svc = W;
  for (const p of people) {
    const userId = Number(p.userId); if (!userId || userId === Number(circle.ownerId)) continue;
    const [m, created] = await d.MoneyCircleMember.findOrCreate({ where: { circleId: circle.id, userId }, defaults: { circleId: circle.id, userId, role: 'member', status: 'active' } });
    if (!created && m.status !== 'active') await m.update({ status: 'active' });
    if (created) { added++; try { await svc.notify(userId, circle, 'You were added to "' + circle.name + '"', 'Your group created this chama. Open Money to see your contribution.', 'added'); } catch (_) { /* best effort */ } }
  }
  return added;
}

/** The caller must be an admin of the group chat to attach a Chama to it. */
async function isGroupAdmin(d, chatId, userId) {
  const CP = d.ChatParticipant; if (!CP) return false;
  const p = await CP.findOne({ where: { chatId, userId }, attributes: ['role'] });
  return !!p && p.role === 'admin';
}

async function linkCircleToGroup(d, circle, chatId) {
  const settings = { ...(circle.settings || {}), groupChatId: chatId };
  circle.settings = settings; circle.changed('settings', true); await circle.save();
  const added = await syncGroupMembers(d, circle, chatId);
  await announce(d, circle, 'linked', 'Chama linked to your group: ' + circle.name, 'Contributions, payment updates and group-buy orders will now be shared with this group.', { exceptUserId: Number(circle.ownerId) });
  return added;
}

/** Group-buy orders shared with this circle (duka_chama_links). Tolerates the DUKA tables not existing yet. */
async function linkedOrders(d, circleId) {
  try {
    const [rows] = await d.sequelize.query(`SELECT o.id, o.product_name, o.unit, o.status, o.closes_at, o.market FROM duka_chama_links l JOIN duka_gb_orders o ON o.id=l.order_id WHERE l.circle_id=:c ORDER BY o.created_at DESC LIMIT 20`, { replacements: { c: circleId } });
    return rows.map((o) => ({ id: o.id, product: o.product_name, unit: o.unit, status: o.status, closesAt: o.closes_at, market: o.market }));
  } catch (_) { return []; }
}

module.exports = { groupChatIdOf, announce, announcePaid, summary, syncGroupMembers, isGroupAdmin, linkCircleToGroup, linkedOrders };
