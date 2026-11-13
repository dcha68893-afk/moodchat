const test = require('node:test'); const assert = require('node:assert'); const M = require('../../js/voice/necpra-voice-money-nlu.js'); const p = M.parse;
test('spec wallet phrases', () => {
  assert.equal(p('Show my wallet balance.').type, 'balance'); assert.equal(p('Show my latest transactions.').type, 'transactions'); assert.deepEqual(p('How much did I spend today?'), { type: 'spent', period: 'today' });
  assert.equal(p('nina pesa ngapi').type, 'balance'); assert.equal(p('Show my recent miamala').type, 'transactions'); assert.equal(p('How much did I spend this month').period, 'month');
});
test('spec chama phrases', () => {
  assert.deepEqual(p('Open my chama.'), { type: 'tab', tab: 'circles' }); assert.equal(p("Show this month's contributions.").type, 'chama_month'); assert.equal(p('How much is still outstanding in my chama?').type, 'chama_outstanding');
});
test('pending orders and tabs', () => { assert.equal(p('Show my pending orders').type, 'orders'); assert.equal(p('open savings goals').tab, 'goals'); assert.equal(p('open pay later').tab, 'paylater'); assert.equal(p('open my wallet').tab, 'wallet'); });
test('SPEC: prepare a payment of five hundred shillings to my supplier -> amount only, recipient must be asked, nothing executed', () => {
  const r = p('Prepare a payment of five hundred shillings to my supplier.'); assert.equal(r.type, 'prepare_transfer'); assert.equal(r.amount, 500); assert.equal(r.to, ''); assert.equal(r.needsRecipient, true);
});
test('transfer with a spoken phone number or a @username', () => {
  const a = p('send 1,200 shillings to 0712 345 678'); assert.equal(a.amount, 1200); assert.equal(a.to, '0712345678');
  const b = p('send two hundred shillings to zero seven one two three four five six seven eight'); assert.equal(b.to, '0712345678'); assert.equal(p('lipa shilingi mia tano kwa @juma').to, '@juma');
});
test('messages are not transfers; unrelated speech is ignored; no execute intent exists', () => {
  assert.equal(p('send a message to Mary'), null); assert.equal(p('I sold tomatoes'), null); assert.equal(p('confirm the payment'), null); assert.equal(p('yes send it now'), null);
  const types = ['balance', 'transactions', 'spent', 'received', 'orders', 'chama_month', 'chama_outstanding', 'tab', 'prepare_transfer']; ['pay now', 'confirm payment', 'withdraw everything', 'send all my money to Peter'].forEach(t => { const r = p(t); assert.ok(!r || r.type === 'prepare_transfer' && !(r.amount > 0) === false, t); });
});
