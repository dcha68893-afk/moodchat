'use strict';
const express = require('express');
const request = require('supertest');
const { paymentLimiter } = require('../../src/middleware/rateLimiter');

function app() {
  const a = express();
  a.use((req, _res, next) => { req.user = { id: Number(req.get('x-uid') || 1) }; next(); });
  a.post('/pay', paymentLimiter, (_req, res) => res.json({ ok: true }));
  return a;
}

test('allows 10 payment calls per minute per user, then 429', async () => {
  const a = app(); const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await request(a).post('/pay').set('x-uid', '501')).status);
  expect(codes.filter((c) => c === 200)).toHaveLength(10);
  expect(codes.slice(10)).toEqual([429, 429]);
});

test('limit is per user, not shared across users behind one IP', async () => {
  const a = app();
  for (let i = 0; i < 10; i++) await request(a).post('/pay').set('x-uid', '601');
  expect((await request(a).post('/pay').set('x-uid', '601')).status).toBe(429);
  expect((await request(a).post('/pay').set('x-uid', '602')).status).toBe(200);
});
