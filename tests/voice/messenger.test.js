const test = require('node:test'); const assert = require('node:assert');
const log = { spoken: [], sent: [], opened: [], audits: [] }; let confirmQueue = [], captureQueue = [], chooseQueue = [], sendImpl;
globalThis.NecpraVoice = { speak: async (t) => { log.spoken.push(t); return true; }, audit: (a, m) => log.audits.push([a, m.outcome]), getSettings: () => ({}), resolveLang: () => 'en-KE', isListening: () => false };
globalThis.NecpraVoiceUI = { T: (en) => en, announce() {}, choose: async (o) => { log.choose = o; return chooseQueue.shift(); }, confirmMessage: async (o) => { log.confirm = o; return confirmQueue.shift(); } };
let handler; globalThis.NecpraVoiceRemote = { capture: async (o) => captureQueue.shift(), onIntent: (fn) => { handler = fn; } };
globalThis.NecpraVoiceIntents = require('../../js/voice/necpra-voice-intents.js');
const conv = (id, n, unread = 0, text = 'hi') => ({ chatId: id, otherUser: { username: n }, unreadCount: unread, lastMessage: { displayContent: text, createdAt: '2026-11-13T10:0' + id + ':00Z' } });
const convs = [conv(1, 'Mary Wanjiku', 1, 'Are you coming?'), conv(2, 'Peter Otieno'), conv(3, 'Mary Atieno', 2, 'Call me'), conv(4, 'Juma', 1, 'Secret locked text'), conv(5, 'Zuri')];
const MM = { getConversations: () => convs, getActiveChatId: () => null, openChat: async (o) => log.opened.push(o.conversationId), sendMessage: async (o) => { log.sent.push(o); return sendImpl ? sendImpl(o) : { success: true }; }, subscribe() {} };
require('../../js/voice/necpra-voice-messenger.js'); globalThis.NecpraVoiceMessenger.init({ MM, isLocked: (id) => String(id) === '4' });
const reset = () => { log.spoken = []; log.sent = []; log.opened = []; log.audits = []; confirmQueue = []; captureQueue = []; chooseQueue = []; sendImpl = null; };
const say = (t) => handler({ transcript: t, lang: 'en-KE' });

test('duplicate name: asks which Mary, sends only to the chosen one after confirmation', async () => {
  reset(); chooseQueue = [1]; captureQueue = [{ ok: true, transcript: 'I will come at five', uncertain: [] }]; confirmQueue = [{ action: 'send', text: 'I will come at five' }];
  assert.equal(await say('I want to send a message to Mary'), true);
  assert.equal(log.choose.options.length, 2); assert.deepEqual(log.sent, [{ chatId: 3, content: 'I will come at five' }]); assert.deepEqual(log.opened, [3]);
});
test('unique recipient with inline content still requires confirmation; cancel sends nothing', async () => {
  reset(); confirmQueue = [{ action: 'cancel', text: '' }]; await say('Send a message to Peter saying I am late');
  assert.equal(log.confirm.text, 'I am late'); assert.equal(log.confirm.to, 'Peter Otieno'); assert.equal(log.sent.length, 0); assert.ok(log.spoken.some(s => /Nothing was sent/.test(s)));
});
test('correction loop: redo then re-dictate then send final text only', async () => {
  reset(); captureQueue = [{ ok: true, transcript: 'first version' }, { ok: true, transcript: 'second version' }]; confirmQueue = [{ action: 'redo' }, { action: 'send', text: 'second version' }];
  await say('text Peter'); assert.equal(log.sent.length, 1); assert.equal(log.sent[0].content, 'second version');
});
test('user can edit the text in the dialog; the edited text is what is sent', async () => {
  reset(); confirmQueue = [{ action: 'send', text: 'edited by hand' }]; await say('message Peter hello'); assert.equal(log.sent[0].content, 'edited by hand');
});
test('locked chat is invisible to voice: cannot be messaged, opened or read', async () => {
  reset(); await say('Send a message to Juma saying hi'); assert.equal(log.sent.length, 0); assert.ok(log.spoken.some(s => /could not find/.test(s)));
  reset(); await say('Read my latest messages'); assert.ok(!log.spoken.join(' ').includes('Secret locked text'));
});
test('unknown person: nothing sent, clear message', async () => { reset(); await say('Tell Hamisi hello'); assert.equal(log.sent.length, 0); assert.ok(log.spoken.some(s => /Hamisi/.test(s))); });
test('failed send is reported as NOT sent (never claims success)', async () => {
  reset(); sendImpl = () => ({ success: false, error: 'No connection' }); confirmQueue = [{ action: 'send', text: 'hello' }]; await say('text Peter hello');
  assert.ok(log.spoken.some(s => /NOT sent/.test(s))); assert.ok(!log.spoken.some(s => /Message sent to/.test(s))); assert.ok(log.audits.some(a => a[1] === 'error'));
});
test('same message cannot be sent twice within seconds (duplicate guard)', async () => {
  reset(); confirmQueue = [{ action: 'send', text: 'dup test' }, { action: 'send', text: 'dup test' }]; await say('text Peter dup test'); await say('text Peter dup test'); assert.equal(log.sent.length, 1);
});
test('read unread messages: newest first, excludes read chats', async () => {
  reset(); await say('Read my latest messages'); const t = log.spoken.join(' | '); assert.match(t, /Mary Atieno: Call me/); assert.match(t, /Mary Wanjiku: Are you coming\?/); assert.ok(!t.includes('Peter'));
  assert.ok(t.indexOf('Mary Atieno') < t.indexOf('Mary Wanjiku'));
});
test('non-messenger speech is not claimed', async () => { reset(); assert.equal(await say('open my wallet'), false); });
test('dictation cancelled by user sends nothing', async () => { reset(); captureQueue = [{ ok: false, cancelled: true, transcript: '' }]; await say('text Peter'); assert.equal(log.sent.length, 0); });
