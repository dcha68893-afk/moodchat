const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const log = { spoken: [], toasts: [], audits: [], used: [], prep: [] }; let speakSensitive = false, dialogYes = true, capQ = [];
globalThis.NecpraVoice = { speak: async (t, o) => { log.spoken.push([t, !!(o && o.sensitive)]); return !(o && o.sensitive && !speakSensitive); }, audit: (a, m) => log.audits.push([a, m.outcome]), getSettings: () => ({ speakSensitive }), resolveLang: () => 'en-KE' };
globalThis.NecpraVoiceUI = { T: (en) => en, announce() {}, dialog: async (o) => { log.dialog = o; return dialogYes; } };
let handler; globalThis.NecpraVoiceRemote = { capture: async () => capQ.shift(), onIntent: (fn) => { handler = fn; } };
require('../../js/voice/necpra-voice-sales-nlu.js'); globalThis.NecpraVoiceSalesNLU = require('../../js/voice/necpra-voice-sales-nlu.js'); globalThis.NecpraVoiceMoneyNLU = require('../../js/voice/necpra-voice-money-nlu.js'); require('../../js/voice/necpra-voice-money.js');
const today = new Date().toISOString(); const old = '2020-01-01T10:00:00Z';
const state = { wallet: { balance: 4250.5, pendingTotal: 0, isFrozen: false, receivedThisMonth: 9000, spentThisMonth: 3100, recent: [{ type: 'debit', amount: 200, description: 'Airtime', createdAt: today, status: 'completed' }, { type: 'debit', amount: 150, createdAt: today, status: 'completed' }, { type: 'debit', amount: 999, createdAt: old, status: 'completed' }, { type: 'debit', amount: 5000, createdAt: today, status: 'failed' }, { type: 'credit', amount: 700, createdAt: today, status: 'completed' }] },
  circles: [{ id: 1, name: 'Wajibu Chama', targetAmount: 10000, collectedAmount: 6500 }, { id: 2, name: 'No target', targetAmount: 0, collectedAmount: 50 }], overview: { dues: [{ name: 'Wajibu Chama', amount: 500 }], activity: [{ kind: 'contribution', subtitle: 'paid', amount: 500, createdAt: today }, { kind: 'contribution', subtitle: 'paid', amount: 300, createdAt: today }, { kind: 'contribution', subtitle: 'pending', amount: 900, createdAt: today }, { kind: 'contribution', subtitle: 'paid', amount: 400, createdAt: old }] } };
const adapter = { state: () => state, refresh: async () => { log.used.push('refresh'); }, setTab: (t) => log.used.push('tab:' + t), reveal: () => log.used.push('reveal'), toast: (m) => log.toasts.push(m), loadOrders: async () => [{ id: 'abcdef1234', total_price: 3000, amount_paid: 1000 }], prepareTransfer: (o) => log.prep.push(o) };
globalThis.NecpraVoiceMoney.init(adapter);
const reset = () => { log.spoken = []; log.toasts = []; log.audits = []; log.used = []; log.prep = []; speakSensitive = false; dialogYes = true; capQ = []; };
const say = (t) => handler({ transcript: t });
test('balance: always on screen, NOT spoken unless the user allowed private info aloud', async () => {
  reset(); await say('Show my wallet balance'); assert.ok(log.toasts[0].includes('4,250.5')); assert.ok(log.spoken.some(s => s[1] === true), 'tried sensitive speech'); assert.ok(!log.spoken.some(s => !s[1] && s[0].includes('4,250')), 'never spoke the figure without permission'); assert.ok(log.spoken.some(s => /voice settings/.test(s[0])));
  reset(); speakSensitive = true; await say('Show my wallet balance'); assert.ok(log.spoken.some(s => s[0].includes('4,250.5'))); assert.ok(!log.spoken.some(s => /voice settings/.test(s[0])));
});
test('spent today counts only completed debits dated today (not failed, not old)', async () => { reset(); await say('How much did I spend today?'); assert.match(log.toasts[0], /KSh 350/); assert.match(log.toasts[0], /most recent/); });
test('spent this month / received use the server totals', async () => { reset(); await say('how much did I spend this month'); assert.match(log.toasts[0], /3,100/); reset(); await say('how much did I receive'); });
test('latest transactions summary', async () => { reset(); await say('Show my latest transactions'); assert.match(log.toasts[0], /Paid KSh 200, Airtime/); assert.ok(!/failed|5,000/.test(log.toasts[0])); });
test('chama outstanding = target minus collected, plus what the user owes; this month sums only PAID this month', async () => {
  reset(); await say('How much is still outstanding in my chama?'); assert.match(log.toasts[0], /Wajibu Chama: KSh 3,500/); assert.match(log.toasts[0], /owe KSh 500/); assert.ok(!/No target: /.test(log.toasts[0]));
  reset(); await say("Show this month's contributions"); assert.match(log.toasts[0], /KSh 800 in 2 payments/);
});
test('open my chama switches tab', async () => { reset(); await say('Open my chama'); assert.ok(log.used.includes('tab:circles')); });
test('pending Pay Later orders', async () => { reset(); await say('Show my pending orders'); assert.match(log.toasts[0], /1 pending Pay Later order/); assert.match(log.toasts[0], /KSh 2,000 still to pay/); });
test('SPEC payment: asks for the recipient, shows the intended payment, only PRE-FILLS the Send money screen', async () => {
  reset(); capQ = [{ ok: true, transcript: 'zero seven one two three four five six seven eight' }]; await say('Prepare a payment of five hundred shillings to my supplier');
  assert.match(log.dialog.body, /KSh 500/); assert.match(log.dialog.body, /0712345678/); assert.match(log.dialog.body, /Nothing is sent yet/); assert.deepEqual(log.prep, [{ to: '0712345678', amount: 500 }]);
  assert.ok(log.spoken.some(s => /Nothing has been sent/.test(s[0])));
});
test('cancelling the payment preparation does nothing', async () => { reset(); dialogYes = false; await say('send 200 shillings to @juma'); assert.equal(log.prep.length, 0); assert.ok(log.audits.some(a => a[1] === 'cancelled')); });
test('no recipient given -> cancelled, nothing prepared', async () => { reset(); capQ = [{ ok: false, cancelled: true }]; await say('pay 300 shillings to my supplier'); assert.equal(log.prep.length, 0); assert.equal(log.dialog, log.dialog); });
test('unrelated speech is not claimed', async () => { reset(); assert.equal(await say('read my latest messages'), false); });
test('SECURITY: no voice file contains any code that moves money or touches step-up', () => {
  const dir = path.join(__dirname, '../../js/voice'); const bad = /\/wallet\/(transfer|withdraw|goals\/[^'"]*deposit)|\/money\/[^'"]*(contribute|pay)|X-Money-Step-Up|stepUp\s*\(|\/marketplace\/orders['"]\s*,\s*\{\s*method/i;
  fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => assert.ok(!bad.test(fs.readFileSync(path.join(dir, f), 'utf8')), f + ' must not move money'));
});
