// routes/status.js - Complete Status Management Routes
// Full implementation with all features - NO SUMMARIZATION

const path = require('path');
const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { authenticateToken } = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');

// ===== SAFE MODEL IMPORT =====
let db, User, Status, StatusLike, StatusComment, StatusView;
try {
    db = require('../models');
    User = db.User || db.Users;
    Status = db.Status || db.Statuses;
    StatusLike = db.StatusLike || db.StatusLikes;
    StatusComment = db.StatusComment || db.StatusComments;
    StatusView = db.StatusView || db.StatusViews;
    console.log('[Status Route] Models loaded - User:', !!User, 'Status:', !!Status);
} catch (error) {
    console.error('[Status Route] Error loading models:', error.message);
    db = null;
}

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

console.log('✅ Status routes initialized');

// Helper function to format status data
const formatStatus = (status) => {
    if (!status) return null;
    const statusData = status.toJSON ? status.toJSON() : status;
    return {
        id: statusData.id,
        userId: statusData.userId,
        content: statusData.content,
        type: statusData.type,
        moodType: statusData.moodType,
        mediaUrl: statusData.mediaUrl,
        location: statusData.location,
        latitude: statusData.latitude,
        longitude: statusData.longitude,
        isActive: statusData.isActive,
        isPublic: statusData.isPublic,
        expiresAt: statusData.expiresAt,
        viewCount: statusData.viewCount || 0,
        likeCount: statusData.likeCount || 0,
        commentCount: statusData.commentCount || 0,
        shareCount: statusData.shareCount || 0,
        metadata: statusData.metadata,
        createdAt: statusData.createdAt,
        updatedAt: statusData.updatedAt,
        user: statusData.user ? formatUser(statusData.user) : null
    };
};

// Helper function to format user data
const formatUser = (user) => {
    if (!user) return null;
    const userData = user.toJSON ? user.toJSON() : user;
    return {
        id: userData.id,
        username: userData.username,
        avatar: userData.avatar,
        firstName: userData.firstName,
        lastName: userData.lastName,
        displayName: [userData.firstName, userData.lastName].filter(Boolean).join(' ').trim() || userData.username,
        status: userData.status,
        lastSeen: userData.lastSeen
    };
};

// Helper function to get user ID with validation
const getUserId = (req) => {
    if (!req.user) {
        console.error('[Status] req.user is undefined!');
        return null;
    }
    return req.user.userId || req.user.id;
};

// ===== SAFE MODEL CHECK MIDDLEWARE =====
const ensureModels = (req, res, next) => {
    if (!User) {
        console.error('[Status Route] User model not available');
        return res.status(503).json({
            success: false,
            message: 'Service temporarily unavailable',
            code: 'MODEL_UNAVAILABLE'
        });
    }
    next();
};

router.use(ensureModels);

// ===== PUBLIC HEALTH ENDPOINT =====
router.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        status: 'online',
        service: 'Status API',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// ===== GET ALL STATUSES (PUBLIC) =====
router.get(
    '/',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { limit = 20, offset = 0, type, moodType } = req.query;
            
            const where = {
                isActive: true,
                isPublic: true,
                [Op.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: new Date() } }
                ]
            };
            
            if (type) {
                where.type = type;
            }
            
            if (moodType) {
                where.moodType = moodType;
            }
            
            let statuses = [];
            let total = 0;
            
            if (Status) {
                try {
                    const result = await Status.findAndCountAll({
                        where,
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    statuses = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] Status table may not exist:', dbError.message);
                }
            }
            
            const formattedStatuses = statuses.map(status => formatStatus(status));
            
            res.status(200).json({
                success: true,
                data: {
                    statuses: formattedStatuses,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + statuses.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching statuses:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch statuses',
                error: error.message
            });
        }
    })
);

