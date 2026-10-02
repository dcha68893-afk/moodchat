'use strict';
// Mirrors the clamp used by GET /notifications.
const clamp = (q) => {
  const page = Math.min(Math.max(parseInt(q.page, 10) || 1, 1), 1000);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
};
test('defaults', () => expect(clamp({})).toEqual({ page: 1, limit: 20, offset: 0 }));
test('caps limit at 100', () => expect(clamp({ limit: '1000000' }).limit).toBe(100));
test('rejects NaN / negatives / zero', () => {
  expect(clamp({ page: 'abc', limit: 'x' })).toEqual({ page: 1, limit: 20, offset: 0 });
  expect(clamp({ page: '-5', limit: '-1' })).toEqual({ page: 1, limit: 1, offset: 0 });
});
test('caps page so OFFSET stays bounded', () => expect(clamp({ page: '999999', limit: '100' }).offset).toBe(99900));
