// src/routes/auth.js - CORRECTED VERSION
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const asyncHandler = require('express-async-handler');

const router = express.Router();
const db = require('../models');
const Users = db.User || db.Users;

// IMPORT tokenService
const tokenService = require('../services/tokenService');

// IMPORT authenticateToken middleware
const { authenticateToken } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;

console.log('✅ AUTH ROUTER LOADED - FIXED VERSION');

// REGISTER ENDPOINT
router.post('/register', asyncHandler(async (req, res) => {
    console.log('📝 REGISTER called');
    const { email, username, password, name } = req.body;

    // Validate required fields
    if (!email || !username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Email, username and password are required'
        });
    }

    if (!email.includes('@')) {
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

    try {
        // Check if email already exists
        const existingEmail = await Users.findOne({ where: { email } });
        if (existingEmail) {
            return res.status(409).json({
                success: false,
                message: 'Email already in use'
            });
        }

        // Check if username already exists
        const existingUsername = await Users.findOne({ where: { username } });
        if (existingUsername) {
            return res.status(409).json({
                success: false,
                message: 'Username already taken'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user
        const newUser = await Users.create({
            email,
            username,
            password: hashedPassword,
            ...(name && { firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' ') || null }),
            role: 'user',
            status: 'offline'
        });

        // Generate tokens
        const token = tokenService.generateAccessToken(newUser);
        const refreshToken = tokenService.generateRefreshToken(newUser);

        await tokenService.storeRefreshToken(refreshToken, newUser.id, 7 * 24 * 60 * 60 * 1000, {
            userAgent: req.headers['user-agent'] || null,
            ipAddress: req.ip || null
        });

        console.log('✅ User registered:', newUser.id, newUser.username);

        res.status(201).json({
            success:      true,
            token:        token,
            accessToken:  token,
            refreshToken: refreshToken,
            expiresIn:    24 * 60 * 60,
            expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            user: {
                id:       newUser.id,
                username: newUser.username,
                email:    newUser.email,
                avatar:   newUser.avatar || null,
                role:     newUser.role   || 'user'
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
    console.log('🔐 LOGIN called');
    const { identifier, password } = req.body;
    
    if (!identifier || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Email/username and password are required' 
        });
    }
    
    try {
        const user = await Users.findOne({
            where: {
                [require('sequelize').Op.or]: [
                    { email: identifier },
                    { username: identifier }
                ]
            }
        });
        
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
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

// GET /me - Get current user info
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        
        console.log('[AUTH] /me called for user:', userId);
        
        const user = await Users.findByPk(userId, {
            attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'role', 'status', 'lastSeen']
        });
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username;
        
        res.json({
            success: true,
            data: {
                user: {
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
                    lastActive: user.lastSeen
                }
            }
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
    console.log('🔍 VALIDATE TOKEN CALLED');
    
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
            console.log('✅ Token valid for user:', result.decoded.userId);
            
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
    console.log('🔄 Refresh token called');
    
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
    
    const user = await Users.findByPk(stored.userId);
    
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
    
    res.json({
        success: true,
        message: 'Logged out successfully'
    });
}));

// POST /forgot-password
// FIX: This route was missing — frontend calls /auth/forgot-password but it was never registered
router.post('/forgot-password', asyncHandler(async (req, res) => {
    console.log('📧 FORGOT PASSWORD called');
    const { email } = req.body;

    if (!email || !email.includes('@')) {
        return res.status(400).json({
            success: false,
            message: 'Valid email is required'
        });
    }

    try {
        const user = await Users.findOne({ where: { email: email.toLowerCase().trim() } });

        // Always return success to prevent email enumeration attacks
        if (!user) {
            return res.status(200).json({
                success: true,
                message: 'If an account exists with this email, a password reset link has been sent'
            });
        }

        const crypto = require('crypto');
        const jwt = require('jsonwebtoken');
        const JWT_SECRET_KEY = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;

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

        // In production you would send an email here.
        // For now, log it so you can test without a mail server.
        console.log(`📧 [RESET TOKEN] For ${email}: ${resetToken}`);

        // TODO: plug in your email service here, e.g.:
        // await emailService.sendResetEmail(email, resetToken);

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

// POST /reset-password
// FIX: This route was missing — frontend calls /auth/reset-password but it was never registered
router.post('/reset-password', asyncHandler(async (req, res) => {
    console.log('🔑 RESET PASSWORD called');
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
        const JWT_SECRET_KEY = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;

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
        const user = await Users.findOne({
            where: {
                id: decoded.userId,
                resetToken: resetToken,
                resetTokenExpiry: { [Op.gt]: new Date() }
            }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        // Hash the new password
        const hashedPassword = await bcrypt.hash(passwordToSet, 12);

        // Update password and clear the reset token
        await user.update({
            password: hashedPassword,
            resetToken: null,
            resetTokenExpiry: null
        });

        console.log('✅ Password reset successful for user:', user.id);

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
        
        console.log('[AUTH] /sessions called for user:', userId);
        
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

module.exports = router;