// ===== GET PUBLIC STATUSES =====
router.get(
    '/public',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { limit = 20, offset = 0 } = req.query;
            
            let statuses = [];
            let total = 0;
            
            if (Status) {
                try {
                    const result = await Status.findAndCountAll({
                        where: {
                            isActive: true,
                            isPublic: true,
                            [Op.or]: [
                                { expiresAt: null },
                                { expiresAt: { [Op.gt]: new Date() } }
                            ]
                        },
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    statuses = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] Public statuses error:', dbError.message);
                }
            }
            
            const formattedStatuses = statuses.map(status => formatStatus(status));
            
            res.status(200).json({
                success: true,
                data: {
                    statuses: formattedStatuses,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + statuses.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching public statuses:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch public statuses',
                error: error.message
            });
        }
    })
);

// ===== GET TRENDING STATUSES =====
router.get(
    '/trending',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { limit = 10 } = req.query;
            
            let statuses = [];
            
            if (Status) {
                try {
                    statuses = await Status.findAll({
                        where: {
                            isActive: true,
                            isPublic: true,
                            createdAt: {
                                [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                            },
                            [Op.or]: [
                                { expiresAt: null },
                                { expiresAt: { [Op.gt]: new Date() } }
                            ]
                        },
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }],
                        order: [
                            ['likeCount', 'DESC'],
                            ['viewCount', 'DESC'],
                            ['createdAt', 'DESC']
                        ],
                        limit: parseInt(limit)
                    });
                } catch (dbError) {
                    console.log('[Status Route] Trending statuses error:', dbError.message);
                }
            }
            
            const formattedStatuses = statuses.map(status => formatStatus(status));
            
            res.status(200).json({
                success: true,
                data: {
                    statuses: formattedStatuses,
                    total: formattedStatuses.length
                }
            });
        } catch (error) {
            console.error('Error fetching trending statuses:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch trending statuses',
                error: error.message
            });
        }
    })
);

// ===== SEARCH STATUSES =====
router.get(
    '/search',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { q, limit = 20, offset = 0, type, moodType } = req.query;
            
            if (!q || q.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Search query must be at least 2 characters',
                    code: 'INVALID_SEARCH_QUERY'
                });
            }
            
            const where = {
                isActive: true,
                isPublic: true,
                content: { [Op.iLike]: `%${q}%` },
                [Op.or]: [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: new Date() } }
                ]
            };
            
            if (type) {
                where.type = type;
            }
            
            if (moodType) {
                where.moodType = moodType;
            }
            
            let statuses = [];
            let total = 0;
            
            if (Status) {
                try {
                    const result = await Status.findAndCountAll({
                        where,
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    statuses = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] Search statuses error:', dbError.message);
                }
            }
            
            const formattedStatuses = statuses.map(status => formatStatus(status));
            
            res.status(200).json({
                success: true,
                data: {
                    statuses: formattedStatuses,
                    query: q,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + statuses.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error searching statuses:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to search statuses',
                error: error.message
            });
        }
    })
);

// ===== GET STATUSES BY MOOD =====
router.get(
    '/mood/:moodType',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { moodType } = req.params;
            const { limit = 20, offset = 0 } = req.query;
            
            const validMoods = ['happy', 'sad', 'angry', 'excited', 'calm', 'anxious', 'tired', 'energetic', 'focused', 'relaxed', 'nostalgic', 'romantic', 'lonely', 'confused', 'proud', 'grateful', 'hopeful', 'bored', 'sick', 'neutral'];
            
            if (!validMoods.includes(moodType)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid mood type',
                    code: 'INVALID_MOOD'
                });
            }
            
            let statuses = [];
            let total = 0;
            
            if (Status) {
                try {
                    const result = await Status.findAndCountAll({
                        where: {
                            isActive: true,
                            isPublic: true,
                            type: 'mood',
                            moodType: moodType,
                            [Op.or]: [
                                { expiresAt: null },
                                { expiresAt: { [Op.gt]: new Date() } }
                            ]
                        },
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    statuses = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] Mood statuses error:', dbError.message);
                }
            }
            
            const formattedStatuses = statuses.map(status => formatStatus(status));
            
            res.status(200).json({
                success: true,
                data: {
                    statuses: formattedStatuses,
                    moodType,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + statuses.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching mood statuses:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch mood statuses',
                error: error.message
            });
        }
    })
);

