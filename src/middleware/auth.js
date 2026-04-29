const tokenService = require('../services/tokenService');

// ── Public paths that skip HTTP auth ─────────────────────────────────────────
// IMPORTANT: Do NOT include '/' unless you want ALL routes public.
const PUBLIC_PATHS = [
    '/api/health',
    '/api/info',
    '/api/cors-info',
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/validate-token',
    '/ws-test.html'
];

const isPublicPath = (req) => {
    const fullPath = (req.originalUrl || req.url || '').split('?')[0];

    if (fullPath === '/' || fullPath === '') return true;

    if (PUBLIC_PATHS.includes(fullPath)) return true;

    for (const publicPath of PUBLIC_PATHS) {
        if (fullPath.startsWith(publicPath + '/') || fullPath === publicPath) return true;
    }

    if (fullPath === '/health' || fullPath === '/api/health' || fullPath === '/status') return true;

    if (
        fullPath === '/api/status/health' ||
        fullPath === '/api/status/public' ||
        fullPath === '/api/status/trending' ||
        fullPath === '/api/status/search' ||
        /^\/api\/status\/mood\/[^/]+$/.test(fullPath) ||
        /^\/api\/status\/(?!my$|friends$|stats$|user(?:\/|$)|health$|public$|trending$|search$|mood(?:\/|$)|view$)[^/]+$/.test(fullPath) ||
        /^\/api\/status\/(?!my$|friends$|stats$|user(?:\/|$)|health$|public$|trending$|search$|mood(?:\/|$)|view$)[^/]+\/comments$/.test(fullPath) ||
        /^\/api\/status\/(?!my$|friends$|stats$|user(?:\/|$)|health$|public$|trending$|search$|mood(?:\/|$)|view$)[^/]+\/likes$/.test(fullPath) ||
        fullPath === '/api/status/view' ||
        /^\/api\/status\/(?!my$|friends$|stats$|user(?:\/|$)|health$|public$|trending$|search$|mood(?:\/|$)|view$)[^/]+\/view$/.test(fullPath)
    ) {
        return true;
    }

    return false;
};

// ── HTTP Token extraction ─────────────────────────────────────────────────────
const extractToken = (req) => {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader) return null;
    if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2) return null;
    const token = parts[1];
    return (token && token.trim()) ? token : null;
};

// ── HTTP Auth middleware ──────────────────────────────────────────────────────
const authenticateToken = (req, res, next) => {
    if (isPublicPath(req)) {
        return next();
    }

    try {
        const token = tokenService.extractTokenFromRequest
            ? tokenService.extractTokenFromRequest(req)
            : extractToken(req);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Authorization required',
                errorCode: 'MISSING_AUTH_HEADER'
            });
        }

        const verification = tokenService.verifyAccessToken(token);

        if (!verification.valid) {
            return res.status(401).json({
                success: false,
                message: verification.error === 'TOKEN_EXPIRED' ? 'Token expired' : 'Invalid token',
                errorCode: verification.error === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'
            });
        }

        const decoded = verification.decoded;
        const userId  = decoded.userId || decoded.id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token payload - missing user ID',
                errorCode: 'INVALID_PAYLOAD'
            });
        }

        req.user = {
            userId,
            id: userId,
            email:    decoded.email    || null,
            username: decoded.username || null,
            role:     decoded.role     || 'user',
            _verified: true,
            tokenType: decoded.type
        };

        next();

    } catch (error) {
        console.error('[Auth] Unexpected error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Authentication failed',
            errorCode: 'AUTH_MIDDLEWARE_ERROR'
        });
    }
};

const authenticate = authenticateToken;

// ── Role-based authorization ──────────────────────────────────────────────────
const authorize = (...roles) => {
    return (req, res, next) => {
        try {
            if (!req.user) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required before authorization.',
                    errorCode: 'NO_USER_CONTEXT'
                });
            }

            if (roles.length === 0) return next();

            const userRole = req.user.role;
            if (!userRole) {
                return res.status(403).json({
                    success: false,
                    message: 'User role not defined.',
                    errorCode: 'NO_ROLE'
                });
            }

            if (!roles.includes(userRole)) {
                return res.status(403).json({
                    success: false,
                    message: 'Insufficient permissions.',
                    errorCode: 'INSUFFICIENT_PERMISSIONS',
                    requiredRoles: roles,
                    userRole
                });
            }

            next();
        } catch (error) {
            console.error('[Auth] Authorization error:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Authorization failed.',
                errorCode: 'AUTHORIZATION_ERROR'
            });
        }
    };
};

/**
 * FIX: socketAuthenticate — auth middleware for Socket.IO handshake.
 *
 * This function is used with io.use(), NOT io.on('connection').
 * On failure it calls next(new Error(...)) which triggers 'connect_error'
 * on the client — NOT "io server disconnect".
 *
 * BEFORE (broken):
 *   io.on('connection', socket => {
 *     if (!valid) { socket.disconnect(true); return; } // ← causes "io server disconnect"
 *   });
 *
 * AFTER (fixed):
 *   io.use(socketAuthenticate);   // ← rejection = 'connect_error', not disconnect
 *   io.on('connection', socket => { ... }); // only reached if auth passed
 */
const socketAuthenticate = async (socket, next) => {
    try {
        let token = null;

        const authHeader = socket.handshake.headers.authorization ||
                           socket.handshake.headers.Authorization;
        const xAccessToken = socket.handshake.headers['x-access-token'];

        if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
            const parts = authHeader.split(' ');
            if (parts.length === 2) token = parts[1];
        } else if (xAccessToken) {
            token = xAccessToken;
        } else if (socket.handshake.auth && socket.handshake.auth.token) {
            token = socket.handshake.auth.token;
        } else if (socket.handshake.query && socket.handshake.query.token) {
            token = socket.handshake.query.token;
        }

        if (!token || token.trim() === '') {
            // FIX: next(error) — NOT socket.disconnect()
            return next(new Error('Authentication error: No token provided'));
        }

        const verification = tokenService.verifyAccessToken(token);

        if (!verification.valid) {
            // FIX: next(error) — NOT socket.disconnect()
            return next(new Error(
                verification.error === 'TOKEN_EXPIRED' ? 'Token expired' : 'Invalid token'
            ));
        }

        const decoded = verification.decoded;
        const userId  = decoded.userId || decoded.id;

        if (!userId) {
            return next(new Error('Invalid user information'));
        }

        socket.userId = userId;
        socket.user   = {
            id: userId,
            userId,
            email:    decoded.email    || null,
            username: decoded.username || null,
            role:     decoded.role     || 'user',
            _verified: true
        };
        socket._authenticatedUserId = userId;

        next(); // ← auth passed, proceed to 'connection' handler
    } catch (error) {
        console.error('[Auth] Socket auth error:', error.message);
        next(new Error('Authentication error'));
    }
};

module.exports = {
    authenticateToken,
    authenticate,
    authorize,
    socketAuthenticate,
    extractToken,
    isPublicPath,
    PUBLIC_PATHS
};