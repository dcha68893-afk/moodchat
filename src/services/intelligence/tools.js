'use strict';
/**
 * NECPRA Intelligence: secure, READ-ONLY server tools.
 *  - The engine never sees the database. It calls a tool by name with validated arguments; the tool runs fixed, parameterised SQL.
 *  - Every query is scoped to the caller: shops are looked up with `owner_id = :userId`, wallet rows with `user_id = :userId`.
 *    A shopId supplied by the client is only ever used together with that owner filter, so another user's shop returns "not found".
 *  - Tools never write. Writes (a sale, an expense, a payment) stay on the existing confirmed screens / routes.
 *  - Every answer says what it KNOWS (counted from records) versus what is PREDICTED (forecast, with a confidence label).
 */
const F = require('./forecast');

const TZ = "'Africa/Nairobi'";
const kes = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
const PERIODS = { today: [0, 0], yesterday: [1, 1], week: [6, 0], last_week: [13, 7], month: [29, 0], last_month: [59, 30] };

function createTools(opts = {}) {
  const sq = opts.getSequelize || (() => require('../../models').sequelize);
  const q = (sql, r) => sq().query(sql, { replacements: r, type: 'SELECT' });
  const todayNairobi = async () => (await q(`SELECT to_char((NOW() AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS d`))[0].d;

  async function shopFor(userId, shopId) {
    const rows = shopId
      ? await q(`SELECT id, name FROM duka_shops WHERE id = :shopId AND owner_id = :userId AND status = 'active'`, { shopId: String(shopId), userId: Number(userId) })
      : await q(`SELECT id, name FROM duka_shops WHERE owner_id = :userId AND status = 'active' ORDER BY created_at ASC LIMIT 1`, { userId: Number(userId) });
    return rows[0] || null;
  }
  const noShop = { ok: false, error: 'no_shop', say: { en: 'I could not find a DUKA shop on your account.', sw: 'Sijapata duka kwenye akaunti yako.' } };

  const daily = (table, valueSql, shopId, days) => q(
    `SELECT to_char((${table === 'sales' ? 'sold_at' : 'expense_date::timestamp'} AT TIME ZONE ${table === 'sales' ? TZ : "'UTC'"})::date,'YYYY-MM-DD') AS date, SUM(${valueSql})::float AS value
       FROM ${table === 'sales' ? "duka_sales WHERE status = 'completed'" : "duka_expenses WHERE status = 'active'"} AND shop_id = :shopId
        AND ${table === 'sales' ? 'sold_at' : 'expense_date'} >= (NOW() AT TIME ZONE ${TZ})::date - :days::int GROUP BY 1`, { shopId, days });
  const range = async (period) => { const [a, b] = PERIODS[period] || PERIODS.today; return { from: `(NOW() AT TIME ZONE ${TZ})::date - ${a}`, to: `(NOW() AT TIME ZONE ${TZ})::date - ${b}` }; };

  async function summary(shopId, period) {
    const { from, to } = await range(period);
    const [s] = await q(`SELECT COALESCE(SUM(total),0)::float AS revenue, COALESCE(SUM(cogs),0)::float AS cogs, COUNT(*)::int AS n FROM duka_sales
        WHERE shop_id = :shopId AND status = 'completed' AND (sold_at AT TIME ZONE ${TZ})::date BETWEEN ${from} AND ${to}`, { shopId });
    const [e] = await q(`SELECT COALESCE(SUM(amount),0)::float AS expenses FROM duka_expenses WHERE shop_id = :shopId AND status = 'active' AND expense_date BETWEEN ${from} AND ${to}`, { shopId });
    return { revenue: s.revenue, cogs: s.cogs, sales: s.n, expenses: e.expenses, grossProfit: s.revenue - s.cogs, netProfit: s.revenue - s.cogs - e.expenses };
  }

  const tools = {
    async 'duka.sales_summary'({ userId, shopId, period = 'today' }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const s = await summary(shop.id, period);
      return { ok: true, kind: 'known', data: Object.assign({ period }, s), say: { en: `${period}: ${s.sales} sales, ${kes(s.revenue)} taken.`, sw: `${period}: mauzo ${s.sales}, jumla ${kes(s.revenue)}.` } };
    },

    async 'duka.profit'({ userId, shopId, period = 'month' }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const s = await summary(shop.id, period);
      return { ok: true, kind: 'known', data: Object.assign({ period }, s),
        say: { en: `Net profit ${period}: ${kes(s.netProfit)} (sales ${kes(s.revenue)}, cost of goods ${kes(s.cogs)}, expenses ${kes(s.expenses)}).`, sw: `Faida halisi ${period}: ${kes(s.netProfit)} (mauzo ${kes(s.revenue)}, gharama ya bidhaa ${kes(s.cogs)}, matumizi ${kes(s.expenses)}).` } };
    },

    async 'duka.unpaid_customers'({ userId, shopId, who }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const rows = await q(`SELECT c.name, SUM(s.balance_due)::float AS owed FROM duka_sales s LEFT JOIN duka_customers c ON c.id = s.customer_id
          WHERE s.shop_id = :shopId AND s.status = 'completed' AND s.balance_due > 0 AND (:who::text IS NULL OR lower(COALESCE(c.name, s.customer_name)) LIKE lower(:like))
          GROUP BY c.name ORDER BY owed DESC LIMIT 10`, { shopId: shop.id, who: who || null, like: '%' + String(who || '') + '%' });
      const total = rows.reduce((a, r) => a + r.owed, 0);
      return { ok: true, kind: 'known', data: { customers: rows, total }, say: rows.length ? { en: `${rows.length} customer(s) owe you ${kes(total)}. Largest: ${rows[0].name || 'walk-in'} ${kes(rows[0].owed)}.`, sw: `Wateja ${rows.length} wanadaiwa ${kes(total)}. Mkubwa: ${rows[0].name || 'mteja'} ${kes(rows[0].owed)}.` } : { en: 'No customer owes you anything.', sw: 'Hakuna mteja anayekudai.' } };
    },

    async 'duka.slow_movers'({ userId, shopId }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const rows = await q(`SELECT p.id, p.name, p.stock_qty::float AS stock, p.buying_price::float AS unit_cost,
            COALESCE((SELECT SUM(i.qty) FROM duka_sale_items i JOIN duka_sales s ON s.id = i.sale_id WHERE i.product_id = p.id AND s.status = 'completed' AND s.sold_at > NOW() - INTERVAL '30 days'),0)::float AS sold,
            (SELECT EXTRACT(DAY FROM NOW() - MAX(s.sold_at))::int FROM duka_sale_items i JOIN duka_sales s ON s.id = i.sale_id WHERE i.product_id = p.id AND s.status = 'completed') AS last_days
          FROM duka_products p WHERE p.shop_id = :shopId AND p.is_active AND p.stock_qty > 0`, { shopId: shop.id });
      const list = F.slowMovers(rows.map((r) => ({ id: r.id, name: r.name, stock: r.stock, soldQtyWindow: r.sold, lastSoldDaysAgo: r.last_days, unitCost: r.unit_cost }))).slice(0, 8);
      const tied = list.reduce((a, x) => a + x.tiedUpCapital, 0);
      return { ok: true, kind: 'known', data: { items: list, tiedUpCapital: tied }, say: list.length ? { en: `${list.length} slow product(s) hold about ${kes(tied)} of stock. Slowest: ${list[0].name}.`, sw: `Bidhaa ${list.length} zinakaa, zimefunga takriban ${kes(tied)}. Polepole zaidi: ${list[0].name}.` } : { en: 'No slow-moving products found.', sw: 'Hakuna bidhaa zinazokaa.' } };
    },

    async 'duka.best_sellers'({ userId, shopId }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const rows = await q(`SELECT i.product_name AS name, SUM(i.qty)::float AS qty, SUM(i.line_total - i.qty * i.unit_cost)::float AS margin FROM duka_sale_items i JOIN duka_sales s ON s.id = i.sale_id
          WHERE s.shop_id = :shopId AND s.status = 'completed' AND s.sold_at > NOW() - INTERVAL '30 days' GROUP BY i.product_name ORDER BY margin DESC LIMIT 5`, { shopId: shop.id });
      return { ok: true, kind: 'known', data: { items: rows }, say: rows.length ? { en: `Top earners (30 days): ${rows.map((r) => `${r.name} ${kes(r.margin)}`).join(', ')}.`, sw: `Zinazoleta faida (siku 30): ${rows.map((r) => `${r.name} ${kes(r.margin)}`).join(', ')}.` } : { en: 'No sales in the last 30 days.', sw: 'Hakuna mauzo siku 30 zilizopita.' } };
    },

    async 'duka.restock'({ userId, shopId }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const rows = await q(`SELECT p.id, p.name, p.stock_qty::float AS stock, p.min_stock::float AS min_stock,
            COALESCE((SELECT SUM(i.qty) FROM duka_sale_items i JOIN duka_sales s ON s.id = i.sale_id WHERE i.product_id = p.id AND s.status = 'completed' AND s.sold_at > NOW() - INTERVAL '28 days'),0)::float AS sold28,
            (SELECT COUNT(DISTINCT (s.sold_at AT TIME ZONE ${TZ})::date) FROM duka_sale_items i JOIN duka_sales s ON s.id = i.sale_id WHERE i.product_id = p.id AND s.status = 'completed' AND s.sold_at > NOW() - INTERVAL '28 days')::int AS days
          FROM duka_products p WHERE p.shop_id = :shopId AND p.is_active`, { shopId: shop.id });
      const out = [];
      for (const r of rows) {
        const avg = r.sold28 / 28;
        const ro = F.reorderQuantity({ stock: r.stock, avgDaily: avg, sigmaDaily: avg * 0.5 });
        const conf = r.days >= 12 ? 'moderate' : r.days >= 5 ? 'preliminary' : 'insufficient';
        if (ro.qty > 0 && conf !== 'insufficient') out.push({ id: r.id, name: r.name, stock: r.stock, suggestedQty: ro.qty, daysOfStock: ro.daysOfStock, confidence: conf });
        else if (r.stock <= r.min_stock && r.min_stock > 0) out.push({ id: r.id, name: r.name, stock: r.stock, suggestedQty: null, daysOfStock: null, confidence: 'insufficient', note: 'Below your minimum level; not enough sales history to suggest a quantity.' });
      }
      out.sort((a, b) => (a.daysOfStock == null ? 1e9 : a.daysOfStock) - (b.daysOfStock == null ? 1e9 : b.daysOfStock));
      const top = out.slice(0, 8);
      return { ok: true, kind: 'predicted', data: { items: top, method: 'avg daily sales over 28 days, 2-day lead time + 7-day cover + safety buffer', estimate: true },
        say: top.length ? { en: `Consider restocking: ${top.slice(0, 4).map((x) => x.name + (x.suggestedQty ? ' (~' + x.suggestedQty + ')' : '')).join(', ')}. These are estimates from your recent sales.`, sw: `Fikiria kuagiza: ${top.slice(0, 4).map((x) => x.name + (x.suggestedQty ? ' (~' + x.suggestedQty + ')' : '')).join(', ')}. Haya ni makadirio kutokana na mauzo yako ya hivi karibuni.` } : { en: 'Nothing needs restocking right now, based on recent sales.', sw: 'Hakuna kinachohitaji kuagizwa sasa, kulingana na mauzo ya hivi karibuni.' } };
    },

    async 'duka.forecast'({ userId, shopId, period }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const today = await todayNairobi();
      const rows = await daily('sales', 'total', shop.id, 90);
      const from = rows.length ? rows.map((r) => r.date).sort()[0] : today;
      const r = F.forecastSeries(F.dailySeries(rows, from, today), period === 'month' ? 30 : 7);
      if (!r.forecast) return { ok: true, kind: 'predicted', data: r, say: { en: 'There is not enough sales history yet to forecast honestly. Keep recording sales and ask again in a couple of weeks.', sw: 'Bado hakuna historia ya kutosha ya mauzo kukadiria. Endelea kurekodi mauzo, uliza tena baada ya wiki mbili.' } };
      const label = r.confidence === 'preliminary' ? 'early estimate' : r.confidence;
      return { ok: true, kind: 'predicted', data: r, say: { en: `Expected sales next ${period === 'month' ? '30' : '7'} days: about ${kes(r.forecast.total)} (likely between ${kes(r.forecast.low)} and ${kes(r.forecast.high)}; ${label}).`, sw: `Mauzo yanayotarajiwa siku ${period === 'month' ? '30' : '7'} zijazo: takriban ${kes(r.forecast.total)} (huenda kati ya ${kes(r.forecast.low)} na ${kes(r.forecast.high)}; ${label}).` } };
    },

    async 'duka.why'({ userId, shopId }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const cur = await summary(shop.id, 'week'), prev = await summary(shop.id, 'last_week');
      const cmp = F.compareWindows([cur.revenue], [prev.revenue]);
      const drivers = [];
      if (cur.sales !== prev.sales) drivers.push({ en: `number of sales ${prev.sales} -> ${cur.sales}`, sw: `idadi ya mauzo ${prev.sales} -> ${cur.sales}` });
      const avgC = cur.sales ? cur.revenue / cur.sales : 0, avgP = prev.sales ? prev.revenue / prev.sales : 0;
      if (avgP && Math.abs(avgC - avgP) / avgP > 0.1) drivers.push({ en: `average sale ${kes(avgP)} -> ${kes(avgC)}`, sw: `wastani wa mauzo ${kes(avgP)} -> ${kes(avgC)}` });
      if (Math.abs(cur.expenses - prev.expenses) > 0.1 * Math.max(prev.expenses, 1)) drivers.push({ en: `expenses ${kes(prev.expenses)} -> ${kes(cur.expenses)}`, sw: `matumizi ${kes(prev.expenses)} -> ${kes(cur.expenses)}` });
      const prods = await q(`WITH w AS (SELECT i.product_name AS n, SUM(i.line_total) FILTER (WHERE (s.sold_at AT TIME ZONE ${TZ})::date > (NOW() AT TIME ZONE ${TZ})::date - 7)::float AS cur,
              SUM(i.line_total) FILTER (WHERE (s.sold_at AT TIME ZONE ${TZ})::date <= (NOW() AT TIME ZONE ${TZ})::date - 7)::float AS prev
            FROM duka_sale_items i JOIN duka_sales s ON s.id = i.sale_id WHERE s.shop_id = :shopId AND s.status = 'completed' AND s.sold_at > NOW() - INTERVAL '14 days' GROUP BY i.product_name)
          SELECT n, COALESCE(cur,0) - COALESCE(prev,0) AS diff FROM w ORDER BY abs(COALESCE(cur,0) - COALESCE(prev,0)) DESC LIMIT 2`, { shopId: shop.id });
      prods.forEach((p) => drivers.push({ en: `${p.n} ${p.diff >= 0 ? 'rose' : 'fell'} by ${kes(Math.abs(p.diff))}`, sw: `${p.n} ${p.diff >= 0 ? 'imepanda' : 'imeshuka'} kwa ${kes(Math.abs(p.diff))}` }));
      const dir = { up: ['up', 'juu'], down: ['down', 'chini'], flat: ['unchanged', 'sawa'] }[cmp.direction];
      return { ok: true, kind: 'known', data: { thisWeek: cur, lastWeek: prev, comparison: cmp, drivers }, caveat: 'These are what changed in your records; they are not proven causes.',
        say: { en: `Sales this week ${kes(cmp.current)} vs ${kes(cmp.previous)} last week (${dir[0]}${cmp.pct != null ? ' ' + cmp.pct + '%' : ''}). What changed: ${drivers.map((d) => d.en).join('; ') || 'nothing notable'}. These are changes in your records, not proven causes.`,
          sw: `Mauzo wiki hii ${kes(cmp.current)} dhidi ya ${kes(cmp.previous)} wiki iliyopita (${dir[1]}${cmp.pct != null ? ' ' + cmp.pct + '%' : ''}). Kilichobadilika: ${drivers.map((d) => d.sw).join('; ') || 'hakuna cha kutajwa'}. Hizi ni mabadiliko kwenye rekodi zako, si sababu zilizothibitishwa.` } };
    },

    async 'duka.expense_review'({ userId, shopId }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const rows = await q(`SELECT category, SUM(amount) FILTER (WHERE expense_date > (NOW() AT TIME ZONE ${TZ})::date - 30)::float AS cur, SUM(amount) FILTER (WHERE expense_date <= (NOW() AT TIME ZONE ${TZ})::date - 30 AND expense_date > (NOW() AT TIME ZONE ${TZ})::date - 60)::float AS prev
          FROM duka_expenses WHERE shop_id = :shopId AND status = 'active' AND expense_date > (NOW() AT TIME ZONE ${TZ})::date - 60 GROUP BY category`, { shopId: shop.id });
      const flagged = rows.filter((r) => (r.cur || 0) > 0 && (r.prev || 0) > 0 && r.cur > r.prev * 1.5 && r.cur - r.prev >= 500).map((r) => ({ category: r.category, last30: r.cur, before: r.prev }));
      const top = rows.slice().sort((a, b) => (b.cur || 0) - (a.cur || 0))[0];
      return { ok: true, kind: 'known', data: { flagged, biggest: top ? { category: top.category, last30: top.cur } : null }, caveat: 'Only you know whether a cost is necessary; this flags what grew.',
        say: flagged.length ? { en: `Expenses that grew a lot: ${flagged.map((f) => `${f.category} ${kes(f.before)} -> ${kes(f.last30)}`).join('; ')}. Worth checking whether they are needed.`, sw: `Matumizi yaliyoongezeka sana: ${flagged.map((f) => `${f.category} ${kes(f.before)} -> ${kes(f.last30)}`).join('; ')}. Angalia kama ni ya lazima.` } : { en: top ? `No expense grew sharply. Your biggest category is ${top.category} (${kes(top.cur)} in 30 days).` : 'No expenses recorded yet.', sw: top ? `Hakuna matumizi yaliyopanda sana. Kubwa zaidi ni ${top.category} (${kes(top.cur)} siku 30).` : 'Hakuna matumizi yaliyorekodiwa.' } };
    },

    async 'duka.anomalies'({ userId, shopId }) {
      const shop = await shopFor(userId, shopId); if (!shop) return noShop;
      const today = await todayNairobi();
      const rows = await daily('sales', 'total', shop.id, 60);
      if (!rows.length) return { ok: true, kind: 'known', data: { anomalies: [] }, say: { en: 'No sales recorded yet, so nothing to compare.', sw: 'Hakuna mauzo yaliyorekodiwa bado.' } };
      const from = rows.map((r) => r.date).sort()[0];
      const found = F.detectAnomalies(F.dailySeries(rows, from, today)).slice(-5);
      return { ok: true, kind: 'predicted', data: { anomalies: found }, caveat: 'Unusual does not mean wrong; check the day.',
        say: found.length ? { en: `Unusual days: ${found.map((a) => `${a.date} ${kes(a.value)} (normally ~${kes(a.expected)})`).join('; ')}.`, sw: `Siku zisizo za kawaida: ${found.map((a) => `${a.date} ${kes(a.value)} (kawaida ~${kes(a.expected)})`).join('; ')}.` } : { en: 'Nothing unusual in your recent sales.', sw: 'Hakuna kisicho cha kawaida kwenye mauzo yako ya hivi karibuni.' } };
    },

    async 'finance.find_transaction'({ userId, amount }) {
      const rows = await q(`SELECT id, type, amount::float AS amount, description, "createdAt" AS at FROM wallet_transactions WHERE user_id = :userId AND (:amount::numeric IS NULL OR amount = :amount::numeric) ORDER BY "createdAt" DESC LIMIT 5`, { userId: Number(userId), amount: amount || null });
      return { ok: true, kind: 'known', data: { items: rows }, say: rows.length ? { en: `Most recent: ${rows.map((r) => `${r.type === 'debit' ? 'sent' : 'received'} ${kes(r.amount)}${r.description ? ' (' + r.description + ')' : ''}`).slice(0, 3).join('; ')}.`, sw: `Za hivi karibuni: ${rows.map((r) => `${r.type === 'debit' ? 'ulituma' : 'ulipokea'} ${kes(r.amount)}`).slice(0, 3).join('; ')}.` } : { en: 'I found no matching transaction.', sw: 'Sijapata muamala unaolingana.' } };
    }
  };
  return { tools, run: (name, args) => (tools[name] ? tools[name](args) : Promise.resolve({ ok: false, error: 'unknown_tool' })), names: Object.keys(tools) };
}

module.exports = { createTools, kes };