// ===== PROTECTED ROUTES - AUTHENTICATION REQUIRED =====
router.use(authenticateToken);

// ===== CREATE STATUS =====
router.post(
    '/',
    [
        body('content').optional().isLength({ max: 500 }).withMessage('Content too long'),
        body('type').optional().isIn(['text', 'image', 'video', 'audio', 'mood', 'location']).withMessage('Invalid type'),
        body('moodType').optional().isIn(['happy', 'sad', 'angry', 'excited', 'calm', 'anxious', 'tired', 'energetic', 'focused', 'relaxed', 'nostalgic', 'romantic', 'lonely', 'confused', 'proud', 'grateful', 'hopeful', 'bored', 'sick', 'neutral']).withMessage('Invalid mood'),
        body('mediaUrl').optional().isURL().withMessage('Invalid media URL'),
        body('location').optional().isString(),
        body('isPublic').optional().isBoolean()
    ],
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: errors.array()
            });
        }
        
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }
            
            const { content, type, moodType, mediaUrl, location, latitude, longitude, isPublic = true } = req.body;
            
            if (!content && type !== 'mood' && type !== 'location') {
                return res.status(400).json({
                    success: false,
                    message: 'Content is required for text status',
                    code: 'MISSING_CONTENT'
                });
            }
            
            let statusData = {
                userId,
                content: content || '',
                type: type || 'text',
                moodType: moodType || null,
                mediaUrl: mediaUrl || null,
                location: location || null,
                latitude: latitude || null,
                longitude: longitude || null,
                isPublic: isPublic,
                isActive: true,
                viewCount: 0,
                likeCount: 0,
                commentCount: 0,
                shareCount: 0,
                metadata: {}
            };
            
            // Set expiration for statuses (default 24 hours)
            const expiresInHours = 24;
            statusData.expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
            
            let newStatus = null;
            
            if (Status) {
                try {
                    newStatus = await Status.create(statusData);
                    
                    // Add user data to response
                    const user = await User.findByPk(userId, {
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                    });
                    
                    newStatus.dataValues.user = user;
                } catch (dbError) {
                    console.error('[Status Route] Create status error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to create status',
                        error: dbError.message
                    });
                }
            } else {
                // Fallback response when model not available
                newStatus = {
                    id: Date.now(),
                    ...statusData,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    user: { id: userId }
                };
            }
            
            res.status(201).json({
                success: true,
                data: {
                    status: formatStatus(newStatus)
                },
                message: 'Status created successfully'
            });
        } catch (error) {
            console.error('Error creating status:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to create status',
                error: error.message
            });
        }
    })
);

// ===== GET MY STATUSES =====
router.get(
    '/my',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }
            
            const { limit = 50, offset = 0, includeInactive = false } = req.query;
            
            const where = { userId };
            
            if (!includeInactive) {
                where.isActive = true;
                where[Op.or] = [
                    { expiresAt: null },
                    { expiresAt: { [Op.gt]: new Date() } }
                ];
            }
            
            let statuses = [];
            let total = 0;
            
            if (Status) {
                try {
                    const result = await Status.findAndCountAll({
                        where,
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    statuses = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] My statuses error:', dbError.message);
                }
            }
            
            const formattedStatuses = statuses.map(status => formatStatus(status));
            
            res.status(200).json({
                success: true,
                data: {
                    statuses: formattedStatuses,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + statuses.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching my statuses:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch your statuses',
                error: error.message
            });
        }
    })
);

