const _slog = (...a) => { if (process.env.DEBUG_SERVER) _slog(...a); };
﻿// src/routes/auth.js - CORRECTED VERSION
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const asyncHandler = require('express-async-handler');
// P1 FIX (Forensic Audit): bcrypt truncates at 72 bytes — pre-hash with SHA-256 first
const { hashPassword, comparePassword } = require('../utils/passwordUtils');

const router = express.Router();

// AUTH-X FIX: Do NOT capture db.Users at module load time — at that point
// sequelize.sync() has not completed and db.Users is undefined, causing every
// auth endpoint to throw "Cannot read property 'findOne' of undefined".
// Resolve lazily on first request via a getter function instead.
const _getDb = () => require('../models');
const _getUsers = () => {
    const db = _getDb();
    return db.User || db.Users || db.sequelize?.models?.Users || db.sequelize?.models?.User;
};

// IMPORT tokenService
const tokenService = require('../services/tokenService');
const { blacklistAccessToken } = require('../services/tokenBlacklistService');
const loginAttemptService = require('../services/loginAttemptService');
const emailService = require('../services/emailService');
const { checkPwnedPassword } = require('../utils/pwnedPasswordCheck');
const passwordHistoryService = require('../services/passwordHistoryService');

// IMPORT authenticateToken middleware
const { authenticateToken } = require('../middleware/auth');

// P1 FIX (Forensic Audit - "SAME SECRET FALLBACK"): match tokenService.js's
// canonical resolution order (JWT_ACCESS_SECRET first) so tokens signed here
// (reset/verification/MFA-temp) use the same secret tokenService resolves to,
// avoiding inconsistent verification if JWT_SECRET and JWT_ACCESS_SECRET differ.
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;

_slog('✅ AUTH ROUTER LOADED - FIXED VERSION');

// REGISTER ENDPOINT
router.post('/register', asyncHandler(async (req, res) => {
    _slog('📝 REGISTER called');
    const { email, username, password, name, acceptPrivacyPolicy } = req.body;

    // Validate required fields
    if (!email || !username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Email, username and password are required'
        });
    }

    // P3 FIX (Forensic Audit): proper email validation via validator.js
    // (falls back to a basic regex if the package isn't installed yet)
    let isEmailValid;
    try {
        isEmailValid = require('validator').isEmail(email);
    } catch (_) {
        isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    if (!isEmailValid) {
        return res.status(400).json({
            success: false,
            message: 'Valid email is required'
        });
    }

    if (username.length < 3) {
        return res.status(400).json({
            success: false,
            message: 'Username must be at least 3 characters'
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            success: false,
            message: 'Password must be at least 8 characters'
        });
    }

    // P2 FIX (Forensic Audit): reject passwords found in known data breaches
    // via the HaveIBeenPwned k-anonymity API. Fails open on API errors.
    const pwnedCheck = await checkPwnedPassword(password);
    if (pwnedCheck.pwned) {
        return res.status(400).json({
            success: false,
            message: 'This password has appeared in a data breach. Please choose a different password.',
            errorCode: 'PASSWORD_PWNED'
        });
    }

    try {
        // Check if email already exists
        const existingEmail = await _getUsers().findOne({ where: { email } });
        if (existingEmail) {
            return res.status(409).json({
                success: false,
                message: 'Email already in use'
            });
        }

        // Check if username already exists
        const existingUsername = await _getUsers().findOne({ where: { username } });
        if (existingUsername) {
            return res.status(409).json({
                success: false,
                message: 'Username already taken'
            });
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const newUser = await _getUsers().create({
            email,
            username,
            password: hashedPassword,
            ...(name && { firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' ') || null }),
            role: 'user',
            status: 'offline',
            // P3 FIX (Forensic Audit): "Privacy policy acceptance on registration"
            // Stored when the frontend sends acceptPrivacyPolicy: true (e.g. a
            // required checkbox). Optional for now so existing/older frontend
            // builds that don't send this field don't break registration.
            ...(acceptPrivacyPolicy === true && { acceptedPrivacyPolicyAt: new Date() })
        });

        // Generate tokens
        const token = tokenService.generateAccessToken(newUser);
        const refreshToken = tokenService.generateRefreshToken(newUser);

        await tokenService.storeRefreshToken(refreshToken, newUser.id, 7 * 24 * 60 * 60 * 1000, {
            userAgent: req.headers['user-agent'] || null,
            ipAddress: req.ip || null
        });

        _slog('✅ User registered:', newUser.id, newUser.username);
        // P3 FIX (Forensic Audit): seed password history with the initial password
        passwordHistoryService.recordPasswordHash(newUser.id, hashedPassword)
            .catch(e => console.warn('[Auth] Failed to record initial password history:', e.message));

        // P1 FIX (Forensic Audit): send an email verification link.
        // Reuses the existing resetToken/resetTokenExpiry columns with a
        // distinct JWT `type` claim, avoiding a new migration. isVerified
        // stays false until /auth/verify-email is hit; login is NOT blocked
        // (warn-but-allow), to avoid locking out users if SMTP is down.
        try {
            const verificationToken = jwt.sign(
                { userId: newUser.id, email: newUser.email, type: 'email_verification' },
                JWT_SECRET,
                { expiresIn: '24h' }
            );
            await newUser.update({
                resetToken: verificationToken,
                resetTokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });
            _slog(`📧 [VERIFY TOKEN] For ${newUser.email}: ${verificationToken}`);
            emailService.verificationEmail(newUser.email, { verificationToken })
                .catch(e => console.warn('[Auth] Failed to send verification email:', e.message));
        } catch (verifyErr) {
            console.warn('[Auth] Failed to generate verification token:', verifyErr.message);
        }

        res.status(201).json({
            success:      true,
            token:        token,
            accessToken:  token,
            refreshToken: refreshToken,
            expiresIn:    24 * 60 * 60,
            expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            requiresVerification: !newUser.isVerified,
            user: {
                id:       newUser.id,
                username: newUser.username,
                email:    newUser.email,
                avatar:   newUser.avatar || null,
                role:     newUser.role   || 'user',
                isVerified: newUser.isVerified || false
            }
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Registration failed: ' + error.message
        });
    }
}));

