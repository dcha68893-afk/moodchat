const test = require('node:test'); const assert = require('node:assert');
let instances = [];
class FakeRec {
  constructor() { instances.push(this); this.started = false; }
  start() { this.started = true; setTimeout(() => this.onaudiostart && this.onaudiostart(), 0); }
  stop() { setTimeout(() => this.onend && this.onend(), 5); }
  abort() { setTimeout(() => { this.onerror && this.onerror({ error: 'aborted' }); this.onend && this.onend(); }, 0); }
  // helpers used by tests
  say(list, idx = 0) { this.onresult({ resultIndex: idx, results: list.map(([t, f, c]) => Object.assign([{ transcript: t, confidence: c ?? 0.9 }], { isFinal: f })) }); }
  die(err) { if (err) this.onerror({ error: err }); this.onend(); }
}
globalThis.webkitSpeechRecognition = FakeRec;
const V = require('../../js/voice/necpra-voice-engine.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const last = () => instances[instances.length - 1];
async function begin(opts) { instances = []; const p = V.start(opts); await wait(20); return p; }

test('long sentence is preserved in full (no few-word truncation) and ordered', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  const words = Array.from({ length: 60 }, (_, i) => 'w' + i);
  last().say([[words.slice(0, 30).join(' '), false]]);
  last().say([[words.slice(0, 30).join(' '), true]], 0);
  last().say([[words.slice(0, 30).join(' '), true], [words.slice(30).join(' '), true]], 1);
  V.finish(); const r = await p;
  assert.equal(r.transcript, words.join(' ')); assert.equal(r.ok, true);
});
test('provider ending mid-dictation (pause) restarts and keeps earlier words', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  last().say([['I will bring the tomatoes', true]]); last().die();
  await wait(250); assert.equal(instances.length, 2, 'restarted');
  last().say([['tomorrow morning', true]]); V.finish(); const r = await p;
  assert.equal(r.transcript, 'I will bring the tomatoes tomorrow morning');
});
test('duplicate replay of the same final is dropped, real later repeat is kept', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  last().say([['two sukuma', true]]); last().say([['two sukuma', true]], 0);
  last().say([['two sukuma', true], ['two sukuma', true]], 1);
  V.finish(); const r = await p; assert.equal(r.segments.length, 1);
});
test('no-speech error does not end a dictation session', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  last().die('no-speech'); await wait(250); assert.equal(instances.length, 2); assert.equal(V.isListening(), true);
  last().say([['hello there', true]]); V.finish(); assert.equal((await p).transcript, 'hello there');
});
test('command mode auto-finishes only after the configured pause, not earlier', async () => {
  instances = []; const p = V.start({ mode: 'command', pauseMs: 1000 }); await wait(20);
  last().say([['open my wallet', true]]); await wait(500); assert.equal(V.isListening(), true, 'still listening during a short pause');
  const r = await p; assert.equal(r.transcript, 'open my wallet'); assert.equal(r.reason, 'silence');
});
test('dictation mode never auto-finishes on a pause', async () => {
  instances = []; const p = V.start({ mode: 'dictation', pauseMs: 1000 }); await wait(20);
  last().say([['thinking', true]]); await wait(1300); assert.equal(V.isListening(), true); V.finish(); await p;
});
test('spoken finish phrase ends session and is stripped from transcript', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  last().say([['tell mary I am coming finish recording', true]]); const r = await p;
  assert.equal(r.transcript, 'tell mary I am coming'); assert.equal(r.reason, 'voice-finish');
});
test('network drop preserves partial transcript and reports a clear recoverable error', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  last().say([['nimeuza nyanya mbili', true]]);
  for (let i = 0; i < 4; i++) { last().die('network'); await wait(900); }
  const r = await p; assert.equal(r.ok, false); assert.equal(r.error, 'network'); assert.equal(r.recoverable, true);
  assert.equal(r.transcript, 'nimeuza nyanya mbili'); assert.match(r.message, /kept/);
});
test('permission denied returns a specific error (no silent failure)', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20); last().die('not-allowed');
  const r = await p; assert.equal(r.error, 'not-allowed'); assert.match(r.message, /permission/i);
});
test('Swahili error text when language is sw', async () => {
  instances = []; const p = V.start({ mode: 'dictation', lang: 'sw' }); await wait(20); last().die('not-allowed');
  assert.match((await p).message, /kipaza sauti/);
});
test('uncertain (low confidence) segments are reported, never silently guessed', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  last().say([['send fifty shillings', true, 0.9]]); last().say([['send fifty shillings', true, 0.9], ['to mumbwa', true, 0.3]], 1); V.finish();
  const r = await p; assert.deepEqual(r.uncertain, ['to mumbwa']); assert.equal(r.transcript, 'send fifty shillings to mumbwa');
});
test('cancel discards everything and releases the session', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20); last().say([['secret', true]]); V.cancel();
  const r = await p; assert.equal(r.cancelled, true); assert.equal(r.transcript, ''); assert.equal(V.isListening(), false);
});
test('second start while active is refused; unfinished interim is kept on finish', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  assert.equal((await V.start({})).error, 'busy');
  last().say([['half said sentence', false]]); V.finish(); const r = await p;
  assert.equal(r.transcript, 'half said sentence'); assert.equal(r.segments[0].provisional, true);
});
test('instant-ending provider is detected as unstable instead of looping forever', async () => {
  instances = []; const p = V.start({ mode: 'dictation' }); await wait(20);
  for (let i = 0; i < 6 && V.isListening(); i++) { last().die(); await wait(220); }
  assert.equal((await p).error, 'unstable');
});
test('TTS chunks long text under the Chrome cutoff size', () => {
  const parts = V._internals.chunk(('word '.repeat(300)).trim() + '. Next sentence here.');
  assert.ok(parts.every(p => p.length <= 200)); assert.ok(parts.length > 3);
});