// ===== GET STATUS BY ID =====
router.get(
    '/:statusId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let status = null;
            
            if (Status) {
                try {
                    status = await Status.findOne({
                        where: { id: statusId },
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }]
                    });
                } catch (dbError) {
                    console.log('[Status Route] Get status by ID error:', dbError.message);
                }
            }
            
            if (!status) {
                return res.status(404).json({
                    success: false,
                    message: 'Status not found'
                });
            }
            
            // Check if user has permission to view
            const isOwner = status.userId === userId;
            const isPublic = status.isPublic === true;
            const isExpired = status.expiresAt && new Date(status.expiresAt) < new Date();
            
            if (!isOwner && !isPublic) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have permission to view this status',
                    code: 'PERMISSION_DENIED'
                });
            }
            
            if (isExpired) {
                return res.status(410).json({
                    success: false,
                    message: 'This status has expired',
                    code: 'STATUS_EXPIRED'
                });
            }
            
            // Increment view count if not the owner
            if (!isOwner && Status && !isExpired) {
                try {
                    await Status.update(
                        { viewCount: (status.viewCount || 0) + 1 },
                        { where: { id: statusId } }
                    );
                    status.viewCount = (status.viewCount || 0) + 1;
                } catch (dbError) {
                    console.log('[Status Route] Increment view error:', dbError.message);
                }
                
                // Record view
                if (StatusView) {
                    try {
                        await StatusView.create({
                            statusId: parseInt(statusId),
                            userId,
                            viewedAt: new Date()
                        });
                    } catch (dbError) {
                        console.log('[Status Route] Record view error:', dbError.message);
                    }
                }
            }
            
            res.status(200).json({
                success: true,
                data: {
                    status: formatStatus(status)
                }
            });
        } catch (error) {
            console.error('Error fetching status:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch status',
                error: error.message
            });
        }
    })
);

// ===== UPDATE STATUS =====
router.put(
    '/:statusId',
    [
        body('content').optional().isLength({ max: 500 }).withMessage('Content too long'),
        body('isPublic').optional().isBoolean()
    ],
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: errors.array()
            });
        }
        
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            const { content, isPublic } = req.body;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let status = null;
            
            if (Status) {
                try {
                    status = await Status.findOne({
                        where: { id: statusId, userId }
                    });
                } catch (dbError) {
                    console.log('[Status Route] Find status for update error:', dbError.message);
                }
            }
            
            if (!status) {
                return res.status(404).json({
                    success: false,
                    message: 'Status not found or you do not have permission to edit it'
                });
            }
            
            const updates = {};
            if (content !== undefined) updates.content = content;
            if (isPublic !== undefined) updates.isPublic = isPublic;
            updates.updatedAt = new Date();
            
            if (Object.keys(updates).length > 0 && Status) {
                try {
                    await status.update(updates);
                } catch (dbError) {
                    console.error('[Status Route] Update status error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to update status',
                        error: dbError.message
                    });
                }
            }
            
            // Refresh status data
            if (Status) {
                try {
                    status = await Status.findOne({
                        where: { id: statusId },
                        include: [{
                            model: User,
                            as: 'statusUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
                        }]
                    });
                } catch (dbError) {
                    console.log('[Status Route] Refresh status error:', dbError.message);
                }
            }
            
            res.status(200).json({
                success: true,
                data: {
                    status: formatStatus(status)
                },
                message: 'Status updated successfully'
            });
        } catch (error) {
            console.error('Error updating status:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to update status',
                error: error.message
            });
        }
    })
);

// ===== DELETE STATUS =====
router.delete(
    '/:statusId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let deleted = false;
            
            if (Status) {
                try {
                    const result = await Status.destroy({
                        where: { id: statusId, userId }
                    });
                    deleted = result > 0;
                } catch (dbError) {
                    console.error('[Status Route] Delete status error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to delete status',
                        error: dbError.message
                    });
                }
            }
            
            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    message: 'Status not found or you do not have permission to delete it'
                });
            }
            
            res.status(200).json({
                success: true,
                message: 'Status deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting status:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to delete status',
                error: error.message
            });
        }
    })
);