// LOGIN ENDPOINT
router.post('/login', asyncHandler(async (req, res) => {
    _slog('🔐 LOGIN called');
    const { identifier, password } = req.body;
    
    if (!identifier || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Email/username and password are required' 
        });
    }

    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';

    // P1 FIX (Forensic Audit): account lockout now persisted in Redis
    // (with in-memory fallback) so it survives server restarts and is
    // shared across instances, instead of an in-memory Map.
    const lockoutStatus = await loginAttemptService.checkLockout(identifier, clientIp);
    if (lockoutStatus.locked) {
        const remainingMinutes = Math.ceil(lockoutStatus.remainingSeconds / 60);
        return res.status(429).json({
            success: false,
            message: `Too many login attempts. Please wait ${remainingMinutes} minute(s) before trying again.`,
            errorCode: 'RATE_LIMITED'
        });
    }
    
    try {
        // Safe login query: try default SELECT * first; if migration columns are
        // missing (pg error 42703 = undefined_column) fall back to base columns only.
        const UsersModel = _getUsers();
        let user;
        // BUG FIX (login audit): the frontend's login page has Email/Mobile/
        // Username tabs and always POSTs whatever was typed as `identifier`
        // regardless of which tab was active — but this lookup only ever
        // matched against `email` or `username`, never `phone`. Users have a
        // `phone` column (settable from their profile) but logging in with
        // it always failed with "Invalid credentials" since it never
        // matched anything. Adding `phone` to the OR clause fixes the
        // Mobile tab without touching the frontend at all.
        const loginOrClause = [
            { email: identifier },
            { username: identifier },
            { phone: identifier }
        ];
        try {
            user = await UsersModel.findOne({
                where: {
                    [require('sequelize').Op.or]: loginOrClause
                }
            });
        } catch (findErr) {
            const isMissingCol = (findErr.original?.code === '42703') ||
                                 (findErr.message || '').includes('does not exist');
            if (isMissingCol) {
                console.warn('[AUTH] ⚠️  DB column missing — retrying with base attributes. Run migrations!', findErr.message);
                user = await UsersModel.findOne({
                    where: {
                        [require('sequelize').Op.or]: loginOrClause
                    },
                    attributes: ['id', 'email', 'username', 'phone', 'password', 'avatar',
                                 'firstName', 'lastName', 'role', 'isVerified',
                                 'isActive', 'status', 'lastSeen', 'settings',
                                 'theme', 'language', 'createdAt', 'updatedAt']
                });
            } else {
                throw findErr;
            }
        }
        
        if (!user) {
            await loginAttemptService.recordFailedAttempt(identifier, clientIp);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        const valid = await comparePassword(password, user.password);
        if (!valid) {
            const newCount = await loginAttemptService.recordFailedAttempt(identifier, clientIp);

            // P1/P2 FIX: alert the account owner once they hit the lockout threshold
            if (newCount >= loginAttemptService.MAX_ATTEMPTS && user.email) {
                emailService.loginAttemptsAlert(user.email, {
                    identifier,
                    ip: clientIp,
                    attempts: newCount
                }).catch(e => console.warn('[Auth] Failed to send login attempts alert:', e.message));
            }

            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Successful login — clear any tracked failed attempts
        await loginAttemptService.clearAttempts(identifier, clientIp);

        // P2 FIX (Forensic Audit): notify the user of a login from a device
        // (User-Agent) we haven't seen for this account before.
        //
        // FIX (Security settings audit): this used to fire unconditionally,
        // completely ignoring Settings > Security > "Login Notifications"
        // (saved by settings-ui.js as security.loginNotifications via
        // PUT /api/settings). The toggle saved fine and showed "Saved" but
        // had zero effect on whether an email actually went out — a classic
        // placeholder setting. `user.settings` is already selected in the
        // attributes list above, so this is just reading what's already in
        // memory. Default is opt-out (true unless explicitly set to false),
        // matching the frontend's own `settings.loginNotifications !== false`
        // default-checked logic in settings-ui.js's loadSecuritySection().
        const loginNotificationsEnabled = user.settings?.security?.loginNotifications !== false;
        const userAgent = req.headers['user-agent'] || null;
        if (user.email && userAgent && loginNotificationsEnabled) {
            tokenService.hasKnownDevice(user.id, userAgent).then(known => {
                if (!known) {
                    emailService.newDeviceLoginAlert(user.email, {
                        device: userAgent,
                        ip: clientIp,
                        time: new Date().toISOString()
                    }).catch(e => console.warn('[Auth] Failed to send new-device alert:', e.message));
                }
            }).catch(() => {});
        }

        // P2 FIX (Forensic Audit): if 2FA/MFA is enabled, do not issue real
        // access/refresh tokens yet. Issue a short-lived tempToken that only
        // POST /auth/2fa/challenge can exchange (with a valid TOTP code) for
        // real tokens.
        if (user.mfaEnabled === true) {
            const tempToken = jwt.sign(
                { userId: user.id, type: 'mfa_temp' },
                JWT_SECRET,
                { expiresIn: '10m' }
            );
            return res.json({
                success: true,
                requiresMfa: true,
                tempToken
            });
        }
        
        // Generate tokens
        const token = tokenService.generateAccessToken(user);
        const refreshToken = tokenService.generateRefreshToken(user);
        
        await tokenService.storeRefreshToken(refreshToken, user.id, 7 * 24 * 60 * 60 * 1000, {
            userAgent: req.headers['user-agent'] || null,
            ipAddress: req.ip || null
        });
        
        res.json({
            success:      true,
            token:        token,
            accessToken:  token,
            refreshToken: refreshToken,
            expiresIn:    24 * 60 * 60,
            expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            user: {
                id:       user.id,
                username: user.username,
                email:    user.email,
                avatar:   user.avatar || null,
                role:     user.role   || 'user'
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Login failed: ' + error.message 
        });
    }
}));

// POST /auth/google — "Sign in with Google" (frontend: js/google-auth.js)
// FIX: authService.loginWithGoogle() already existed (verifies the Google ID
// token, auto-creates an account on first sign-in, issues tokens) but no
// route ever called it, so POST /api/auth/google 404'd — "route not found"
// on the Google button. This just wires the existing service to the route
// the frontend has always been calling, matching /login's response shape
// (token/accessToken/refreshToken/expiresIn/user) so the frontend's existing
// handleCredentialResponse() needs no changes.
router.post('/google', asyncHandler(async (req, res) => {
    const { credential } = req.body;
    if (!credential) {
        return res.status(400).json({ success: false, message: 'Google credential is required' });
    }

    const authService = require('../services/authService');
    const result = await authService.loginWithGoogle(credential);

    if (!result.success) {
        const status = result.code === 'GOOGLE_AUTH_ERROR' ? 401 : 500;
        return res.status(status).json({ success: false, message: result.message || 'Google sign-in failed' });
    }

    res.json({
        success:      true,
        token:        result.tokens.accessToken,
        accessToken:  result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn:    result.tokens.expiresIn || 24 * 60 * 60,
        user: {
            id:       result.user.id,
            username: result.user.username,
            email:    result.user.email,
            avatar:   result.user.avatar || null,
            role:     result.user.role || 'user'
        }
    });
}));

// GET /me - Get current user info
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        
        _slog('[AUTH] /me called for user:', userId);
        
        const user = await _getUsers().findByPk(userId, {
            attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'role', 'status', 'lastSeen', 'mfaEnabled']
        });
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username;

        // PHASE15 FIX: Frontend getCurrentUser() reads response.data and sets
        // window.currentUser = response.data. If we nest the user under data.user,
        // then window.currentUser ends up as { user: {...} } which breaks
        // window.currentUser.id throughout the app.
        // FIX: expose user fields directly on data (and also keep data.user for
        // any code that explicitly reads response.data.user).
        const userPayload = {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
            displayName: displayName,
            firstName: user.firstName,
            lastName: user.lastName,
            bio: user.bio,
            role: user.role || 'user',
            status: user.status || 'offline',
            lastActive: user.lastSeen,
            mfaEnabled: !!user.mfaEnabled
        };

        res.json({
            success: true,
            user: userPayload,   // top-level user for legacy callers
            data: userPayload    // data IS the user — so window.currentUser = response.data works
        });
    } catch (error) {
        console.error('[AUTH] Error in /me endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
}));

