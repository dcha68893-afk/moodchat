const test = require('node:test'); const assert = require('node:assert'); const I = require('../../js/voice/necpra-voice-intents.js');
const C = [{ id: 1, name: 'Mary Wanjiku' }, { id: 2, name: 'Peter Otieno' }, { id: 3, name: 'Mary Atieno' }, { id: 4, name: 'Juma' }, { id: 5, name: 'Wambui' }];
test('spec example: send message to Mary is ambiguous with two Marys (never guessed)', () => {
  const r = I.parseMessengerIntent('I want to send a message to Mary.', C); assert.equal(r.type, 'send'); assert.equal(r.recipient.matches.length, 2); assert.equal(r.content, '');
});
test('full name resolves uniquely and trailing words become the message', () => {
  const r = I.parseMessengerIntent('Send a message to Mary Wanjiku saying I will be late', C); assert.equal(r.recipient.matches.length, 1); assert.equal(r.recipient.matches[0].id, 1); assert.equal(r.content, 'I will be late');
});
test('tell + pronoun example keeps the whole sentence and converts to second person visibly', () => {
  const r = I.parseMessengerIntent('Tell her I will bring the tomatoes tomorrow morning and ask her to send me the money she owes me.', C);
  assert.equal(r.recipient.pronoun, true); assert.equal(r.content, 'I will bring the tomatoes tomorrow morning and please send me the money you owe me'); assert.equal(r.rewritten, true);
});
test('Kiswahili forms', () => {
  assert.equal(I.parseMessengerIntent('Tuma ujumbe kwa Juma', C).recipient.matches[0].id, 4);
  const r = I.parseMessengerIntent('Mwambie Juma nitaleta nyanya kesho asubuhi', C); assert.equal(r.recipient.matches[0].id, 4); assert.equal(r.content, 'Nitaleta nyanya kesho asubuhi');
});
test('payments are NOT treated as messages', () => { assert.equal(I.parseMessengerIntent('send 500 shillings to Juma', C), null); assert.equal(I.parseMessengerIntent('Send money to Peter', C), null); });
test('typo in a name only matches as fuzzy, flagged', () => { const r = I.parseMessengerIntent('message Wambuy hello there', C); assert.equal(r.recipient.fuzzy, true); assert.equal(r.recipient.matches[0].id, 5); });
test('unknown person returns no matches', () => { const r = I.parseMessengerIntent('text Zawadi hello', C); assert.equal(r.recipient.matches.length, 0); });
test('read / reply / open / search', () => {
  assert.equal(I.parseMessengerIntent('Read my latest messages', C).type, 'read'); assert.equal(I.parseMessengerIntent('soma ujumbe mpya', C).type, 'read');
  assert.equal(I.parseMessengerIntent('read messages from Peter', C).from, 'Peter');
  assert.equal(I.parseMessengerIntent('reply saying thanks', C).content, 'Thanks');
  assert.equal(I.parseMessengerIntent('open chat with Juma', C).name, 'Juma'); assert.equal(I.parseMessengerIntent('find conversation with Peter', C).type, 'search');
});
test('non-message sentences are not claimed', () => { assert.equal(I.parseMessengerIntent('Open my wallet and show me recent transactions', C), null); assert.equal(I.parseMessengerIntent('I have sold tomatoes worth two hundred shillings', C), null); });
test('navigation EN/SW and chama sub-target', () => {
  assert.equal(I.parseNav('Open Messenger').page, 'messages'); assert.equal(I.parseNav('Go to my wallet').page, 'money'); assert.equal(I.parseNav('Open my chama').sub, 'chama');
  assert.equal(I.parseNav('fungua duka').page, 'tools'); assert.equal(I.parseNav('nenda kwa mipangilio').page, 'settings'); assert.equal(I.parseNav('go back').type, 'back');
  assert.equal(I.parseNav('open my wallet and show me my recent transactions'), null, 'long compound requests are left for the module');
});
test('admin is never reachable by voice', () => { assert.equal(I.parseNav('open admin'), null); });
test('confirmation answers', () => {
  const a = I.parseConfirmAnswer; assert.equal(a('yes send it').action, 'send'); assert.equal(a('ndiyo').action, 'send'); assert.equal(a('cancel').action, 'cancel'); assert.equal(a('no').action, 'cancel');
  assert.deepEqual(a('add and please bring change'), { action: 'append', text: 'please bring change' }); assert.equal(a('change it to I will come at five').text, 'I will come at five'); assert.equal(a('start again').action, 'redo'); assert.equal(a('banana').action, 'unknown');
});
test('choice by ordinal or name', () => {
  const o = [{ label: 'Mary Wanjiku' }, { label: 'Mary Atieno' }]; assert.equal(I.parseChoice('the second one', o), 1); assert.equal(I.parseChoice('Atieno', o), 1); assert.equal(I.parseChoice('wa kwanza', o), 0); assert.equal(I.parseChoice('Mary', o), -1);
});
