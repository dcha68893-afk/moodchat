'use strict';
// Mirrors the token-bucket arithmetic used by the socket message:send handler.
function take(socket, now) {
  const b = socket.__sendBucket || (socket.__sendBucket = { tokens: 30, ts: now });
  b.tokens = Math.min(30, b.tokens + ((now - b.ts) / 1000) * 5);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
test('allows a 30-message burst then blocks', () => {
  const s = {}; let ok = 0;
  for (let i = 0; i < 100; i++) if (take(s, 1000)) ok++;
  expect(ok).toBe(30);
});
test('refills at 5/sec', () => {
  const s = {};
  for (let i = 0; i < 30; i++) take(s, 0);
  expect(take(s, 0)).toBe(false);
  expect(take(s, 1000)).toBe(true);   // +5 tokens after 1s
  let n = 0; for (let i = 0; i < 10; i++) if (take(s, 1000)) n++;
  expect(n).toBe(4);                  // 5 refilled, 1 used above
});
test('a normal human pace (1 msg/s) is never blocked', () => {
  const s = {};
  for (let t = 0; t < 600; t++) expect(take(s, t * 1000)).toBe(true);
});