// POST /validate-token
router.post('/validate-token', async (req, res) => {
    _slog('🔍 VALIDATE TOKEN CALLED');
    
    let token = req.headers.authorization?.split(' ')[1] || req.body.token;
    
    if (!token) {
        return res.status(400).json({ 
            success: false, 
            valid: false, 
            message: 'Token required' 
        });
    }
    
    try {
        const result = tokenService.verifyAccessToken(token);
        
        if (result.valid) {
            _slog('✅ Token valid for user:', result.decoded.userId);
            
            res.json({
                success: true,
                valid: true,
                authValidated: true,
                user: {
                    id: result.decoded.userId,
                    userId: result.decoded.userId,
                    email: result.decoded.email,
                    username: result.decoded.username,
                    role: result.decoded.role || 'user'
                },
                userId: result.decoded.userId
            });
        } else {
            res.status(401).json({ 
                success: false, 
                valid: false, 
                message: result.message || 'Invalid token',
                code: result.error
            });
        }
    } catch (error) {
        console.error('❌ Token validation error:', error.message);
        res.status(401).json({ 
            success: false, 
            valid: false, 
            message: error.message 
        });
    }
});

// POST /refresh
router.post('/refresh', asyncHandler(async (req, res) => {
    _slog('🔄 Refresh token called');
    
    const refreshToken = req.body.refreshToken || req.headers['x-refresh-token'];
    
    if (!refreshToken) {
        return res.status(400).json({
            success: false,
            message: 'Refresh token required'
        });
    }
    
    const result = tokenService.verifyRefreshToken(refreshToken);
    
    if (!result.valid) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired refresh token'
        });
    }
    
    const stored = await tokenService.validateStoredRefreshToken(refreshToken);
    if (!stored.valid) {
        return res.status(401).json({
            success: false,
            message: 'Refresh token not found or expired'
        });
    }
    
    const user = await _getUsers().findByPk(stored.userId);
    
    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }
    
    const newToken = tokenService.generateAccessToken(user);
    const newRefreshToken = tokenService.generateRefreshToken(user);
    
    await tokenService.invalidateRefreshToken(refreshToken);
    await tokenService.storeRefreshToken(newRefreshToken, user.id, 7 * 24 * 60 * 60 * 1000, {
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || null
    });
    
    res.json({
        success: true,
        token: newToken,
        refreshToken: newRefreshToken,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
        }
    });
}));

