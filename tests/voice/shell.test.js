const test = require('node:test'); const assert = require('node:assert');
let handler; const nav = [], fwd = [];
globalThis.NecpraVoice = { registerHandler: (id, fn) => { handler = fn; }, audit() {}, speak: async () => true, resolveLang: () => 'en-KE' };
globalThis.NecpraVoiceIntents = require('../../js/voice/necpra-voice-intents.js'); globalThis.document = { getElementById: (id) => ({ id }) };
require('../../js/voice/necpra-voice-shell.js'); let page = 'money';
globalThis.NecpraVoiceShell.init({ navigate: (p) => { nav.push(p); page = p; }, getPage: () => page, host: () => ({ hasSession: () => true, waitForSession: async () => true, sendIntent: async (f, p) => { fwd.push([f.id, p.transcript]); return { handled: true }; } }) });
test('a sale said on the Wallet screen opens DUKA and hands it over', async () => { nav.length = 0; fwd.length = 0; assert.equal(await handler({ transcript: 'Nimeuza nyanya mbili', lang: 'sw-KE' }), true); assert.deepEqual(nav, ['tools']); assert.deepEqual(fwd, [['toolsIFrame'.replace('IF', 'If'), 'Nimeuza nyanya mbili']]); });
test('navigation still works and does not forward', async () => { nav.length = 0; fwd.length = 0; await handler({ transcript: 'open my wallet' }); assert.deepEqual(nav, ['money']); assert.equal(fwd.length, 0); });
test('admin cannot be opened by voice', async () => { nav.length = 0; await handler({ transcript: 'open admin' }); assert.ok(!nav.includes('admin')); });
