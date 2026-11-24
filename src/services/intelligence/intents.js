'use strict';
/**
 * NECPRA Intelligence: intent recognition + entity (slot) extraction. Offline, deterministic, no model download.
 *
 *  - Vocabulary lives in LEX (English / Kiswahili / Sheng). To teach a new word or language: add it to a group. No code changes.
 *  - Each RULE needs ALL its groups present and NONE of its "not" groups. The best rule wins. If two *different* intents score
 *    within AMBIGUITY_MARGIN the engine asks the user instead of guessing. A missing required slot also produces a question.
 *  - Intents that map to an existing on-screen action reuse the registry in ../voiceActions.js (validation + canonical phrase),
 *    so every confirmation rule of the frontend keeps working. Intents with a `tool` run a read-only, user-scoped server tool.
 *  - Nothing here executes anything. Output = { intent, confidence, slots, ... } for engine.js to route.
 */
const nlp = require('./nlp');

const LEX = {
  BAL: ['balance', 'salio', 'pochi yangu', 'wallet balance', 'how much money', 'how much do i have', 'how much have i got', 'pesa ngapi', 'nina pesa ngapi', 'pesa zangu ngapi', 'money do i have', 'pesa zilizobaki', 'nina hela ngapi', 'kiasi kilichobaki', 'money in my wallet', 'pesa nilizonazo', 'hela zangu'],
  TXN: ['transaction', 'transactions', 'miamala', 'muamala', 'statement', 'payment history', 'recent payments', 'malipo ya hivi karibuni', 'historia ya malipo', 'malipo yangu', 'my payments'],
  RECV: ['received', 'receive', 'got paid', 'nimepokea', 'nilipokea', 'nimepewa', 'wamenitumia', 'incoming', 'imeingia'],
  SPENT: ['spent', 'spend', 'spending', 'nimetumia', 'nilitumia', 'matumizi', 'nimelipa', 'nimetoa'],
  HOWMUCH: ['how much', 'kiasi gani', 'kiasi', 'ngapi', 'jumla', 'total'],
  SENDV: ['send', 'pay', 'transfer', 'tuma', 'lipa', 'mtumie', 'nitumie', 'mpe', 'give'],
  CHAMA: ['chama', 'chamas', 'michango', 'mchango', 'contribution', 'contributions', 'merry go round', 'table banking', 'money circle', 'circle'],
  NOTPAID: ['not contributed', 'has not contributed', 'have not contributed', 'hasnt contributed', 'havent contributed', 'not paid', 'unpaid', 'outstanding', 'owe', 'owes', 'owing', 'hawajalipa', 'hajalipa', 'hawajachanga', 'hajachanga', 'bado hawajalipa', 'defaulters', 'wanadaiwa', 'deni', 'madeni', 'hawajaleta', 'overdue', 'behind on'],
  DUEW: ['due', 'zinatakiwa', 'zinadaiwa', 'expected', 'required', 'this month'],
  PRODUCTW: ['product', 'products', 'bidhaa', 'item', 'items', 'vitu', 'goods', 'inventory', 'mzigo', 'mali'],
  COUNTQ: ['how many', 'number of', 'count', 'idadi', 'ngapi', 'wangapi', 'zangapi', 'mangapi'],
  LOW: ['running low', 'running out', 'run out', 'low on', 'low stock', 'out of stock', 'finished', 'sold out', 'finishing', 'almost finished', 'zinaisha', 'zinakwisha', 'zimeisha', 'zinakaribia kuisha', 'zinazoisha', 'zinazokaribia kuisha', 'zilizoisha', 'zinakaribia kwisha', 'zinazokwisha', 'inaisha', 'chache', 'few left', 'shortage', 'stock ndogo'],
  STOCKW: ['stock', 'stoku', 'left', 'remaining', 'zimebaki', 'imebaki', 'zilizobaki', 'iliyobaki', 'zimesalia', 'imesalia', 'zilizopo', 'iliyopo', 'in stock'],
  CUST: ['customers', 'customer', 'wateja', 'mteja', 'clients', 'client', 'buyers', 'wanunuzi'],
  SALESW: ['sales', 'sold', 'sell', 'takings', 'mauzo', 'revenue', 'mapato', 'turnover', 'business', 'biashara', 'income'],
  PROFIT: ['profit', 'profits', 'faida', 'gain', 'gains', 'net profit', 'earned', 'nimepata', 'tumepata', 'we made', 'did we make', 'make this month', 'made this month'],
  WHYQ: ['why', 'kwa nini', 'nini kimesababisha', 'sababu', 'explain', 'eleza', 'how come', 'what caused', 'reason'],
  UPDOWN: ['drop', 'dropped', 'down', 'decrease', 'decreased', 'fell', 'lower', 'less', 'imeshuka', 'imepungua', 'increase', 'increased', 'up', 'rose', 'higher', 'more', 'imeongezeka', 'imepanda', 'change', 'changed'],
  BUYQ: ['should i buy', 'should i purchase', 'should i restock', 'what to buy', 'what to purchase', 'what to restock', 'purchase', 'restock', 'reorder', 'order more', 'agiza', 'niagize', 'nunue nini', 'ninunue', 'nikununue', 'nunua nini', 'nahitaji kuagiza', 'need to buy', 'need to order', 'to buy', 'to order'],
  SLOW: ['slow moving', 'slow mover', 'slow movers', 'not selling', 'dont sell', 'hazinunuliwi', 'hazitoki', 'zinakaa', 'zinazokaa', 'zinazokaa sana', 'dead stock', 'zimekaa', 'hazitoki sana', 'slowest', 'worst selling', 'least selling'],
  BEST: ['best selling', 'top selling', 'bestsellers', 'best seller', 'most sold', 'zinazouzwa zaidi', 'zinazotoka', 'popular', 'most profitable', 'best products'],
  DEBT: ['owes me', 'owe me', 'who owes', 'madeni', 'deni', 'wanadaiwa', 'wanaonidai', 'credit customers', 'on credit', 'unpaid customers', 'wateja wanaodaiwa', 'receivables', 'hawajanilipa', 'wamenidai', 'hawajalipa', 'wanaodaiwa', 'wanaonidai', 'not paid me', 'havent paid me', 'wakopaji', 'wamekopa'],
  EXPV: ['expense', 'expenses', 'gharama', 'matumizi ya duka', 'spent on', 'nimelipia', 'nililipia', 'rekodi gharama', 'record expense', 'add expense', 'i paid for', 'paid for'],
  SALEV: ['i sold', 'we sold', 'nimeuza', 'niliuza', 'tumeuza', 'nimeuzia', 'tumeuzia', 'customer bought', 'amenunua', 'wamenunua'],
  UNNEC: ['unnecessary', 'wasteful', 'waste', 'cut', 'reduce', 'save on', 'cost cutting', 'zisizo za lazima', 'punguza', 'kupunguza', 'too much on', 'overspending', 'where am i spending', 'wapi natumia'],
  FORECAST: ['forecast', 'predict', 'prediction', 'expect', 'next week', 'next month', 'tomorrow', 'will sell', 'future', 'estimate', 'projection', 'wiki ijayo', 'mwezi ujao', 'kesho', 'itauza', 'nitauza'],
  ANOMALY: ['unusual', 'strange', 'odd', 'suspicious', 'abnormal', 'weird', 'not normal', 'anomaly', 'ajabu', 'si kawaida', 'kitu cha ajabu'],
  FIND: ['find', 'search', 'look for', 'looking for', 'tafuta', 'nitafutie', 'show me', 'where is', 'angalia', 'previous', 'earlier', 'last', 'past', 'old', 'ya zamani', 'iliyopita', 'ya mwisho'],
  TXNW: ['transaction', 'payment', 'transfer', 'malipo', 'muamala', 'mamlaka', 'miamala', 'receipt', 'risiti', 'mpesa'],
  REMIND: ['remind me', 'reminder', 'remind', 'nikumbushe', 'kumbusha', 'nikumbushie', 'niwekee kumbukumbu', 'set a reminder', 'weka kikumbusho', 'kikumbusho'],
  MSGW: ['message', 'messages', 'ujumbe', 'texts', 'sms', 'meseji', 'inbox'],
  UNREAD: ['unread', 'new', 'mpya', 'pending', 'waiting', 'hazijasomwa', 'latest', 'za mwisho'],
  MSGSEND: ['send a message', 'send message', 'message', 'tumia ujumbe', 'mtumie ujumbe', 'mwandikie', 'andika ujumbe', 'dm', 'chat with', 'write to'],
  FRIENDW: ['friend', 'friends', 'rafiki', 'marafiki', 'mshikaji', 'washikaji', 'buddy', 'mate', 'jamaa'],
  GROUPW: ['group', 'groups', 'kikundi', 'vikundi'],
  GAMECOINS: ['coins', 'coin', 'sarafu'],
  BACKW: ['go back', 'back', 'rudi nyuma', 'rudi', 'nyuma'],
  OPENV: ['open', 'show', 'go to', 'take me to', 'fungua', 'nionyeshe', 'onyesha', 'nipeleke', 'nenda', 'ingia'],
  PAGE_MESSAGES: ['messenger', 'messages', 'chats', 'ujumbe', 'mazungumzo'],
  PAGE_MONEY: ['wallet', 'money', 'pochi', 'pesa', 'chama'],
  PAGE_FRIENDS: ['friends', 'marafiki'],
  PAGE_TOOLS: ['duka', 'shop', 'duka smart', 'tools', 'duka langu'],
  PAGE_GROUP: ['groups', 'vikundi'],
  PAGE_STATUS: ['status', 'hali'],
  PAGE_SETTINGS: ['settings', 'mipangilio'],
  PAGE_GAMES: ['games', 'michezo'],
  STOP: ['please', 'pls', 'kindly', 'tafadhali', 'naomba', 'nataka', 'hey', 'ok', 'okay', 'the', 'a', 'an', 'my', 'me', 'i', 'we', 'our', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'have', 'has', 'got', 'to', 'for', 'from', 'of', 'in', 'on', 'at', 'and', 'it', 'this', 'that', 'there', 'with', 'be', 'by', 'about', 'some', 'yangu', 'zangu', 'wangu', 'langu', 'ya', 'wa', 'za', 'la', 'kwa', 'na', 'kutoka', 'huyu', 'huu', 'hii', 'hizi', 'ni', 'je', 'can', 'you', 'could', 'would', 'will', 'what', 'which', 'who', 'whom', 'nani', 'gani', 'nini', 'kuna', 'tu', 'basi', 'sasa']
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = {};
for (const [k, words] of Object.entries(LEX)) {
  const w = words.map((x) => x.toLowerCase()).sort((a, b) => b.length - a.length).map(esc);
  RE[k] = { test: new RegExp(' (?:' + w.join('|') + ')(?= )'), strip: new RegExp(' (?:' + w.join('|') + ')(?= )', 'g') };
}
RE.AMT = { test: /\s\d+(?:\.\d+)?\s/, strip: /\s\d+(?:\.\d+)?\s/g };
const has = (g, t) => RE[g].test.test(t);

// Rules. `ui` = id in voiceActions registry; `tool` = read-only server tool (see tools.js). `weight` is the base confidence.
const R = (intent, weight, all, not, extra) => Object.assign({ intent, weight, all, not: not || [] }, extra || {});
const RULES = [
  // ── money ──
  R('money.balance', 0.9, ['BAL'], ['SENDV'], { ui: 'money.balance' }),
  R('money.balance', 0.7, ['HOWMUCH', 'PAGE_MONEY'], ['SPENT', 'RECV', 'CHAMA', 'SENDV', 'SALESW', 'PROFIT'], { ui: 'money.balance' }),
  R('money.transactions', 0.85, ['TXN'], ['FIND', 'CHAMA'], { ui: 'money.transactions' }),
  R('money.received', 0.85, ['RECV', 'HOWMUCH'], ['SALESW'], { ui: 'money.received' }),
  R('money.spent', 0.85, ['SPENT', 'HOWMUCH'], ['EXPV', 'SENDV'], { ui: 'money.spent', slotsFrom: ['period'], periodEnum: ['today', 'month'] }),
  R('money.chama_outstanding', 0.9, ['CHAMA', 'NOTPAID'], [], { ui: 'money.chama_outstanding' }),
  R('money.chama_outstanding', 0.8, ['NOTPAID', 'CHAMA'], [], { ui: 'money.chama_outstanding' }),
  R('money.chama_month', 0.8, ['CHAMA', 'DUEW'], ['NOTPAID'], { ui: 'money.chama_month' }),
  R('money.prepare_transfer', 0.85, ['SENDV'], ['MSGW', 'MSGSEND', 'EXPV', 'SALEV', 'REMIND'], { ui: 'money.prepare_transfer', requires: ['amount', 'to'], sensitive: true }),
  // ── DUKA: reads ──
  R('duka.products_count', 0.9, ['COUNTQ', 'PRODUCTW'], ['LOW', 'SLOW', 'STOCKW'], { ui: 'duka.products_count' }),
  R('duka.products_count', 0.8, ['COUNTQ', 'PRODUCTW', 'STOCKW'], ['LOW', 'SLOW', 'BUYQ'], { ui: 'duka.products_count' }),
  R('duka.low_stock', 0.9, ['LOW'], ['BUYQ'], { ui: 'duka.low_stock' }),
  R('duka.restock', 0.9, ['BUYQ'], [], { tool: 'duka.restock' }),
  R('duka.restock', 0.85, ['PRODUCTW', 'BUYQ'], [], { tool: 'duka.restock' }),
  R('duka.slow_movers', 0.9, ['SLOW'], [], { tool: 'duka.slow_movers' }),
  R('duka.best_sellers', 0.85, ['BEST'], [], { tool: 'duka.best_sellers' }),
  R('duka.customers_count', 0.9, ['COUNTQ', 'CUST'], ['DEBT'], { ui: 'duka.customers_count' }),
  R('duka.debts', 0.9, ['DEBT'], ['CHAMA'], { ui: 'duka.debts', tool: 'duka.unpaid_customers', slotsFrom: ['who'] }),
  R('duka.debts', 0.82, ['CUST', 'NOTPAID'], ['CHAMA'], { ui: 'duka.debts', tool: 'duka.unpaid_customers' }),
  R('duka.stock', 0.8, ['STOCKW'], ['LOW', 'COUNTQ', 'BUYQ'], { ui: 'duka.stock', requires: ['product'] }),
  R('duka.profit', 0.9, ['PROFIT'], ['WHYQ', 'ANOMALY'], { tool: 'duka.profit' }),
  R('duka.why', 0.9, ['WHYQ', 'SALESW'], [], { tool: 'duka.why' }),
  R('duka.why', 0.9, ['WHYQ', 'PROFIT'], [], { tool: 'duka.why' }),
  R('duka.why', 0.85, ['SALESW', 'UPDOWN', 'WHYQ'], [], { tool: 'duka.why' }),
  R('duka.report', 0.85, ['SALESW'], ['PROFIT', 'WHYQ', 'FORECAST', 'SALEV', 'BEST', 'SLOW', 'ANOMALY'], { ui: 'duka.report', tool: 'duka.sales_summary', slotsFrom: ['period'], periodEnum: ['today', 'week', 'month'] }),
  R('duka.forecast', 0.88, ['FORECAST'], ['MSGW', 'REMIND'], { tool: 'duka.forecast' }),
  R('duka.unnecessary_expenses', 0.9, ['UNNEC'], [], { tool: 'duka.expense_review' }),
  R('duka.anomalies', 0.88, ['ANOMALY'], [], { tool: 'duka.anomalies' }),
  // ── DUKA: writes (always confirmed by the existing screen) ──
  R('duka.sale', 0.9, ['SALEV'], [], { ui: 'duka.sale', requires: ['items_text'], sensitive: true }),
  R('duka.expense', 0.85, ['EXPV'], ['HOWMUCH', 'UNNEC'], { ui: 'duka.expense', requires: ['amount'], sensitive: true }),
  R('duka.expense', 0.84, ['SPENT', 'AMT'], ['HOWMUCH', 'SENDV', 'UNNEC', 'RECV'], { ui: 'duka.expense', requires: ['amount'], sensitive: true }),
  // ── transactions search ──
  R('finance.find_transaction', 0.85, ['FIND', 'TXNW'], ['SENDV', 'REMIND'], { tool: 'finance.find_transaction' }),
  // ── reminders (prepared only) ──
  R('reminder.create', 0.95, ['REMIND'], [], { requires: ['when'], sensitive: true }),
  // ── messenger / social ──
  R('messages.unread_check', 0.85, ['MSGW', 'UNREAD'], ['MSGSEND'], { ui: 'messages.unread_check' }),
  R('messages.open_chat', 0.78, ['MSGSEND'], ['REMIND', 'UNREAD', 'SALESW'], { ui: 'messages.open_chat', requires: ['name'], note: 'opens the chat; it never sends a message for you' }),
  R('friends.count_friends', 0.85, ['COUNTQ', 'FRIENDW'], [], { ui: 'friends.count_friends' }),
  R('groups.count', 0.85, ['COUNTQ', 'GROUPW'], [], { ui: 'groups.count' }),
  R('games.coins', 0.85, ['COUNTQ', 'GAMECOINS'], [], { ui: 'games.coins' }),
  // ── navigation ──
  R('nav.back', 0.9, ['BACKW'], ['OPENV'], { ui: 'nav.back' })
];
const PAGE_GROUPS = [['PAGE_TOOLS', 'tools'], ['PAGE_MESSAGES', 'messages'], ['PAGE_FRIENDS', 'friends'], ['PAGE_GROUP', 'group'], ['PAGE_STATUS', 'status'], ['PAGE_SETTINGS', 'settings'], ['PAGE_GAMES', 'games'], ['PAGE_MONEY', 'money']];

const AMBIGUITY_MARGIN = 0.06;
const MIN_CONFIDENCE = Number(process.env.NECPRA_INTENT_MIN_CONFIDENCE || 0.6);

/** Leftover words once vocabulary + filler are removed: used for names / products. Keeps the speaker's original capitalisation. */
function leftoverWords(original, prepared, dropGroups) {
  let t = prepared;
  for (const g of dropGroups) t = t.replace(RE[g].strip, ' ');
  t = t.replace(RE.STOP.strip, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const orig = {}; String(original || '').split(/\s+/).forEach((w) => { const k = nlp.normalize(w).trim(); if (k) orig[k] = w.replace(/[^\p{L}\p{N}'’.\-]/gu, ''); });
  return t.split(' ').map((w) => orig[w] || w);
}
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1);

function extractSlots(rule, original, prepared) {
  const slots = {}, notes = [];
  const period = nlp.extractPeriod(prepared);
  if (period) slots.period = period;
  const amount = nlp.extractAmount(prepared); if (amount != null) slots.amount = amount;
  const phone = nlp.extractPhone(prepared); if (phone) slots.phone = phone;
  const due = rule.intent === 'reminder.create' ? nlp.extractDueDate(prepared) : null; if (due) slots.when = due;
  const need = rule.requires || [];
  const allGroups = Object.keys(LEX);
  if (need.includes('to')) { slots.to = phone || (leftoverWords(original, prepared, allGroups.filter((g) => g !== 'STOP'))[0] || null); if (slots.to && slots.phone && slots.to === slots.phone) slots.to = phone; }
  if (need.includes('name')) {
    const w = leftoverWords(original, prepared, allGroups.filter((g) => g !== 'STOP')).slice(0, 3);
    if (w.length) slots.name = w.map(titleCase).join(' ');
  } else if (rule.slotsFrom && rule.slotsFrom.includes('who')) {
    // optional name: trust only capitalised words after the first word ("how much does Wanjiru owe me"); otherwise show everyone
    const caps = String(original || '').split(/\s+/).slice(1).filter((w) => /^\p{Lu}[\p{L}'’-]{1,}$/u.test(w.replace(/[?.,!]+$/, ''))).map((w) => w.replace(/[?.,!]+$/, ''));
    if (caps.length) slots.who = caps.slice(0, 3).join(' ');
  }
  if (need.includes('product')) { const w = leftoverWords(original, prepared, allGroups.filter((g) => g !== 'STOP')).slice(0, 3); if (w.length) slots.product = w.join(' '); }
  if (need.includes('items_text')) { const t = String(original || '').replace(/\b(?:i|we)\s+sold\b|nimeuza|niliuza|tumeuza|nimeuzia|tumeuzia/i, '').replace(/\s+/g, ' ').trim(); if (t) slots.items_text = t.slice(0, 160); }
  if (rule.intent === 'duka.expense') { const m = /(?:on|for|kwa|ya)\s+([\p{L}][\p{L} ]{1,30})$/iu.exec(String(original || '').trim()); if (m) slots.description = m[1].trim(); }
  if (rule.intent === 'nav.open') { /* handled separately */ }
  if (rule.periodEnum && slots.period && !rule.periodEnum.includes(slots.period)) { slots.unsupportedPeriod = slots.period; delete slots.period; }
  return { slots, notes };
}

/** Navigation ("open wallet", "fungua duka") is its own tiny grammar: verb + one page word. */
function matchNavigation(original, prepared) {
  if (!has('OPENV', prepared)) return null;
  const hits = PAGE_GROUPS.filter(([g]) => has(g, prepared));
  if (!hits.length) return null;
  // "open wallet" must beat "show my sales": any DUKA/report/read word means this is a data question, not navigation.
  if (['SALESW', 'PROFIT', 'COUNTQ', 'LOW', 'DEBT', 'BAL', 'TXN', 'CHAMA', 'NOTPAID'].some((g) => has(g, prepared)) && !/ (?:fungua|open|go to|nipeleke|take me to|nenda|ingia) /.test(prepared)) return null;
  return { intent: 'nav.open', ui: 'nav.open', weight: 0.82, slots: { page: hits[0][1] } };
}

/**
 * @param {string} text   what the user said or typed
 * @param {object} [opts] { lang?: string }
 * @returns {{matched:boolean, intent?:string, confidence?:number, slots?:object, ui?:string, tool?:string, sensitive?:boolean, missing?:string[], candidates?:Array, ambiguous?:boolean, prepared:string}}
 */
function recognise(text, opts = {}) {
  const original = String(text == null ? '' : text).slice(0, 300);
  const prepared = nlp.prepare(original);
  const scored = [];
  const nav = matchNavigation(original, prepared);
  if (nav) scored.push({ intent: nav.intent, weight: nav.weight, rule: nav });
  for (const rule of RULES) {
    if (rule.all.every((g) => has(g, prepared)) && !rule.not.some((g) => has(g, prepared))) {
      // more matched groups = more specific = small bonus
      scored.push({ intent: rule.intent, weight: rule.weight + 0.01 * rule.all.length, rule });
    }
  }
  if (!scored.length) return { matched: false, prepared };
  scored.sort((a, b) => b.weight - a.weight);
  const top = scored[0];
  const rival = scored.find((s) => s.intent !== top.intent);
  const { slots } = extractSlots(top.rule, original, prepared);
  if (top.rule.slots) Object.assign(slots, top.rule.slots);
  const missing = (top.rule.requires || []).filter((k) => slots[k] == null || slots[k] === '');
  const candidates = [];
  const seen = new Set();
  for (const s of scored) { if (!seen.has(s.intent) && candidates.length < 3) { seen.add(s.intent); candidates.push({ intent: s.intent, confidence: Math.min(0.99, Math.round(s.weight * 100) / 100) }); } }
  return {
    matched: top.weight >= MIN_CONFIDENCE,
    intent: top.intent,
    confidence: Math.min(0.99, Math.round(top.weight * 100) / 100),
    slots,
    ui: top.rule.ui || null,
    tool: top.rule.tool || null,
    sensitive: !!top.rule.sensitive,
    note: top.rule.note || null,
    missing,
    ambiguous: !!(rival && top.weight - rival.weight < AMBIGUITY_MARGIN),
    candidates,
    prepared,
    lang: opts.lang || null
  };
}

module.exports = { recognise, LEX, RULES, has, AMBIGUITY_MARGIN, MIN_CONFIDENCE, leftoverWords };