// POST /logout
router.post('/logout', authenticateToken, asyncHandler(async (req, res) => {
    const refreshToken = req.body.refreshToken;
    if (refreshToken) {
        await tokenService.invalidateRefreshToken(refreshToken);
    }

    // PHASE15 FIX: Also revoke ALL refresh tokens for this user so every device
    // is forced to re-authenticate. This prevents a logged-out session on one device
    // from being replayed on another device that still holds the same refresh token.
    const userId = req.user?.userId || req.user?.id;
    if (userId) {
        try {
            const TokenModel = tokenService.getTokenModel();
            if (TokenModel) {
                await TokenModel.update(
                    { isRevoked: true },
                    { where: { userId, tokenType: 'refresh', isRevoked: false } }
                );
            }
        } catch (revokeErr) {
            console.warn('[Auth] Could not revoke all refresh tokens on logout (non-fatal):', revokeErr.message);
        }

        // Update user status to offline
        try {
            const db = require('../models');
            const Users = db.User || db.Users;
            if (Users) {
                await Users.update(
                    { status: 'offline', lastSeen: new Date() },
                    { where: { id: userId } }
                );
            }
        } catch (_) {}
    }

    // P1 FIX (Forensic Audit): blacklist the access token so it can't be
    // used for impersonation for the remainder of its 24h lifetime.
    const accessToken = tokenService.extractTokenFromRequest(req);
    if (accessToken) {
        await blacklistAccessToken(accessToken);
    }

    res.json({
        success: true,
        message: 'Logged out successfully'
    });
}));