// ===== LIKE STATUS =====
router.post(
    '/:statusId/like',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let status = null;
            let alreadyLiked = false;
            
            if (Status) {
                try {
                    status = await Status.findByPk(statusId);
                    
                    if (!status) {
                        return res.status(404).json({
                            success: false,
                            message: 'Status not found'
                        });
                    }
                    
                    // Check if already liked
                    if (StatusLike) {
                        const existingLike = await StatusLike.findOne({
                            where: { statusId, userId }
                        });
                        alreadyLiked = !!existingLike;
                    }
                    
                    if (!alreadyLiked) {
                        await Status.update(
                            { likeCount: (status.likeCount || 0) + 1 },
                            { where: { id: statusId } }
                        );
                        status.likeCount = (status.likeCount || 0) + 1;
                        
                        // Record like
                        if (StatusLike) {
                            await StatusLike.create({
                                statusId: parseInt(statusId),
                                userId,
                                createdAt: new Date()
                            });
                        }
                    }
                } catch (dbError) {
                    console.error('[Status Route] Like status error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to like status',
                        error: dbError.message
                    });
                }
            }
            
            res.status(200).json({
                success: true,
                data: {
                    liked: !alreadyLiked,
                    likeCount: status ? status.likeCount : 0
                },
                message: alreadyLiked ? 'Status already liked' : 'Status liked successfully'
            });
        } catch (error) {
            console.error('Error liking status:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to like status',
                error: error.message
            });
        }
    })
);

// ===== UNLIKE STATUS =====
router.delete(
    '/:statusId/like',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let status = null;
            let wasLiked = false;
            
            if (Status) {
                try {
                    status = await Status.findByPk(statusId);
                    
                    if (!status) {
                        return res.status(404).json({
                            success: false,
                            message: 'Status not found'
                        });
                    }
                    
                    if (StatusLike) {
                        const existingLike = await StatusLike.findOne({
                            where: { statusId, userId }
                        });
                        wasLiked = !!existingLike;
                        
                        if (wasLiked) {
                            await existingLike.destroy();
                            await Status.update(
                                { likeCount: Math.max(0, (status.likeCount || 0) - 1) },
                                { where: { id: statusId } }
                            );
                            status.likeCount = Math.max(0, (status.likeCount || 0) - 1);
                        }
                    }
                } catch (dbError) {
                    console.error('[Status Route] Unlike status error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to unlike status',
                        error: dbError.message
                    });
                }
            }
            
            res.status(200).json({
                success: true,
                data: {
                    liked: false,
                    likeCount: status ? status.likeCount : 0
                },
                message: wasLiked ? 'Status unliked successfully' : 'Status was not liked'
            });
        } catch (error) {
            console.error('Error unliking status:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to unlike status',
                error: error.message
            });
        }
    })
);

// ===== VIEW STATUS =====
router.post(
    '/:statusId/view',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let status = null;
            let alreadyViewed = false;
            
            if (Status) {
                try {
                    status = await Status.findByPk(statusId);
                    
                    if (!status) {
                        return res.status(404).json({
                            success: false,
                            message: 'Status not found'
                        });
                    }
                    
                    if (StatusView) {
                        const existingView = await StatusView.findOne({
                            where: { statusId, userId }
                        });
                        alreadyViewed = !!existingView;
                        
                        if (!alreadyViewed) {
                            await Status.update(
                                { viewCount: (status.viewCount || 0) + 1 },
                                { where: { id: statusId } }
                            );
                            status.viewCount = (status.viewCount || 0) + 1;
                            
                            await StatusView.create({
                                statusId: parseInt(statusId),
                                userId,
                                viewedAt: new Date()
                            });
                        }
                    }
                } catch (dbError) {
                    console.error('[Status Route] View status error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to record view',
                        error: dbError.message
                    });
                }
            }
            
            res.status(200).json({
                success: true,
                data: {
                    viewed: !alreadyViewed,
                    viewCount: status ? status.viewCount : 0
                },
                message: alreadyViewed ? 'View already recorded' : 'View recorded successfully'
            });
        } catch (error) {
            console.error('Error recording status view:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to record view',
                error: error.message
            });
        }
    })
);

