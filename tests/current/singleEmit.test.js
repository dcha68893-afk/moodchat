'use strict';
// Regression: group/game events were emitted once per room name (user:<id> and
// user_<id>). A socket joined to both rooms therefore received every event twice.
// The fix emits ONCE to the union of both rooms (Socket.IO delivers once per socket).
// (Verified end-to-end with real Socket.IO servers + the Redis adapter; this test is
// the dependency-free guard.)
const svc = require('../../src/services/groupMessagingService');

function fakeIo() {
  const calls = [];
  return { calls, to(target) { return { emit(ev, payload) { calls.push({ target, ev, payload }); } }; } };
}

test('group emit sends one emit per member covering both user rooms', async () => {
  const io = fakeIo();
  await svc.emit(io, [5, 7], 'group:message', { x: 1 });
  expect(io.calls).toHaveLength(2);                                   // one per member, not two
  expect(io.calls[0].target).toEqual(['user:5', 'user_5']);
  expect(io.calls[1].target).toEqual(['user:7', 'user_7']);
});

test('group emit is a no-op without io (does not throw)', async () => {
  await expect(svc.emit(null, [1], 'group:message', {})).resolves.toBeUndefined();
});