// POST /forgot-password
// FIX: This route was missing — frontend calls /auth/forgot-password but it was never registered
router.post('/forgot-password', asyncHandler(async (req, res) => {
    _slog('📧 FORGOT PASSWORD called');
    const { email } = req.body;

    if (!email || !email.includes('@')) {
        return res.status(400).json({
            success: false,
            message: 'Valid email is required'
        });
    }

    try {
        const user = await _getUsers().findOne({ where: { email: email.toLowerCase().trim() } });

        // Always return success to prevent email enumeration attacks
        if (!user) {
            return res.status(200).json({
                success: true,
                message: 'If an account exists with this email, a password reset link has been sent'
            });
        }

        const crypto = require('crypto');
        const jwt = require('jsonwebtoken');
        const JWT_SECRET_KEY = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET; // P1 FIX: canonical order

        // Generate a signed reset token (expires in 1 hour)
        const resetToken = jwt.sign(
            { userId: user.id, email: user.email, type: 'reset' },
            JWT_SECRET_KEY,
            { expiresIn: '1h' }
        );

        const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

        await user.update({
            resetToken: resetToken,
            resetTokenExpiry: resetTokenExpiry
        });

        // P1 FIX (Forensic Audit): actually send the password reset email.
        // Falls back to console logging if SMTP is not configured (dev mode).
        _slog(`📧 [RESET TOKEN] For ${email}: ${resetToken}`);
        emailService.passwordResetEmail(user.email, { resetToken })
            .catch(e => console.warn('[Auth] Failed to send password reset email:', e.message));

        return res.status(200).json({
            success: true,
            message: 'If an account exists with this email, a password reset link has been sent',
            // REMOVE the line below before going to production — it exposes the token
            ...(process.env.NODE_ENV !== 'production' && { resetToken })
        });
    } catch (error) {
        console.error('❌ Forgot password error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to process password reset request'
        });
    }
}));

