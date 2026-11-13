const test = require('node:test'); const assert = require('node:assert'); const N = require('../../js/voice/necpra-voice-sales-nlu.js');
const P = [{ id: 't', name: 'Tomatoes', unit: 'kg', sellingPrice: 150, stockQty: 50 }, { id: 's', name: 'Sukuma Wiki', unit: 'bundle', sellingPrice: 20, stockQty: 30 }, { id: 'p', name: 'Potatoes', unit: 'kg', sellingPrice: 100, stockQty: 40 },
  { id: 'o', name: 'Onions', unit: 'kg', sellingPrice: 120, stockQty: 10 }, { id: 'u', name: 'Sugar', unit: 'kg', sellingPrice: 160, stockQty: 20 }, { id: 'e', name: 'Eggs', unit: 'piece', sellingPrice: 15, stockQty: 90 }, { id: 'f', name: 'Free Item', unit: 'piece', sellingPrice: 0, stockQty: 5 }];
const by = (r, id) => r.lines.find(l => l.productId === id);
test('number words: English, Kiswahili, mixed', () => {
  const n = N.readNumber; assert.equal(n('two hundred and fifty'), 250); assert.equal(n('one thousand five hundred'), 1500); assert.equal(n('mia mbili'), 200); assert.equal(n('mia moja na hamsini'), 150);
  assert.equal(n('elfu mbili mia tano'), 2500); assert.equal(n('ishirini na tano'), 25); assert.equal(n('kumi na moja'), 11); assert.equal(n('a hundred'), 100); assert.equal(n('1,500'), 1500); assert.equal(n('moja na nusu'), 1.5); assert.equal(n('nusu'), 0.5);
});
test('SPEC: long Swahili sale with 3 products, amounts, quantity, M-PESA', () => {
  const r = N.parseSale('Nimeuza nyanya za shilingi mia mbili na sukuma mbili. Pia nimeuza viazi vya mia moja. Mteja amelipa kwa M-PESA.', P);
  assert.equal(r.isSale, true); assert.equal(r.lines.length, 3); assert.equal(r.payment.method, 'mpesa');
  const t = by(r, 't'), s = by(r, 's'), p = by(r, 'p'); assert.equal(t.qty, 1.333); assert.equal(t.price, 150); assert.equal(t.lineCents, 19995); assert.match(t.notes.join(' '), /nearest/);
  assert.equal(s.qty, 2); assert.equal(s.lineCents, 4000); assert.equal(p.qty, 1); assert.equal(p.lineCents, 10000); assert.equal(r.customerName, null);
});
test('SPEC: "tomatoes worth 200 shillings and two bunches of sukuma" (worth vs quantity)', () => {
  const r = N.parseSale('I have sold tomatoes worth two hundred shillings and two bunches of sukuma.', P); assert.equal(by(r, 't').lineCents, 19995); assert.equal(by(r, 's').qty, 2);
});
test('distinguishes two kilograms / goods worth KSh 200 / KSh 200 per kilogram', () => {
  const a = N.parseSale('sold two kilograms of tomatoes', P); assert.equal(by(a, 't').qty, 2);
  const b = N.parseSale('sold tomatoes worth KSh 300', P); assert.equal(by(b, 't').qty, 2);
  const c = N.parseSale('sold tomatoes at 200 per kilogram', P); assert.equal(by(c, 't').status, 'need_qty'); assert.equal(by(c, 't').price, 150);
});
test('spoken price never overrides the trader price (flagged only)', () => { const r = N.parseSale('sold two kilograms of tomatoes at 80 per kilo', P); assert.equal(by(r, 't').price, 150); assert.equal(by(r, 't').lineCents, 30000); assert.equal(by(r, 't').priceConflict, 80); });
test('products not in the catalogue are never invented', () => { const r = N.parseSale('I sold three mangoes and a laptop', P); assert.equal(r.lines.length, 0); assert.equal(r.isSale, false); });
test('product with no price is blocked, not guessed', () => { const r = N.parseSale('sold two free item', P); assert.equal(by(r, 'f').status, 'no_price'); assert.equal(by(r, 'f').lineCents, 0); });
test('unit mismatch is flagged (kilos of a bundle product)', () => { const r = N.parseSale('nimeuza sukuma kilo mbili', P); assert.equal(by(r, 's').status, 'unit_mismatch'); });
test('unit conversion: dozen -> pieces, grams -> kg', () => { assert.equal(by(N.parseSale('sold two dozen eggs', P), 'e').qty, 24); assert.equal(by(N.parseSale('sold 500 grams of sugar', P), 'u').qty, 0.5); });
test('countable goods worth a non-whole amount asks, offers floor/ceil', () => { const r = N.parseSale('sold sukuma worth 130 shillings', P); const l = by(r, 's'); assert.equal(l.status, 'fractional'); assert.deepEqual(l.options, [6, 7]); });
test('large bare number is ambiguous (quantity or money) and asks', () => { assert.equal(by(N.parseSale('sold potatoes 1000', P), 'p').status, 'qty_or_amount'); assert.equal(by(N.parseSale('nimeuza sukari 3', P), 'u').qty, 3); });
test('stock limit is flagged', () => { assert.equal(by(N.parseSale('sold 20 kilos of onions', P), 'o').status, 'insufficient_stock'); });
test('ambiguous catalogue names ask which product', () => {
  const two = [{ id: 'a', name: 'Tomatoes Big', unit: 'kg', sellingPrice: 150, stockQty: 9 }, { id: 'b', name: 'Tomatoes Small', unit: 'kg', sellingPrice: 100, stockQty: 9 }]; const r = N.parseSale('sold two kilos of tomatoes', two);
  assert.equal(r.lines[0].status, 'choose_product'); assert.deepEqual(r.lines[0].candidateNames, ['Tomatoes Big', 'Tomatoes Small']);
  const l = N.resolveLine(r.lines[0], two[1]); assert.equal(l.qty, 2); assert.equal(l.lineCents, 20000);
});
test('payment: credit, cash, mixed is not guessed; discount; customer name', () => {
  assert.equal(N.parseSale('sold sugar 2, customer Mary Wanjiku will pay later', P).payment.method, 'credit'); assert.equal(N.parseSale('sold sugar 2, customer Mary Wanjiku will pay later', P).customerName, 'Mary Wanjiku');
  assert.equal(N.parseSale('sold sugar 2 paid cash', P).payment.method, 'cash'); assert.equal(N.parseSale('sold sugar 2 cash and mpesa', P).payment.conflict, true);
  assert.deepEqual(N.parseSale('sold sugar 2, discount of 20 shillings', P).discount, { type: 'amount', value: 20 }); assert.deepEqual(N.parseSale('nimeuza sukari 2 punguzo asilimia 10', P).discount, { type: 'percent', value: 10 });
});
test('same product said twice becomes one line', () => { const r = N.parseSale('sold two kilos of sugar and also one kilo of sugar', P); assert.equal(r.lines.length, 1); assert.equal(r.lines[0].qty, 3); });
test('answers to clarification questions', () => { const a = N.parseQuantityAnswer; assert.deepEqual(a('five kilograms'), { qty: 5, unit: 'kg' }); assert.deepEqual(a('tatu'), { qty: 3, unit: null }); assert.deepEqual(a('shilingi mia mbili'), { amount: 200 }); assert.deepEqual(a('200 shillings worth'), { amount: 200 }); });
test('sale statement detector for routing', () => { assert.equal(N.looksLikeSaleStatement('Nimeuza nyanya mbili'), true); assert.equal(N.looksLikeSaleStatement('open my wallet'), false); });