// ===== ADD COMMENT =====
router.post(
    '/:statusId/comment',
    [
        body('content').notEmpty().withMessage('Comment content is required').isLength({ max: 500 }).withMessage('Comment too long')
    ],
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: errors.array()
            });
        }
        
        try {
            const userId = getUserId(req);
            const { statusId } = req.params;
            const { content } = req.body;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let status = null;
            let comment = null;
            
            if (Status) {
                try {
                    status = await Status.findByPk(statusId);
                    
                    if (!status) {
                        return res.status(404).json({
                            success: false,
                            message: 'Status not found'
                        });
                    }
                    
                    await Status.update(
                        { commentCount: (status.commentCount || 0) + 1 },
                        { where: { id: statusId } }
                    );
                    
                    if (StatusComment) {
                        comment = await StatusComment.create({
                            statusId: parseInt(statusId),
                            userId,
                            content,
                            createdAt: new Date()
                        });
                    } else {
                        comment = {
                            id: Date.now(),
                            statusId: parseInt(statusId),
                            userId,
                            content,
                            createdAt: new Date().toISOString()
                        };
                    }
                } catch (dbError) {
                    console.error('[Status Route] Add comment error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to add comment',
                        error: dbError.message
                    });
                }
            }
            
            // Get user info for comment
            let user = null;
            if (User) {
                try {
                    user = await User.findByPk(userId, {
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    });
                } catch (dbError) {
                    console.log('[Status Route] Get user for comment error:', dbError.message);
                }
            }
            
            res.status(201).json({
                success: true,
                data: {
                    comment: {
                        id: comment.id,
                        statusId: parseInt(statusId),
                        userId,
                        content,
                        createdAt: comment.createdAt,
                        user: user ? formatUser(user) : null
                    }
                },
                message: 'Comment added successfully'
            });
        } catch (error) {
            console.error('Error adding comment:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to add comment',
                error: error.message
            });
        }
    })
);

// ===== DELETE COMMENT =====
router.delete(
    '/:statusId/comment/:commentId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            const { statusId, commentId } = req.params;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            if (!commentId || isNaN(parseInt(commentId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid comment ID',
                    code: 'INVALID_COMMENT_ID'
                });
            }
            
            let deleted = false;
            
            if (Status && StatusComment) {
                try {
                    // Check if user owns the comment
                    const comment = await StatusComment.findOne({
                        where: { id: commentId, statusId }
                    });
                    
                    if (!comment) {
                        return res.status(404).json({
                            success: false,
                            message: 'Comment not found'
                        });
                    }
                    
                    if (comment.userId !== userId) {
                        return res.status(403).json({
                            success: false,
                            message: 'You do not have permission to delete this comment',
                            code: 'PERMISSION_DENIED'
                        });
                    }
                    
                    await comment.destroy();
                    deleted = true;
                    
                    // Decrement comment count
                    const status = await Status.findByPk(statusId);
                    if (status) {
                        await Status.update(
                            { commentCount: Math.max(0, (status.commentCount || 0) - 1) },
                            { where: { id: statusId } }
                        );
                    }
                } catch (dbError) {
                    console.error('[Status Route] Delete comment error:', dbError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to delete comment',
                        error: dbError.message
                    });
                }
            }
            
            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    message: 'Comment not found'
                });
            }
            
            res.status(200).json({
                success: true,
                message: 'Comment deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting comment:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to delete comment',
                error: error.message
            });
        }
    })
);

// ===== GET STATUS COMMENTS =====
router.get(
    '/:statusId/comments',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { statusId } = req.params;
            const { limit = 20, offset = 0 } = req.query;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let comments = [];
            let total = 0;
            
            if (StatusComment) {
                try {
                    const result = await StatusComment.findAndCountAll({
                        where: { statusId },
                        include: [{
                            model: User,
                            as: 'commentUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    comments = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] Get comments error:', dbError.message);
                }
            }
            
            const formattedComments = comments.map(comment => ({
                id: comment.id,
                statusId: comment.statusId,
                userId: comment.userId,
                content: comment.content,
                createdAt: comment.createdAt,
                user: comment.commentUser ? formatUser(comment.commentUser) : null
            }));
            
            res.status(200).json({
                success: true,
                data: {
                    comments: formattedComments,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + comments.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching comments:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch comments',
                error: error.message
            });
        }
    })
);

// ===== GET STATUS LIKES =====
router.get(
    '/:statusId/likes',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const { statusId } = req.params;
            const { limit = 20, offset = 0 } = req.query;
            
            if (!statusId || isNaN(parseInt(statusId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status ID',
                    code: 'INVALID_STATUS_ID'
                });
            }
            
            let likes = [];
            let total = 0;
            
            if (StatusLike) {
                try {
                    const result = await StatusLike.findAndCountAll({
                        where: { statusId },
                        include: [{
                            model: User,
                            as: 'likeUser',
                            attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                        }],
                        order: [['createdAt', 'DESC']],
                        limit: parseInt(limit),
                        offset: parseInt(offset)
                    });
                    
                    likes = result.rows;
                    total = result.count;
                } catch (dbError) {
                    console.log('[Status Route] Get likes error:', dbError.message);
                }
            }
            
            const formattedLikes = likes.map(like => ({
                id: like.id,
                statusId: like.statusId,
                userId: like.userId,
                createdAt: like.createdAt,
                user: like.likeUser ? formatUser(like.likeUser) : null
            }));
            
            res.status(200).json({
                success: true,
                data: {
                    likes: formattedLikes,
                    pagination: {
                        limit: parseInt(limit),
                        offset: parseInt(offset),
                        total,
                        hasMore: offset + likes.length < total
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching likes:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch likes',
                error: error.message
            });
        }
    })
);