// GET /verify-email?token=X
// P1 FIX (Forensic Audit): wires up email verification — sets isVerified=true
router.get('/verify-email', asyncHandler(async (req, res) => {
    const resetToken = req.query.token;

    if (!resetToken) {
        return res.status(400).json({ success: false, message: 'Verification token is required' });
    }

    try {
        let decoded;
        try {
            decoded = jwt.verify(resetToken, JWT_SECRET);
        } catch (jwtErr) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification token' });
        }

        if (decoded.type !== 'email_verification') {
            return res.status(400).json({ success: false, message: 'Invalid verification token type' });
        }

        const { Op } = require('sequelize');
        const user = await _getUsers().findOne({
            where: {
                id: decoded.userId,
                resetToken: resetToken,
                resetTokenExpiry: { [Op.gt]: new Date() }
            }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification token' });
        }

        await user.update({
            isVerified: true,
            resetToken: null,
            resetTokenExpiry: null
        });

        _slog('✅ Email verified for user:', user.id);

        return res.status(200).json({
            success: true,
            message: 'Email verified successfully. You can now use all features of your account.'
        });
    } catch (error) {
        console.error('❌ Email verification error:', error);
        return res.status(500).json({ success: false, message: 'Failed to verify email' });
    }
}));

// POST /resend-verification  { email }
// P1 FIX (Forensic Audit): allow resending the verification email
router.post('/resend-verification', asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Valid email is required' });
    }

    try {
        const user = await _getUsers().findOne({ where: { email: email.toLowerCase().trim() } });

        // Always return success to prevent email enumeration
        if (!user || user.isVerified) {
            return res.status(200).json({
                success: true,
                message: 'If an unverified account exists with this email, a verification link has been sent'
            });
        }

        const verificationToken = jwt.sign(
            { userId: user.id, email: user.email, type: 'email_verification' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        await user.update({
            resetToken: verificationToken,
            resetTokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });

        _slog(`📧 [VERIFY TOKEN] For ${email}: ${verificationToken}`);
        emailService.verificationEmail(user.email, { verificationToken })
            .catch(e => console.warn('[Auth] Failed to send verification email:', e.message));

        return res.status(200).json({
            success: true,
            message: 'If an unverified account exists with this email, a verification link has been sent'
        });
    } catch (error) {
        console.error('❌ Resend verification error:', error);
        return res.status(500).json({ success: false, message: 'Failed to resend verification email' });
    }
}));

// POST /reset-password
// FIX: This route was missing — frontend calls /auth/reset-password but it was never registered
router.post('/reset-password', asyncHandler(async (req, res) => {
    _slog('🔑 RESET PASSWORD called');
    const { token, newPassword, password } = req.body;
    const resetToken = token;
    const passwordToSet = newPassword || password;

    if (!resetToken) {
        return res.status(400).json({ success: false, message: 'Reset token is required' });
    }
    if (!passwordToSet || passwordToSet.length < 8) {
        return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    try {
        const jwt = require('jsonwebtoken');
        const JWT_SECRET_KEY = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET; // P1 FIX: canonical order

        // Verify the JWT reset token
        let decoded;
        try {
            decoded = jwt.verify(resetToken, JWT_SECRET_KEY);
        } catch (jwtErr) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        if (decoded.type !== 'reset') {
            return res.status(400).json({ success: false, message: 'Invalid reset token type' });
        }

        // Find user and confirm token still matches (not already used)
        const { Op } = require('sequelize');
        const user = await _getUsers().findOne({
            where: {
                id: decoded.userId,
                resetToken: resetToken,
                resetTokenExpiry: { [Op.gt]: new Date() }
            }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        // P3 FIX (Forensic Audit): "Implement password history (last 5)"
        if (await passwordHistoryService.isPasswordReused(user.id, passwordToSet)) {
            return res.status(400).json({
                success: false,
                message: `You can't reuse one of your last ${passwordHistoryService.HISTORY_LIMIT} passwords. Please choose a different password.`,
                errorCode: 'PASSWORD_REUSED'
            });
        }

        // Hash the new password
        const hashedPassword = await hashPassword(passwordToSet);

        // Update password and clear the reset token
        await user.update({
            password: hashedPassword,
            resetToken: null,
            resetTokenExpiry: null
        });
        await passwordHistoryService.recordPasswordHash(user.id, hashedPassword);

        _slog('✅ Password reset successful for user:', user.id);

        // P2 FIX (Forensic Audit): notify the user their password changed,
        // so they can react quickly if it wasn't them.
        if (user.email) {
            emailService.passwordChangedAlert(user.email)
                .catch(e => console.warn('[Auth] Failed to send password changed alert:', e.message));
        }

        return res.status(200).json({
            success: true,
            message: 'Password has been reset successfully. You can now log in with your new password.'
        });
    } catch (error) {
        console.error('❌ Reset password error:', error);
        return res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
}));

// GET /sessions
router.get('/sessions', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        
        _slog('[AUTH] /sessions called for user:', userId);
        
        const sessions = await tokenService.listUserRefreshSessions(userId);
        res.status(200).json({
            success: true,
            data: sessions
        });
        
    } catch (error) {
        console.error('[AUTH] Error fetching sessions:', error.message);
        res.status(200).json({
            success: true,
            data: []
        });
    }
}));

// Temporary debug endpoint to check token
router.get('/check-token', authenticateToken, asyncHandler(async (req, res) => {
    res.json({
        success: true,
        user: req.user,
        tokenReceived: true
    });
}));

// ── P1 FIX: FCM push token registration ──────────────────────────────────────
// POST /api/auth/fcm-token  { token: "fcm_device_token" }
router.post('/fcm-token', authenticateToken, asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.length < 10) {
        return res.status(400).json({ success: false, message: 'Valid FCM token required' });
    }
    try {
        const pushService = require('../services/pushService');
        const userId = req.user?.id || req.user?.uid;
        const saved = await pushService.registerToken(userId, token);
        return res.json({ success: true, message: saved ? 'FCM token registered' : 'Token save skipped' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to register token', error: e.message });
    }
}));

