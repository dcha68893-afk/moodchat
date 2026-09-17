// Runtime bootstrap for deployment configuration that must exist before src/server.js loads.
// Keep production origin configuration environment-driven; this only migrates the
// old Nexipa Render frontend value to the current public frontend when a stale
// Render variable is still present.
'use strict';

function clean(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const configuredFrontend = clean(process.env.FRONTEND_URL);
const currentFrontend = configuredFrontend && !/nexipa\.onrender\.com/i.test(configuredFrontend)
  ? configuredFrontend
  : 'https://necpra.co.ke';

process.env.FRONTEND_URL = currentFrontend;

const existing = clean(process.env.CORS_ADDITIONAL_ORIGINS)
  .split(',')
  .map(clean)
  .filter(Boolean);

if (!existing.includes(currentFrontend)) existing.push(currentFrontend);
process.env.CORS_ADDITIONAL_ORIGINS = existing.join(',');

// Friends/auth identity hardening: normalize the authenticated user ID at the
// authentication boundary, before any route can copy it into a strict integer
// Friends column. Some clients previously produced the transport artifact
// "N::N" (for example "1::1"). That is never a database user ID.
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
        return original.call(this, req, res, () => {
          normalizeRequestUser(req);
          next();
        });
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
          socket.userId = id;
          socket._authenticatedUserId = id;
          if (socket.user) socket.user = { ...socket.user, id, userId: id };
          next();
        });
      };
    }
  } catch (error) {
    console.warn('[Runtime] Auth ID normalization patch skipped:', error.message);
  }
}

patchAuthBoundary();

if (process.env.DEBUG_SERVER === '1') {
  console.log(`[Runtime] CORS frontend origin: ${currentFrontend}`);
}
