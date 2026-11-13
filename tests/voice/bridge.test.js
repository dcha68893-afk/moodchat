const test = require('node:test'); const assert = require('node:assert');
const B = require('../../js/voice/necpra-voice-bridge.js');
const OWN = 'https://necpra.co.ke', EVIL = 'https://evil.example';
function mk() {
  const listeners = []; const sent = []; const child = { postMessage: (m, o) => sent.push({ m, o }) };
  const win = { location: { origin: OWN }, addEventListener: (t, f) => listeners.push(f), removeEventListener() {}, document: {} };
  let captured = 0;
  const V = { isListening: () => false, cancel() {}, message: () => 'busy', speak: async () => true };
  const UI = { capture: async (o) => { captured++; return { ok: true, transcript: 'hello world', lang: 'en-KE', uncertain: [] }; } };
  const h = B.host({ window: win, voice: V, ui: UI, getFrames: () => [{ contentWindow: child }], allowedOrigins: ['https://nexorah-xnv6.onrender.com'] });
  const msg = (type, o = {}) => ({ ns: 'necpra.voice', v: 1, type, requestId: o.id || 'a1', frameSession: o.fs, payload: o.p || {} });
  const post = (data, origin = OWN, source = child) => h._onMessage({ data, origin, source });
  return { h, sent, child, post, msg, captured: () => captured };
}
test('hello then capture from same-origin frame returns transcript to that frame only', async () => {
  const t = mk(); t.post(t.msg('voice.hello')); const fs = t.sent[0].m.frameSession; assert.ok(fs); assert.equal(t.sent[0].o, OWN);
  await t.post(t.msg('voice.capture', { fs, id: 'c1' })); const r = t.sent.find(s => s.m.type === 'voice.result');
  assert.equal(r.m.payload.transcript, 'hello world'); assert.equal(r.m.requestId, 'c1');
});
test('untrusted origin is ignored completely', () => { const t = mk(); t.post(t.msg('voice.hello'), EVIL); assert.equal(t.sent.length, 0); });
test('message from a window that is not a child frame is ignored', () => { const t = mk(); t.post(t.msg('voice.hello'), OWN, { postMessage() {} }); assert.equal(t.sent.length, 0); });
test('capture without a valid frame session is refused', async () => { const t = mk(); t.post(t.msg('voice.hello')); await t.post(t.msg('voice.capture', { fs: 'forged' })); assert.equal(t.captured(), 0); assert.equal(t.sent.at(-1).m.payload.code, 'no-session'); });
test('payment / send-message style types are rejected, nothing executes', () => {
  const t = mk(); t.post(t.msg('voice.hello')); const fs = t.sent[0].m.frameSession;
  for (const type of ['wallet.pay', 'message.send', 'voice.execute', 'eval']) { t.post(t.msg(type, { fs })); assert.equal(t.sent.at(-1).m.payload.code, 'unsupported'); }
});
test('malformed and wrong-namespace messages are dropped', () => { const t = mk(); t.post({ type: 'voice.hello' }); t.post('x'); t.post({ ns: 'necpra.voice', v: 2, type: 'voice.hello' }); assert.equal(t.sent.length, 0); });
test('rate limit blocks floods', async () => { const t = mk(); t.post(t.msg('voice.hello')); const fs = t.sent[0].m.frameSession; for (let i = 0; i < 14; i++) await t.post(t.msg('voice.speak', { fs, p: { text: 'hi' }, id: 'x' + i })); assert.ok(t.sent.some(s => s.m.payload && s.m.payload.code === 'rate-limited')); });
test('explicitly allowed cross-origin frame works; its session is bound to that origin', () => {
  const t = mk(); const o = 'https://nexorah-xnv6.onrender.com'; t.post(t.msg('voice.hello'), o); const fs = t.sent[0].m.frameSession; assert.equal(t.sent[0].o, o);
  t.post(t.msg('voice.speak', { fs, p: { text: 'x' } }), OWN); assert.equal(t.sent.at(-1).m.payload.code, 'no-session');
});

test('parent can forward an intent to a frame with a session; frame answers handled', async () => {
  const t = mk(); t.post(t.msg('voice.hello')); const fs = t.sent[0].m.frameSession; const frame = { contentWindow: t.child };
  const p = t.h.sendIntent(frame, { transcript: 'send a message to mary', lang: 'en-KE' }, 1000);
  const out = t.sent.find(s => s.m.type === 'voice.intent'); assert.equal(out.m.payload.transcript, 'send a message to mary'); assert.equal(out.o, OWN);
  t.post(t.msg('voice.intent.result', { fs, id: out.m.requestId, p: { handled: true } })); assert.deepEqual(await p, { handled: true });
});
test('intent result from another window or with a forged session is ignored', async () => {
  const t = mk(); t.post(t.msg('voice.hello')); const fs = t.sent[0].m.frameSession; const frame = { contentWindow: t.child };
  const p = t.h.sendIntent(frame, { transcript: 'x' }, 80); const out = t.sent.find(s => s.m.type === 'voice.intent');
  t.post(t.msg('voice.intent.result', { fs: 'forged', id: out.m.requestId, p: { handled: true } })); t.post(t.msg('voice.intent.result', { fs, id: out.m.requestId, p: { handled: true } }), OWN, { postMessage() {} });
  assert.deepEqual(await p, { handled: false, reason: 'timeout' });
});
test('no intent is sent to a frame that never said hello', async () => { const t = mk(); assert.deepEqual(await t.h.sendIntent({ contentWindow: t.child }, { transcript: 'x' }), { handled: false, reason: 'no-session' }); });