// ===== GET STATUS STATISTICS =====
router.get(
    '/stats',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication required'
                });
            }
            
            const { period = '7d' } = req.query;
            
            let startDate = new Date();
            switch (period) {
                case '1d':
                    startDate.setDate(startDate.getDate() - 1);
                    break;
                case '7d':
                    startDate.setDate(startDate.getDate() - 7);
                    break;
                case '30d':
                    startDate.setDate(startDate.getDate() - 30);
                    break;
                case '90d':
                    startDate.setDate(startDate.getDate() - 90);
                    break;
                default:
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid period. Use: 1d, 7d, 30d, 90d',
                        code: 'INVALID_PERIOD'
                    });
            }
            
            let totalStatuses = 0;
            let activeStatuses = 0;
            let totalLikes = 0;
            let totalViews = 0;
            let totalComments = 0;
            let statusesByType = {};
            let statusesByMood = {};
            
            if (Status) {
                try {
                    // Total statuses
                    totalStatuses = await Status.count({
                        where: { userId, createdAt: { [Op.gte]: startDate } }
                    });
                    
                    // Active statuses
                    activeStatuses = await Status.count({
                        where: {
                            userId,
                            isActive: true,
                            [Op.or]: [
                                { expiresAt: null },
                                { expiresAt: { [Op.gt]: new Date() } }
                            ]
                        }
                    });
                    
                    // Aggregated stats
                    const stats = await Status.findAll({
                        where: { userId, createdAt: { [Op.gte]: startDate } },
                        attributes: [
                            [Sequelize.fn('SUM', Sequelize.col('likeCount')), 'totalLikes'],
                            [Sequelize.fn('SUM', Sequelize.col('viewCount')), 'totalViews'],
                            [Sequelize.fn('SUM', Sequelize.col('commentCount')), 'totalComments'],
                            'type',
                            'moodType'
                        ],
                        group: ['type', 'moodType']
                    });
                    
                    stats.forEach(stat => {
                        totalLikes += parseInt(stat.dataValues.totalLikes) || 0;
                        totalViews += parseInt(stat.dataValues.totalViews) || 0;
                        totalComments += parseInt(stat.dataValues.totalComments) || 0;
                        
                        if (stat.type) {
                            statusesByType[stat.type] = (statusesByType[stat.type] || 0) + 1;
                        }
                        if (stat.moodType) {
                            statusesByMood[stat.moodType] = (statusesByMood[stat.moodType] || 0) + 1;
                        }
                    });
                } catch (dbError) {
                    console.log('[Status Route] Stats error:', dbError.message);
                }
            }
            
            res.status(200).json({
                success: true,
                data: {
                    period,
                    totalStatuses,
                    activeStatuses,
                    totalLikes,
                    totalViews,
                    totalComments,
                    statusesByType,
                    statusesByMood,
                    engagementRate: totalStatuses > 0 ? ((totalLikes + totalComments) / totalStatuses).toFixed(2) : 0
                }
            });
        } catch (error) {
            console.error('Error fetching status statistics:', error.message);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch statistics',
                error: error.message
            });
        }
    })
);

module.exports = router;