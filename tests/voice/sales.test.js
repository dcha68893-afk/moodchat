const test = require('node:test'); const assert = require('node:assert');
const log = { spoken: [], audits: [], applied: [], checkout: [] }; let chooseQ = [], capQ = [], reviewAction = 'apply', reviewSeen = null;
globalThis.NecpraVoice = { speak: async (t) => { log.spoken.push(t); return true; }, audit: (a, m) => log.audits.push([a, m.outcome]), getSettings: () => ({}), resolveLang: () => 'en-KE' };
globalThis.NecpraVoiceUI = { T: (en) => en, announce() {}, choose: async (o) => { log.choose = o; return chooseQ.shift(); }, el() {} };
globalThis.NecpraVoiceRemote = { capture: async () => capQ.shift() };
globalThis.NecpraVoiceIntents = require('../../js/voice/necpra-voice-intents.js'); globalThis.NecpraVoiceSalesNLU = require('../../js/voice/necpra-voice-sales-nlu.js');
require('../../js/voice/necpra-voice-sales.js'); const S = globalThis.NecpraVoiceSales;
const P = [{ id: 't', name: 'Tomatoes', unit: 'kg', sellingPrice: 150, stockQty: 50 }, { id: 's', name: 'Sukuma Wiki', unit: 'bundle', sellingPrice: 20, stockQty: 30 }, { id: 'p', name: 'Potatoes', unit: 'kg', sellingPrice: 100, stockQty: 40 }, { id: 'o', name: 'Onions', unit: 'kg', sellingPrice: 120, stockQty: 3 }];
const applied = new Set(); let products = P;
const A = { getProducts: async () => products, getCustomers: async () => [{ id: 'c1', name: 'Mary Wanjiku' }, { id: 'c2', name: 'Peter' }], wasApplied: (id) => applied.has(id), applyLines: (l, d, id) => { applied.add(id); log.applied.push({ l, d, id }); return {}; }, closeAssistant() {}, checkout: async (o) => { log.checkout.push(o); } };
const review = async (st) => { reviewSeen = st; return { action: reviewAction }; };
const reset = () => { log.spoken = []; log.audits = []; log.applied = []; log.checkout = []; chooseQ = []; capQ = []; reviewAction = 'apply'; reviewSeen = null; products = P; };
const run = (t, o) => S.start(t, A, Object.assign({ review }, o));

test('SPEC Swahili sale: nothing saved by voice; lines go to the shared cart with the trader prices; M-PESA handed to checkout', async () => {
  reset(); assert.equal(await run('Nimeuza nyanya za shilingi mia mbili na sukuma mbili. Pia nimeuza viazi vya mia moja. Mteja amelipa kwa M-PESA.'), true);
  assert.equal(log.applied.length, 1); const l = log.applied[0].l; assert.deepEqual(l.map(x => [x.productId, x.qty, x.price]), [['t', 1.333, 150], ['s', 2, 20], ['p', 1, 100]]);
  assert.deepEqual(log.checkout, [{ method: 'mpesa', customerId: null }]); assert.ok(log.audits.some(a => a[1] === 'confirmed')); assert.ok(log.spoken.join(' ').includes('Confirm sale'));
  assert.ok(!log.spoken.join(' ').match(/sale (was )?(recorded|saved)/i), 'never claims the sale is saved');
});
test('cancel at review changes nothing', async () => { reset(); reviewAction = 'cancel'; await run('sold two kilos of potatoes'); assert.equal(log.applied.length, 0); assert.equal(log.checkout.length, 0); assert.ok(log.spoken.some(s => /Nothing was changed/.test(s))); });
test('missing quantity is asked specifically, then answered by voice', async () => { reset(); capQ = [{ ok: true, transcript: 'five kilograms' }]; await run('sold tomatoes at 200 per kilogram'); assert.equal(log.applied[0].l[0].qty, 5); assert.equal(log.applied[0].l[0].price, 150); });
test('unanswered quantity stays blank so the card blocks it (never guessed)', async () => { reset(); capQ = [{ ok: false, cancelled: true, transcript: '' }]; await run('sold tomatoes'); assert.equal(reviewSeen.lines[0].qty, null); assert.ok(S._blockers(reviewSeen.lines, null).length > 0); });
test('ambiguous product: asks which one and uses ITS price', async () => {
  reset(); products = [{ id: 'a', name: 'Tomatoes Big', unit: 'kg', sellingPrice: 150, stockQty: 9 }, { id: 'b', name: 'Tomatoes Small', unit: 'kg', sellingPrice: 100, stockQty: 9 }]; chooseQ = [1]; await run('sold two kilos of tomatoes');
  assert.equal(log.choose.options.length, 2); assert.deepEqual(log.applied[0].l.map(x => [x.productId, x.price, x.qty]), [['b', 100, 2]]);
});
test('KSh worth of a countable product asks floor/ceil, never rounds silently', async () => { reset(); chooseQ = [0]; await run('sold sukuma worth 130 shillings'); assert.equal(log.choose.options.length, 2); assert.equal(log.applied[0].l[0].qty, 6); });
test('unit mismatch: user can skip the item', async () => { reset(); chooseQ = [1]; await run('nimeuza sukuma kilo mbili and potatoes 2 kilos'); assert.deepEqual(log.applied[0].l.map(x => x.productId), ['p']); });
test('credit sale matches the customer from the trader\'s own list; ambiguous names ask', async () => {
  reset(); await run('sold two kilos of potatoes, customer Peter will pay later'); assert.deepEqual(log.checkout, [{ method: 'credit', customerId: 'c2' }]);
});
test('unknown customer is not invented: handed to checkout with a note', async () => { reset(); await run('sold two kilos of potatoes, customer Zawadi will pay later'); assert.equal(log.checkout[0].customerId, null); assert.match(reviewSeen.customer.note, /Zawadi/); });
test('the same proposal cannot be applied twice', async () => { reset(); applied.clear(); const mk = async (st) => { applied.add(st.id); return { action: 'apply' }; }; await run('sold potatoes 2', { review: mk }); assert.equal(log.applied.length, 0); assert.ok(log.spoken.some(s => /already added/.test(s))); });
test('stock and totals: blocks over-stock; percent discount math matches checkout', async () => {
  reset(); await run('sold 5 kilos of onions'); assert.ok(S._blockers(reviewSeen.lines, null).some(b => /only 3/.test(b)));
  assert.deepEqual(S._totals([{ qty: 2, lineCents: 30000 }, { qty: 1, lineCents: 10000 }], { type: 'percent', value: 10 }), { sub: 40000, disc: 4000, total: 36000 }); assert.deepEqual(S._totals([{ qty: 1, lineCents: 5000 }], { type: 'amount', value: 20 }), { sub: 5000, disc: 2000, total: 3000 });
});
test('not a sale / empty catalogue / unknown goods fall through untouched', async () => {
  reset(); assert.equal(await run('how much sugar is left'), false); assert.equal(await run('I sold three mangoes'), false); products = []; assert.equal(await run('sold potatoes 2'), false); assert.equal(log.applied.length, 0);
});
test('force option handles verb-less lines like "sukuma 3"; without force it is left alone', async () => { reset(); assert.equal(await run('nyanya mbili sukuma tatu'), false); assert.equal(await run('nyanya mbili sukuma tatu', { force: true }), true); assert.equal(log.applied[0].l.length, 2); });
