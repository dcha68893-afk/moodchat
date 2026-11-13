const test = require('node:test'); const assert = require('node:assert');
let handler; const nav = [], fwd = [];
globalThis.NecpraVoice = { registerHandler: (id, fn) => { handler = fn; }, audit() {}, speak: async () => true, resolveLang: () => 'en-KE' };
globalThis.NecpraVoiceIntents = require('../../js/voice/necpra-voice-intents.js'); globalThis.document = { getElementById: (id) => ({ id }) };
require('../../js/voice/necpra-voice-shell.js'); let page = 'money';
globalThis.NecpraVoiceShell.init({ navigate: (p) => { nav.push(p); page = p; }, getPage: () => page, host: () => ({ hasSession: () => true, waitForSession: async () => true, sendIntent: async (f, p) => { fwd.push([f.id, p.transcript]); return { handled: true }; } }) });
test('a sale said on the Wallet screen opens DUKA and hands it over', async () => { nav.length = 0; fwd.length = 0; assert.equal(await handler({ transcript: 'Nimeuza nyanya mbili', lang: 'sw-KE' }), true); assert.deepEqual(nav, ['tools']); assert.deepEqual(fwd, [['toolsIFrame'.replace('IF', 'If'), 'Nimeuza nyanya mbili']]); });
test('navigation still works and does not forward', async () => { nav.length = 0; fwd.length = 0; await handler({ transcript: 'open settings' }); assert.deepEqual(nav, ['settings']); assert.equal(fwd.length, 0); });
test('admin cannot be opened by voice', async () => { nav.length = 0; await handler({ transcript: 'open admin' }); assert.ok(!nav.includes('admin')); });
globalThis.NecpraVoiceSalesNLU = require('../../js/voice/necpra-voice-sales-nlu.js'); globalThis.NecpraVoiceMoneyNLU = require('../../js/voice/necpra-voice-money-nlu.js');
test('wallet question said on Messenger goes to the Money frame only', async () => {
  page = 'messages'; nav.length = 0; fwd.length = 0; assert.equal(await handler({ transcript: 'Show my wallet balance' }), true); assert.deepEqual(nav, ['money']); assert.equal(fwd.length, 1); assert.equal(fwd[0][0], 'moneyIframe');
});
test('"open my chama" opens Money and forwards the chama tab request', async () => { page = 'tools'; nav.length = 0; fwd.length = 0; await handler({ transcript: 'Open my chama' }); assert.deepEqual(nav, ['money']); assert.match(fwd[0][1], /chama/); });
test('payment phrases are only forwarded as a PREPARE request; there is no execute path in the shell', async () => {
  page = 'money'; fwd.length = 0; await handler({ transcript: 'Prepare a payment of five hundred shillings to my supplier' }); assert.equal(fwd.length, 1);
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../js/voice/necpra-voice-shell.js'), 'utf8'); assert.ok(!/transfer|withdraw|stepUp/i.test(src));
});
