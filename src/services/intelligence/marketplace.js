'use strict';
/**
 * NECPRA Marketplace Intelligence. Pure maths first, then a thin user-scoped SQL service.
 *
 * Privacy / honesty rules:
 *  - Recommendations use the caller's OWN orders plus AGGREGATE co-purchase counts. No other buyer's identity or order is ever returned,
 *    and a co-purchase signal needs at least MIN_COBUYERS distinct buyers before it is used.
 *  - Seller insights are only ever computed for the authenticated seller's own listings and orders.
 *  - A price verdict needs at least MIN_PEERS comparable listings, otherwise it says "not enough comparable listings". It is a hint, not proof of fraud.
 *  - Categorisation only suggests categories from the app's canonical list (utils/constants), and only above a confidence threshold.
 * Ids: users / sellers / buyers are INTEGER (migration 20260626 converted the UUID columns); listings and orders are UUID.
 */
const { MARKETPLACE_CATEGORIES } = require('../../utils/constants');
const nlp = require('./nlp');

const MIN_PEERS = 5, MIN_COBUYERS = 2;
const VISIBLE = `t.status = 'active' AND t.available = TRUE AND COALESCE(t.approval_status, 'approved') = 'approved'`;

/* ───────────── categorisation (English + Kiswahili + Sheng keywords) ───────────── */
const CATEGORY_WORDS = {
  phones: ['phone', 'phones', 'smartphone', 'iphone', 'samsung', 'tecno', 'infinix', 'redmi', 'oppo', 'simu', 'android'],
  electronics: ['tv', 'television', 'speaker', 'headphones', 'earphones', 'radio', 'camera', 'charger', 'cable', 'powerbank', 'power bank', 'televisheni'],
  computing: ['laptop', 'computer', 'keyboard', 'mouse', 'monitor', 'printer', 'router', 'ssd', 'hdd', 'tablet'],
  gaming: ['playstation', 'ps4', 'ps5', 'xbox', 'console', 'gamepad', 'controller', 'nintendo'],
  appliances: ['fridge', 'refrigerator', 'microwave', 'blender', 'kettle', 'iron', 'cooker', 'washing machine', 'friji', 'jiko', 'heater'],
  furniture: ['sofa', 'couch', 'bed', 'mattress', 'table', 'chair', 'wardrobe', 'shelf', 'desk', 'meza', 'kiti', 'kitanda', 'godoro'],
  clothing: ['shirt', 'tshirt', 'dress', 'trouser', 'trousers', 'jeans', 'jacket', 'hoodie', 'skirt', 'nguo', 'shati', 'suruali'],
  fashion: ['shoes', 'sneakers', 'sandals', 'heels', 'handbag', 'bag', 'watch', 'sunglasses', 'viatu', 'mkoba', 'saa'],
  books: ['book', 'novel', 'textbook', 'kitabu', 'vitabu', 'revision'],
  beauty: ['makeup', 'lipstick', 'perfume', 'lotion', 'shampoo', 'wig', 'skincare', 'cream', 'manukato'],
  health: ['vitamin', 'supplement', 'thermometer', 'sanitizer', 'mask', 'first aid', 'dawa'],
  sports: ['football', 'jersey', 'gym', 'dumbbell', 'treadmill', 'bicycle', 'bike', 'mpira'],
  baby: ['baby', 'diaper', 'diapers', 'pram', 'stroller', 'crib', 'mtoto'],
  toys: ['toy', 'toys', 'doll', 'lego', 'puzzle', 'kichezeo'],
  food: ['maize', 'rice', 'beans', 'flour', 'sugar', 'cooking oil', 'honey', 'tea', 'coffee', 'mchele', 'unga', 'maharagwe', 'chakula', 'sukari'],
  supermarket: ['groceries', 'soap', 'detergent', 'tissue', 'toothpaste', 'bleach', 'sabuni'],
  garden: ['seedlings', 'fertilizer', 'plant', 'plants', 'garden', 'mbegu', 'mbolea'],
  automotive: ['car', 'tyre', 'tyres', 'tire', 'engine', 'spare parts', 'motorcycle', 'battery', 'gari', 'pikipiki'],
  construction: ['cement', 'iron sheets', 'bricks', 'paint', 'tiles', 'timber', 'saruji', 'mabati'],
  tutoring: ['tutor', 'tutoring', 'lessons', 'coaching', 'mwalimu', 'masomo'],
  repair: ['repair', 'fix', 'fundi', 'servicing', 'kutengeneza'],
  design: ['logo', 'graphic', 'poster', 'branding', 'flyer'],
  cleaning: ['cleaning', 'laundry', 'fumigation', 'usafi', 'kufua'],
  transport: ['delivery', 'courier', 'moving', 'taxi', 'usafiri', 'boda'],
  events: ['catering', 'dj', 'tent', 'wedding', 'decor', 'photography', 'harusi'],
  software: ['software', 'app', 'license', 'antivirus', 'website'],
  ebooks: ['ebook', 'pdf'],
  courses: ['course', 'courses', 'training', 'masterclass'],
  accommodation: ['bedsitter', 'apartment', 'hostel', 'airbnb', 'rental', 'nyumba', 'chumba']
};
const VALID = new Set(MARKETPLACE_CATEGORIES);
const CAT_RE = {};
for (const [cat, words] of Object.entries(CATEGORY_WORDS)) CAT_RE[cat] = words.map((w) => ({ w, re: new RegExp(' ' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?= )') }));

/** @returns {{suggested:string|null, confidence:number, alternatives:Array<{category,confidence}>, reason:string}} */
function categorise(title, description) {
  const t = nlp.normalize(String(title || '')), d = nlp.normalize(String(description || '').slice(0, 600));
  const scores = [];
  for (const [cat, list] of Object.entries(CAT_RE)) {
    if (!VALID.has(cat)) continue;
    let s = 0; const hits = [];
    for (const { w, re } of list) { if (re.test(t)) { s += 3; hits.push(w); } else if (re.test(d)) { s += 1; hits.push(w); } }
    if (s > 0) scores.push({ category: cat, score: s, hits });
  }
  scores.sort((a, b) => b.score - a.score);
  if (!scores.length) return { suggested: null, confidence: 0, alternatives: [], reason: 'No clear category from the words used.' };
  const total = scores.reduce((a, b) => a + b.score, 0), top = scores[0];
  const confidence = Math.round(Math.min(0.95, (top.score / total) * Math.min(1, 0.4 + top.score / 6)) * 100) / 100;
  const ok = confidence >= 0.5 && top.score >= 3;
  return { suggested: ok ? top.category : null, confidence, alternatives: scores.slice(0, 3).map((s) => ({ category: s.category, confidence: Math.round((s.score / total) * 100) / 100 })),
    reason: ok ? 'Matched: ' + top.hits.slice(0, 3).join(', ') : 'Not sure enough to suggest one; pick from the alternatives.' };
}

/* ───────────── price anomaly ───────────── */
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/** Compare one price with comparable listings (same category, same currency). */
function assessPrice(price, peerPrices) {
  const peers = (peerPrices || []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return { verdict: 'invalid', note: 'No valid price to compare.' };
  if (peers.length < MIN_PEERS) return { verdict: 'unknown', peers: peers.length, note: 'Not enough comparable listings to judge this price.' };
  const med = median(peers), mad = median(peers.map((x) => Math.abs(x - med)));
  const scale = Math.max(1.4826 * mad, 0.15 * med);                 // floor: a tight market must not flag a 5% difference
  const z = (p - med) / scale, ratio = p / med;
  const verdict = z <= -3 ? 'much_lower' : z <= -1.5 ? 'lower' : z >= 3 ? 'much_higher' : z >= 1.5 ? 'higher' : 'typical';
  const note = { much_lower: 'Far below similar listings. Check the item carefully; unusually low prices are sometimes a warning sign (not proof of one).', lower: 'Below similar listings.', typical: 'In line with similar listings.',
    higher: 'Above similar listings.', much_higher: 'Far above similar listings.' }[verdict];
  return { verdict, peers: peers.length, median: Math.round(med), ratio: Math.round(ratio * 100) / 100, range: { low: Math.round(Math.min(...peers)), high: Math.round(Math.max(...peers)) }, note, notProof: true };
}

/* ───────────── popularity ───────────── */
/** Orders matter most, then views (log-damped so a viral view count cannot dominate), then rating weighted by how many ratings there are. */
function popularityScore({ orders30 = 0, views = 0, rating = 0, ratingCount = 0 }) {
  const trust = Math.min(1, ratingCount / 10);
  return Math.round((4 * Math.log1p(orders30) + 0.4 * Math.log1p(views) + 2 * (rating / 5) * trust) * 100) / 100;
}

/* ───────────── seller insights (pure) ───────────── */
function sellerSummary({ cur, prev, fulfilment, listings, avgRating, ratingCount, avgHoursToShip }) {
  const tips = []; const sw = [];
  const pct = prev.revenue > 0 ? Math.round(((cur.revenue - prev.revenue) / prev.revenue) * 1000) / 10 : null;
  if (pct != null && pct <= -20) tips.push({ code: 'revenue_down', en: `Revenue is down ${Math.abs(pct)}% on the previous 30 days.`, sw: `Mapato yameshuka ${Math.abs(pct)}% ukilinganisha na siku 30 zilizopita.` });
  if (fulfilment.total >= 5 && fulfilment.cancelRate >= 0.2) tips.push({ code: 'high_cancel_rate', en: `${Math.round(fulfilment.cancelRate * 100)}% of recent orders were cancelled or refunded. Check stock levels and delivery promises.`, sw: `${Math.round(fulfilment.cancelRate * 100)}% ya oda za hivi karibuni zilighairiwa au kurejeshwa. Angalia stoku na ahadi za uwasilishaji.` });
  if (avgHoursToShip != null && avgHoursToShip > 72) tips.push({ code: 'slow_shipping', en: `Orders take about ${Math.round(avgHoursToShip)} hours to ship. Faster shipping usually means better reviews.`, sw: `Oda huchukua takriban saa ${Math.round(avgHoursToShip)} kusafirishwa. Kasi zaidi huleta maoni bora.` });
  const stale = listings.filter((l) => l.orders90 === 0 && l.views < 5);
  if (stale.length) tips.push({ code: 'stale_listings', en: `${stale.length} listing(s) have had almost no interest in 90 days: ${stale.slice(0, 3).map((l) => l.title).join(', ')}. Try better photos, a clearer title or a price check.`, sw: `Bidhaa ${stale.length} hazijavutia kwa siku 90: ${stale.slice(0, 3).map((l) => l.title).join(', ')}. Jaribu picha bora, jina wazi au ukague bei.` });
  const pricey = listings.filter((l) => l.priceVerdict === 'much_higher');
  if (pricey.length) tips.push({ code: 'priced_high', en: `${pricey.length} listing(s) are priced far above similar items: ${pricey.slice(0, 3).map((l) => l.title).join(', ')}.`, sw: `Bidhaa ${pricey.length} zina bei ya juu sana kuliko zinazofanana: ${pricey.slice(0, 3).map((l) => l.title).join(', ')}.` });
  if (ratingCount >= 5 && avgRating != null && avgRating < 3.5) tips.push({ code: 'low_rating', en: `Your average rating is ${avgRating} from ${ratingCount} reviews. Read the recent comments for patterns.`, sw: `Wastani wa ukadiriaji wako ni ${avgRating} kutoka maoni ${ratingCount}. Soma maoni ya hivi karibuni.` });
  void sw;
  return { revenue: { last30: cur.revenue, previous30: prev.revenue, changePct: pct }, orders: { last30: cur.orders, previous30: prev.orders }, fulfilment, rating: { average: avgRating, count: ratingCount }, avgHoursToShip, tips,
    note: tips.length ? 'These come from your own records and are suggestions, not proven causes.' : 'Nothing needs attention right now, based on your records.' };
}

/* ───────────── service ───────────── */
function createService(opts = {}) {
  const sq = opts.getSequelize || (() => require('../../models').sequelize);
  const q = (sql, r) => sq().query(sql, { replacements: r, type: 'SELECT' });

  async function peerPrices(category, currency, excludeId) {
    const rows = await q(`SELECT t.price::float AS price FROM tools t WHERE ${VISIBLE} AND t.category = :category AND COALESCE(t.currency,'KES') = :currency AND t.price > 0 AND (:ex::uuid IS NULL OR t.id <> :ex::uuid) ORDER BY t."createdAt" DESC LIMIT 300`,
      { category, currency: currency || 'KES', ex: excludeId || null });
    return rows.map((r) => r.price);
  }

  /** Price check for any VISIBLE listing, or one of the caller's own (so a seller can check a draft). */
  async function priceCheck(userId, listingId) {
    const [t] = await q(`SELECT t.id, t.title, t.price::float AS price, t.category, COALESCE(t.currency,'KES') AS currency, t.seller_id FROM tools t WHERE t.id = :id AND ((${VISIBLE}) OR t.seller_id = :uid)`, { id: String(listingId), uid: Number(userId) });
    if (!t) return { ok: false, status: 404, error: 'not_found' };
    return { ok: true, listing: { id: t.id, title: t.title, price: t.price, category: t.category }, assessment: assessPrice(t.price, await peerPrices(t.category, t.currency, t.id)) };
  }

  async function trending(limit = 10, category) {
    const rows = await q(`SELECT t.id, t.title, t.price::float AS price, t.category, t.views, t.rating::float AS rating, t.rating_count,
         (SELECT COUNT(*)::int FROM marketplace_orders o WHERE o.product_id = t.id AND o.status IN ('paid','shipped','delivered') AND o."createdAt" > NOW() - INTERVAL '30 days') AS orders30
       FROM tools t WHERE ${VISIBLE} AND (:cat::text IS NULL OR t.category = :cat) ORDER BY t."createdAt" DESC LIMIT 500`, { cat: category || null });
    return rows.map((r) => Object.assign({}, r, { score: popularityScore({ orders30: r.orders30, views: r.views, rating: r.rating, ratingCount: r.rating_count }) }))
      .sort((a, b) => b.score - a.score).slice(0, Math.min(30, Math.max(1, Number(limit) || 10)))
      .map((r) => ({ id: r.id, title: r.title, price: r.price, category: r.category, score: r.score, orders30: r.orders30 }));
  }

  /** Personalised for the caller from THEIR OWN history; falls back to trending (clearly labelled) for a new buyer. */
  async function recommend(userId, limit = 10) {
    const uid = Number(userId), lim = Math.min(30, Math.max(1, Number(limit) || 10));
    const mine = await q(`SELECT o.product_id, t.category FROM marketplace_orders o JOIN tools t ON t.id = o.product_id WHERE o.buyer_id = :uid AND o.status IN ('paid','shipped','delivered') AND o."createdAt" > NOW() - INTERVAL '180 days'`, { uid });
    if (!mine.length) return { personalised: false, basis: 'trending', note: 'You have no recent purchases, so these are popular items. They are not personalised.', items: await trending(lim) };
    const bought = mine.map((m) => m.product_id);
    const cats = {}; mine.forEach((m) => { cats[m.category] = (cats[m.category] || 0) + 1; });
    const co = await q(`SELECT o2.product_id AS id, COUNT(DISTINCT o2.buyer_id)::int AS buyers FROM marketplace_orders o1 JOIN marketplace_orders o2 ON o2.buyer_id = o1.buyer_id AND o2.product_id <> o1.product_id
        WHERE o1.product_id = ANY(CAST(:bought AS uuid[])) AND o1.buyer_id <> :uid AND o1.status IN ('paid','shipped','delivered') AND o2.status IN ('paid','shipped','delivered') GROUP BY o2.product_id HAVING COUNT(DISTINCT o2.buyer_id) >= :minb`,
      { bought: '{' + bought.join(',') + '}', uid, minb: MIN_COBUYERS });
    const coMap = new Map(co.map((c) => [c.id, c.buyers]));
    const pool = await q(`SELECT t.id, t.title, t.price::float AS price, t.category, t.views, t.rating::float AS rating, t.rating_count, t.seller_id,
         (SELECT COUNT(*)::int FROM marketplace_orders o WHERE o.product_id = t.id AND o.status IN ('paid','shipped','delivered') AND o."createdAt" > NOW() - INTERVAL '30 days') AS orders30
       FROM tools t WHERE ${VISIBLE} AND t.seller_id <> :uid AND NOT (t.id = ANY(CAST(:bought AS uuid[]))) AND (t.category = ANY(CAST(:cats AS text[])) OR t.id = ANY(CAST(:coIds AS uuid[]))) LIMIT 300`,
      { uid, bought: '{' + bought.join(',') + '}', cats: '{' + Object.keys(cats).map((c) => '"' + c.replace(/"/g, '') + '"').join(',') + '}', coIds: '{' + Array.from(coMap.keys()).join(',') + '}' });
    const items = pool.map((r) => {
      const affinity = (cats[r.category] || 0) / mine.length, cob = coMap.get(r.id) || 0;
      const score = 3 * affinity + 2 * Math.log1p(cob) + 0.3 * popularityScore({ orders30: r.orders30, views: r.views, rating: r.rating, ratingCount: r.rating_count });
      return { id: r.id, title: r.title, price: r.price, category: r.category, score: Math.round(score * 100) / 100,
        reason: cob >= MIN_COBUYERS ? { en: `Bought by ${cob} people who bought items you bought`, sw: `Imenunuliwa na watu ${cob} walionunua ulichonunua` } : { en: `You often buy ${r.category}`, sw: `Mara nyingi unanunua ${r.category}` } };
    }).sort((a, b) => b.score - a.score).slice(0, lim);
    return { personalised: true, basis: 'your_purchases', note: 'Based on your own purchases and anonymous counts of what other buyers bought together. No other buyer is identified.', items };
  }

  /** Only for the caller's own shop. */
  async function sellerInsights(userId) {
    const uid = Number(userId);
    const [cur] = await q(`SELECT COALESCE(SUM(total_price) FILTER (WHERE status IN ('paid','shipped','delivered')),0)::float AS revenue, COUNT(*) FILTER (WHERE status IN ('paid','shipped','delivered'))::int AS orders FROM marketplace_orders WHERE seller_id = :uid AND "createdAt" > NOW() - INTERVAL '30 days'`, { uid });
    const [prev] = await q(`SELECT COALESCE(SUM(total_price) FILTER (WHERE status IN ('paid','shipped','delivered')),0)::float AS revenue, COUNT(*) FILTER (WHERE status IN ('paid','shipped','delivered'))::int AS orders FROM marketplace_orders WHERE seller_id = :uid AND "createdAt" <= NOW() - INTERVAL '30 days' AND "createdAt" > NOW() - INTERVAL '60 days'`, { uid });
    const [f] = await q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('cancelled','refunded'))::int AS bad, COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered FROM marketplace_orders WHERE seller_id = :uid AND "createdAt" > NOW() - INTERVAL '90 days'`, { uid });
    const [ship] = await q(`SELECT AVG(EXTRACT(EPOCH FROM (shipped_at - paid_at)) / 3600)::float AS hours FROM marketplace_orders WHERE seller_id = :uid AND shipped_at IS NOT NULL AND paid_at IS NOT NULL AND "createdAt" > NOW() - INTERVAL '90 days'`, { uid });
    const [rv] = await q(`SELECT AVG(rating)::float AS avg, COUNT(*)::int AS n FROM marketplace_reviews WHERE seller_id = :uid`, { uid });
    const ls = await q(`SELECT t.id, t.title, t.price::float AS price, t.category, COALESCE(t.currency,'KES') AS currency, t.views,
         (SELECT COUNT(*)::int FROM marketplace_orders o WHERE o.product_id = t.id AND o.status IN ('paid','shipped','delivered') AND o."createdAt" > NOW() - INTERVAL '90 days') AS orders90
       FROM tools t WHERE t.seller_id = :uid AND t.status = 'active' ORDER BY t."createdAt" DESC LIMIT 100`, { uid });
    const priced = [];
    for (const l of ls.slice(0, 30)) priced.push(Object.assign({}, l, { priceVerdict: assessPrice(l.price, await peerPrices(l.category, l.currency, l.id)).verdict }));
    const s = sellerSummary({ cur, prev, fulfilment: { total: f.total, cancelRate: f.total ? Math.round((f.bad / f.total) * 100) / 100 : 0, delivered: f.delivered }, listings: priced.concat(ls.slice(30).map((l) => Object.assign({}, l, { priceVerdict: 'unknown' }))),
      avgRating: rv.avg == null ? null : Math.round(rv.avg * 10) / 10, ratingCount: rv.n, avgHoursToShip: ship.hours });
    return Object.assign({ ok: true, listings: ls.length }, s);
  }
  return { priceCheck, trending, recommend, sellerInsights, peerPrices };
}

const kesFmt = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
/** Read-only "tools" for the voice/chat engine: same names style as tools.js, run(name, { userId }) -> { ok, data, say:{en,sw}, kind }. */
function voiceTools(svc) {
  const list = (items) => items.slice(0, 3).map((i) => `${i.title} (${kesFmt(i.price)})`).join(', ');
  return {
    async run(name, args) {
      const userId = args && args.userId;
      if (name === 'market.trending') {
        const items = await svc.trending(5);
        if (!items.length) return { ok: true, data: { items }, say: { en: 'There is nothing trending on the marketplace yet.', sw: 'Hakuna bidhaa zinazovuma sokoni bado.' }, kind: 'retrieved' };
        return { ok: true, data: { items }, kind: 'retrieved', say: { en: `Popular on the marketplace right now: ${list(items)}.`, sw: `Zinazopendwa sokoni sasa: ${list(items)}.` } };
      }
      if (name === 'market.recommend') {
        const r = await svc.recommend(userId, 5);
        if (!r.items.length) return { ok: true, data: r, say: { en: 'I have nothing to recommend yet.', sw: 'Sina cha kupendekeza bado.' }, kind: 'retrieved' };
        return { ok: true, data: r, kind: 'retrieved', caveat: r.note, say: { en: (r.personalised ? 'Based on your purchases, you might like: ' : 'These are popular items, not personalised: ') + list(r.items) + '.', sw: (r.personalised ? 'Kulingana na ulichonunua, unaweza kupenda: ' : 'Hizi ni bidhaa maarufu, si za kukuchagulia wewe: ') + list(r.items) + '.' } };
      }
      if (name === 'market.seller') {
        const r = await svc.sellerInsights(userId);
        if (!r.listings) return { ok: true, data: r, say: { en: 'You have no active listings on the marketplace.', sw: 'Huna bidhaa zinazouzwa sokoni.' }, kind: 'retrieved' };
        const ch = r.revenue.changePct == null ? '' : ` (${r.revenue.changePct >= 0 ? '+' : ''}${r.revenue.changePct}% vs the 30 days before)`;
        const tip = r.tips[0];
        return { ok: true, data: r, kind: 'retrieved', caveat: r.note, say: {
          en: `Marketplace, last 30 days: ${kesFmt(r.revenue.last30)} from ${r.orders.last30} orders${ch}.` + (tip ? ' ' + tip.en : ''),
          sw: `Sokoni, siku 30 zilizopita: ${kesFmt(r.revenue.last30)} kutoka oda ${r.orders.last30}${ch.replace('vs the 30 days before', 'ikilinganishwa na siku 30 kabla')}.` + (tip ? ' ' + tip.sw : '') } };
      }
      return { ok: false, error: 'unknown_tool' };
    }
  };
}

module.exports = { voiceTools, categorise, assessPrice, popularityScore, sellerSummary, createService, MIN_PEERS, MIN_COBUYERS, CATEGORY_WORDS };
