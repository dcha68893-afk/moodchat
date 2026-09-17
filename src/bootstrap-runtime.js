// Runtime bootstrap for deployment configuration that must exist before src/server.js loads.
'use strict';

function clean(value) { return String(value || '').trim().replace(/\/+$/, ''); }
const configuredFrontend = clean(process.env.FRONTEND_URL);
const currentFrontend = configuredFrontend && !/nexipa\.onrender\.com/i.test(configuredFrontend) ? configuredFrontend : 'https://necpra.co.ke';
process.env.FRONTEND_URL = currentFrontend;
const existing = clean(process.env.CORS_ADDITIONAL_ORIGINS).split(',').map(clean).filter(Boolean);
if (!existing.includes(currentFrontend)) existing.push(currentFrontend);
process.env.CORS_ADDITIONAL_ORIGINS = existing.join(',');

function normalizeAuthenticatedUserId(raw) {
  if (raw === undefined || raw === null) return raw;
  const value = String(raw).trim();
  if (!value) return value;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value.split('::').map(part => part.trim());
  if (parts.length > 1 && parts.every(part => /^\d+$/.test(part))) {
    const first = Number(parts[0]);
    if (parts.every(part => Number(part) === first)) return first;
  }
  return value;
}
function normalizeRequestUser(req) {
  if (!req || !req.user) return;
  const raw = req.user.userId ?? req.user.id;
  const id = normalizeAuthenticatedUserId(raw);
  req.user = { ...req.user, id, userId: id };
}
function patchAuthBoundary() {
  try {
    const authPath = require.resolve('./middleware/auth');
    const auth = require(authPath);
    const wrapHttp = (original) => {
      if (typeof original !== 'function') return original;
      return function normalizedAuth(req, res, next) {
        return original.call(this, req, res, () => { normalizeRequestUser(req); next(); });
      };
    };
    auth.authenticateToken = wrapHttp(auth.authenticateToken);
    auth.authenticate = auth.authenticateToken;
    auth.optionalAuthenticateToken = wrapHttp(auth.optionalAuthenticateToken);
    if (typeof auth.socketAuthenticate === 'function') {
      const originalSocketAuth = auth.socketAuthenticate;
      auth.socketAuthenticate = function normalizedSocketAuth(socket, next) {
        return originalSocketAuth.call(this, socket, () => {
          const id = normalizeAuthenticatedUserId(socket.userId ?? socket.user?.userId ?? socket.user?.id);
          socket.userId = id; socket._authenticatedUserId = id;
          if (socket.user) socket.user = { ...socket.user, id, userId: id };
          next();
        });
      };
    }
  } catch (error) { console.warn('[Runtime] Auth ID normalization patch skipped:', error.message); }
}
patchAuthBoundary();

// Realtime friend bridge. The Friends REST routes correctly commit relationship
// changes, but they do not themselves emit Socket.IO events. Patch Express's
// response serializer before the application mounts its routes, then translate
// successful friend mutations into events for both affected users. This keeps
// the normal REST contract untouched and avoids polling the database.
(function installFriendResponseBridge(){
  try {
    const express = require('express');
    const originalJson = express.response.json;
    if (originalJson.__necpaFriendBridge) return;
    function emitFriendEvent(userId, event, payload) {
      const uid = Number(userId);
      const io = global.__socketIO || global.__io || global.io;
      if (!io || !Number.isInteger(uid) || uid <= 0) return;
      try { io.to(`user:${uid}`).emit(event, payload); } catch (_) {}
      try { io.to(`user_${uid}`).emit(event, payload); } catch (_) {}
    }
    function patchedJson(body) {
      try {
        const req = this.req;
        if (body && body.success === true && req && req.user) {
          const method = String(req.method || '').toUpperCase();
          const path = String(req.originalUrl || req.path || '');
          const actorId = Number(req.user.userId ?? req.user.id);
          const requestIdMatch = path.match(/\/friends\/requests\/(\d+)\/(accept|reject)$/i);
          const requestId = requestIdMatch ? Number(requestIdMatch[1]) : null;
          const action = requestIdMatch && requestIdMatch[2] ? requestIdMatch[2].toLowerCase() : null;
          if (method === 'POST' && /^\/friends\/requests\/?(?:\?|$)/i.test(path)) {
            const targetId = Number(req.body?.userId);
            const id = body.request?.id || body.data?.id || null;
            const payload = { requestId: id, senderId: actorId, receiverId: targetId, timestamp: Date.now() };
            emitFriendEvent(targetId, 'friend:request', payload);
            emitFriendEvent(actorId, 'friend:request', payload);
          } else if (requestId && (action === 'accept' || action === 'reject')) {
            const db = require('./models');
            db.sequelize.query('SELECT "requester_id","receiver_id" FROM "friends" WHERE "id"=:id LIMIT 1', { replacements: { id: requestId }, type: db.sequelize.QueryTypes.SELECT })
              .then(rows => {
                const row = rows[0]; if (!row) return;
                const payload = { requestId, requesterId: Number(row.requester_id), receiverId: Number(row.receiver_id), status: action === 'accept' ? 'accepted' : 'rejected', timestamp: Date.now() };
                const event = action === 'accept' ? 'friend:accepted' : 'friend:rejected';
                emitFriendEvent(payload.requesterId, event, payload); emitFriendEvent(payload.receiverId, event, payload);
              }).catch(() => {});
          }
        }
      } catch (_) {}
      return originalJson.call(this, body);
    }
    patchedJson.__necpaFriendBridge = true;
    express.response.json = patchedJson;
  } catch (error) { console.warn('[Runtime] Friend realtime bridge skipped:', error.message); }
})();

if (process.env.DEBUG_SERVER === '1') console.log(`[Runtime] CORS frontend origin: ${currentFrontend}`);