// DELETE /api/auth/fcm-token  — clear token on logout
router.delete('/fcm-token', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const db   = require('../models');
        const User = db.models?.Users || db.Users;
        const userId = req.user?.id || req.user?.uid;
        if (User && userId) await User.update({ fcmToken: null }, { where: { id: userId } });
        return res.json({ success: true, message: 'FCM token cleared' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to clear token' });
    }
}));

// ── P2 FIX (Forensic Audit): Two-Factor Authentication (TOTP) ────────────────
// POST /auth/2fa/enable — generate a TOTP secret + QR code for the logged-in user
router.post('/2fa/enable', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const { authenticator } = require('otplib');
        const QRCode = require('qrcode');

        const userId = req.user.userId || req.user.id;
        const user = await _getUsers().findByPk(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.mfaEnabled) {
            return res.status(409).json({ success: false, message: '2FA is already enabled' });
        }

        const secret = authenticator.generateSecret();
        const otpauthUrl = authenticator.keyuri(user.email, 'Nexopa', secret);
        const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

        // Store secret but DO NOT enable 2FA yet — must verify first via /2fa/verify
        await user.update({ mfaSecret: secret });

        return res.json({
            success: true,
            message: 'Scan the QR code with your authenticator app, then verify with a code to enable 2FA',
            secret,
            otpauthUrl,
            qrCode: qrCodeDataUrl
        });
    } catch (e) {
        console.error('❌ 2FA enable error:', e);
        return res.status(500).json({ success: false, message: 'Failed to start 2FA setup', error: e.message });
    }
}));

// POST /auth/2fa/verify  { token: "123456" } — confirms setup and turns on mfaEnabled
router.post('/2fa/verify', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const { authenticator } = require('otplib');
        const { token: totpToken } = req.body;

        if (!totpToken) {
            return res.status(400).json({ success: false, message: 'TOTP code is required' });
        }

        const userId = req.user.userId || req.user.id;
        const user = await _getUsers().findByPk(userId);
        if (!user || !user.mfaSecret) {
            return res.status(400).json({ success: false, message: '2FA setup has not been started' });
        }

        const isValid = authenticator.verify({ token: totpToken, secret: user.mfaSecret });
        if (!isValid) {
            return res.status(400).json({ success: false, message: 'Invalid TOTP code' });
        }

        await user.update({ mfaEnabled: true });

        return res.json({ success: true, message: '2FA has been enabled for your account' });
    } catch (e) {
        console.error('❌ 2FA verify error:', e);
        return res.status(500).json({ success: false, message: 'Failed to verify 2FA code', error: e.message });
    }
}));

// POST /auth/2fa/disable  { token: "123456" } — requires a valid TOTP code to turn off 2FA
router.post('/2fa/disable', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const { authenticator } = require('otplib');
        const { token: totpToken } = req.body;

        const userId = req.user.userId || req.user.id;
        const user = await _getUsers().findByPk(userId);
        if (!user || !user.mfaEnabled) {
            return res.status(400).json({ success: false, message: '2FA is not enabled' });
        }

        if (!totpToken || !authenticator.verify({ token: totpToken, secret: user.mfaSecret })) {
            return res.status(400).json({ success: false, message: 'Invalid TOTP code' });
        }

        await user.update({ mfaEnabled: false, mfaSecret: null });

        return res.json({ success: true, message: '2FA has been disabled for your account' });
    } catch (e) {
        console.error('❌ 2FA disable error:', e);
        return res.status(500).json({ success: false, message: 'Failed to disable 2FA', error: e.message });
    }
}));

// POST /auth/2fa/challenge  { tempToken, token: "123456" }
// Exchanges a valid tempToken (from /auth/login when mfaEnabled) + TOTP code
// for real access/refresh tokens.
router.post('/2fa/challenge', asyncHandler(async (req, res) => {
    try {
        const { authenticator } = require('otplib');
        const { tempToken, token: totpToken } = req.body;

        if (!tempToken || !totpToken) {
            return res.status(400).json({ success: false, message: 'tempToken and TOTP code are required' });
        }

        let decoded;
        try {
            decoded = jwt.verify(tempToken, JWT_SECRET);
        } catch (jwtErr) {
            return res.status(401).json({ success: false, message: 'Invalid or expired tempToken' });
        }

        if (decoded.type !== 'mfa_temp') {
            return res.status(400).json({ success: false, message: 'Invalid token type' });
        }

        const user = await _getUsers().findByPk(decoded.userId);
        if (!user || !user.mfaEnabled || !user.mfaSecret) {
            return res.status(400).json({ success: false, message: '2FA is not enabled for this account' });
        }

        const cleanToken = String(totpToken).replace(/\s/g, '').toUpperCase();
        let isValid = authenticator.verify({ token: totpToken, secret: user.mfaSecret });

        // FIX (2FA audit): fall back to a one-time backup code if the TOTP
        // check fails. Backup codes are generated during /2fa/setup and
        // shown to the user once — without this fallback they were
        // decorative only, since nothing ever consumed them.
        let usedBackupCode = false;
        if (!isValid && Array.isArray(user.mfaBackupCodes)) {
            const codes = user.mfaBackupCodes;
            const matchIdx = codes.findIndex(c => !c.used && String(c.code).replace(/-/g, '').toUpperCase() === cleanToken.replace(/-/g, ''));
            if (matchIdx >= 0) {
                codes[matchIdx].used = true;
                await user.update({ mfaBackupCodes: codes });
                isValid = true;
                usedBackupCode = true;
            }
        }

        if (!isValid) {
            return res.status(401).json({ success: false, message: 'Invalid TOTP code' });
        }

        // Issue real tokens now that MFA is satisfied
        const accessToken = tokenService.generateAccessToken(user);
        const refreshToken = tokenService.generateRefreshToken(user);

        await tokenService.storeRefreshToken(refreshToken, user.id, 7 * 24 * 60 * 60 * 1000, {
            userAgent: req.headers['user-agent'] || null,
            ipAddress: req.ip || null
        });

        return res.json({
            success:      true,
            token:        accessToken,
            accessToken:  accessToken,
            refreshToken: refreshToken,
            expiresIn:    24 * 60 * 60,
            expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            user: {
                id:       user.id,
                username: user.username,
                email:    user.email,
                avatar:   user.avatar || null,
                role:     user.role   || 'user'
            }
        });
    } catch (e) {
        console.error('❌ 2FA challenge error:', e);
        return res.status(500).json({ success: false, message: '2FA challenge failed', error: e.message });
    }
}));

// POST /validate — alias for /validate-token (frontend api.auth.js calls /api/auth/validate)
router.post('/validate', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: 'Token required', code: 'MISSING_TOKEN' });
        const tokenService = require('../services/tokenService');
        const result = tokenService.verifyAccessToken(token);
        if (result.valid) {
            return res.json({ success: true, valid: true, user: result.decoded });
        }
        return res.json({ success: false, valid: false, message: result.message || 'Invalid token', code: result.error || 'INVALID_TOKEN' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});


module.exports = router;