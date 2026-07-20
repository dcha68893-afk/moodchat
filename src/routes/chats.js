const path = require('path');
const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const db = require('../models');

// ── CRITICAL: Inject global.__socketIO into req.io so all handlers can emit ──
router.use((req, _, next) => { if (!req.io) req.io = global.__socketIO || null; next(); });

// These will now work correctly with the new getters
const User = db.User;
// Reuse the lastSeen privacy enforcement built in users.js instead of
// duplicating it — see that file for _applyLastSeenPrivacy.
const applyLastSeenPrivacy = require('./users').applyLastSeenPrivacy;
const Chat = db.Chat;
const Message = db.Message;
const ChatParticipant = db.ChatParticipant;

// Add validation
if (!Chat || !User || !Message || !ChatParticipant) {
    console.error('[Chats] Missing models:', {
        Chat: !!Chat,
        User: !!User,
        Message: !!Message,
        ChatParticipant: !!ChatParticipant
    });
}
// Import middleware
const { apiRateLimiter } = require('../middleware/rateLimiter');
// ✅ FIX 12: Use webSocketService for live socket delivery (it maintains the in-memory onlineUsers map).
// chats.js previously relied on User.socketIds from DB which is never updated by webSocketService.
let _wsService = null;
function getWsService() {
    if (!_wsService) {
        try { _wsService = require('../services/webSocketService'); } catch (_) {}
    }
    return _wsService;
}

// ✅ FIX 12: Universal emit helper — tries wsService rooms first, then socketId loop fallback.
async function emitToUser(io, userId, event, payload) {
    const ws = getWsService();
    if (ws && typeof ws.sendToUser === 'function') {
        const delivered = await ws.sendToUser(userId, event, payload);
        if (delivered) return;
    }
    // Fallback: io rooms (works if socket joined user room via webSocketService.registerUser)
    if (io) {
        io.to(`user:${userId}`).emit(event, payload);
        io.to(`user_${userId}`).emit(event, payload);
    }
}

console.log('✅ Chats routes initialized (v2.0.0 - Complete CRUD)');

// Helper function to get user ID with validation
const getUserId = (req) => {
    if (!req.user) {
        console.error('[Chats] req.user is undefined!');
        return null;
    }
    return req.user.userId || req.user.id;
};

// Helper function to check models
const checkModels = (res) => {
    if (!Chat || !User || !Message || !ChatParticipant) {
        console.error('[Chats] Required models not loaded');
        res.status(500).json({
            status: 'error',
            message: 'Chat service temporarily unavailable'
        });
        return false;
    }
    return true;
};

// Helper function to get participant user IDs for a chat
const getChatParticipantIds = async (chatId) => {
    const participants = await ChatParticipant.findAll({
        where: { chatId: chatId },
        attributes: ['userId']
    });
    return participants.map(p => p.userId);
};

// Helper function to broadcast to chat participants
const broadcastToChat = async (req, chatId, event, data) => {
    if (!req.io) return;
    
    try {
        const participantIds = await getChatParticipantIds(chatId);
        // ✅ FIX 12d: Use for...of (not forEach) so await works correctly
        await Promise.allSettled(
            participantIds.map(uid => emitToUser(req.io, uid, event, data))
        );
    } catch (error) {
        console.error(`[Chats] Error broadcasting ${event}:`, error.message);
    }
};

// ============================================================================
// GET ALL CHATS FOR CURRENT USER
// ============================================================================
router.get(
    '/',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            console.log('[Chats] Fetching chats for user:', userId);

            const { page = 1, limit = 50, includeArchived = false } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);
            
            const whereCondition = includeArchived === 'true' ? {} : { isArchived: false };
            
            const { count, rows: chats } = await Chat.findAndCountAll({
                where: whereCondition,
                include: [
                    {
                        model: ChatParticipant,
                        as: 'chatParticipants',
                        where: { userId: userId },
                        required: true,
                        attributes: ['userId', 'joinedAt']
                    },
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    },
                    {
                        model: Message,
                        as: 'chatMessages',
                        required: false,
                        limit: 1,
                        order: [['createdAt', 'DESC']],
                        attributes: ['id', 'content', 'type', 'createdAt', 'senderId']
                    }
                ],
                order: [['updatedAt', 'DESC']],
                offset,
                limit: parseInt(limit),
                distinct: true,
                subQuery: false
            });
            
            // Format chats for response
            const formattedChats = await Promise.all((chats || []).map(async (chat) => {
                const chatObj = chat.toJSON ? chat.toJSON() : chat;
                
                // FIXED: Use correct alias 'chatParticipantUser' instead of 'user'
                const participants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    include: [{
                        model: User,
                        as: 'chatParticipantUser',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'email', 'settings']
                    }]
                });

                // FIX: lastSeen privacy was never checked here — enforce it
                // before it reaches otherParticipant below.
                const participantUsers = participants.map(p => p.chatParticipantUser).filter(Boolean);
                if (participantUsers.length > 0) {
                    await applyLastSeenPrivacy(participantUsers, userId);
                }

                // FIXED: Use the correct alias 'chatParticipantUser'
                chatObj.participants = participantUsers.map(p => {
                    const j = p.toJSON ? p.toJSON() : p;
                    delete j.settings;
                    return j;
                });
                
                // Calculate unread count for this user
                const unreadCount = await Message.count({
                    where: {
                        chatId: chat.id,
                        isRead: false,
                        senderId: { [Op.ne]: userId }
                    }
                });
                chatObj.unreadCount = unreadCount || 0;
                
                // For direct chats, get the other participant
                if (chatObj.type === 'direct') {
                    const otherParticipant = chatObj.participants?.find(p => p && p.id !== userId);
                    if (otherParticipant) {
                        const displayName = [otherParticipant.firstName, otherParticipant.lastName].filter(Boolean).join(' ').trim() || otherParticipant.username;
                        chatObj.otherParticipant = {
                            id: otherParticipant.id,
                            username: otherParticipant.username,
                            avatar: otherParticipant.avatar,
                            displayName: displayName,
                            status: otherParticipant.status || 'offline',
                            lastSeen: otherParticipant.lastSeen
                        };
                        chatObj.chatName = displayName;
                        chatObj.avatar = otherParticipant.avatar;
                        // FIX: Add friendId/friendName/friendAvatar so messages-core can match
                        // existing conversations without scanning participants array
                        chatObj.friendId     = otherParticipant.id;
                        chatObj.friendName   = displayName;
                        chatObj.friendAvatar = otherParticipant.avatar || null;
                    }
                } else if (chatObj.type === 'group') {
                    chatObj.chatName = chatObj.name;
                    chatObj.participantCount = chatObj.participants?.length || 0;
                }
                
                return chatObj;
            }));
            
            res.status(200).json({
                status: 'success',
                data: {
                    chats: formattedChats,
                    pagination: {
                        total: count,
                        page: parseInt(page),
                        limit: parseInt(limit),
                        pages: Math.ceil(count / parseInt(limit))
                    }
                }
            });
        } catch (error) {
            console.error('[Chats] Error fetching chats:', error.message);
            console.error('[Chats] Stack:', error.stack);
            res.status(500).json({
                status: 'error',
                message: 'Failed to fetch chats',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    })
);

// ============================================================================
// GET SINGLE CHAT BY ID
// ============================================================================
router.get(
    '/:chatId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            // Check if user is participant
            const isParticipant = await ChatParticipant.findOne({
                where: {
                    chatId: chatId,
                    userId: userId
                }
            });
            
            if (!isParticipant) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Access denied to this chat'
                });
            }
            
            const chat = await Chat.findByPk(chatId, {
                include: [
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    }
                ]
            });
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            const chatObj = chat.toJSON ? chat.toJSON() : chat;
            
            // FIXED: Use correct alias 'chatParticipantUser'
            const participants = await ChatParticipant.findAll({
                where: { chatId: chat.id },
                include: [{
                    model: User,
                    as: 'chatParticipantUser',
                    attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'email', 'settings']
                }]
            });

            // FIX: enforce lastSeen privacy before it reaches otherParticipant below.
            const participantUsers2 = participants.map(p => p.chatParticipantUser).filter(Boolean);
            if (participantUsers2.length > 0) {
                await applyLastSeenPrivacy(participantUsers2, userId);
            }

            // FIXED: Use the correct alias 'chatParticipantUser'
            chatObj.participants = participantUsers2.map(p => {
                const j = p.toJSON ? p.toJSON() : p;
                delete j.settings;
                return j;
            });
            
            // Calculate unread count
            const unreadCount = await Message.count({
                where: {
                    chatId: chat.id,
                    isRead: false,
                    senderId: { [Op.ne]: userId }
                }
            });
            chatObj.unreadCount = unreadCount || 0;
            
            // For direct chats, get the other participant
            if (chatObj.type === 'direct') {
                const otherParticipant = chatObj.participants?.find(p => p && p.id !== userId);
                if (otherParticipant) {
                    const displayName = [otherParticipant.firstName, otherParticipant.lastName].filter(Boolean).join(' ').trim() || otherParticipant.username;
                    chatObj.otherParticipant = {
                        id: otherParticipant.id,
                        username: otherParticipant.username,
                        avatar: otherParticipant.avatar,
                        displayName: displayName,
                        status: otherParticipant.status || 'offline',
                        lastSeen: otherParticipant.lastSeen,
                        email: otherParticipant.email
                    };
                    chatObj.chatName    = displayName;
                    chatObj.avatar      = otherParticipant.avatar;
                    // FIX: expose top-level friendId/friendName/friendAvatar
                    chatObj.friendId     = otherParticipant.id;
                    chatObj.friendName   = displayName;
                    chatObj.friendAvatar = otherParticipant.avatar || null;
                }
            } else if (chatObj.type === 'group') {
                chatObj.chatName = chatObj.name;
                chatObj.participantCount = chatObj.participants?.length || 0;
                chatObj.isCreator = chatObj.createdBy === userId;
            }
            
            res.status(200).json({
                status: 'success',
                data: { chat: chatObj }
            });
        } catch (error) {
            console.error('[Chats] Error fetching chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to fetch chat'
            });
        }
    })
);

// ============================================================================
// START DIRECT MESSAGE CHAT (FIND-OR-CREATE) - NO DUPLICATES
// ============================================================================
router.post(
    '/start',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { userId: otherUserId } = req.body;
            
            if (!otherUserId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'User ID is required'
                });
            }
            
            if (otherUserId === userId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Cannot start a chat with yourself'
                });
            }
            
            // Verify other user exists
            const otherUser = await User.findByPk(otherUserId, {
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen', 'socketIds', 'settings']
            });
            
            if (!otherUser) {
                return res.status(404).json({
                    status: 'error',
                    message: 'User not found'
                });
            }

            // FIX: enforce lastSeen privacy — otherUser.lastSeen is read below
            // in two places without ever checking this user's privacy setting.
            await applyLastSeenPrivacy(otherUser, userId);
            
            // Check if direct chat already exists
            const existingParticipant1 = await ChatParticipant.findAll({
                where: { userId: userId },
                attributes: ['chatId']
            });
            
            const existingParticipant2 = await ChatParticipant.findAll({
                where: { userId: otherUserId },
                attributes: ['chatId']
            });
            
            const userChatIds = new Set(existingParticipant1.map(p => p.chatId));
            const otherChatIds = new Set(existingParticipant2.map(p => p.chatId));
            
            // Find common chat IDs
            const commonChatIds = [...userChatIds].filter(id => otherChatIds.has(id));
            
            if (commonChatIds.length > 0) {
                // Check if any common chat is a direct chat
                for (const chatId of commonChatIds) {
                    const chat = await Chat.findByPk(chatId);
                    if (chat && chat.type === 'direct' && chat.isActive === true) {
                        const displayName = [otherUser.firstName, otherUser.lastName].filter(Boolean).join(' ').trim() || otherUser.username;
                        
                        return res.status(200).json({
                            status: 'success',
                            success: true,
                            message: 'Existing direct chat found',
                            data: {
                                chat: {
                                    id: chat.id,
                                    chatId: chat.id,
                                    type: 'direct',
                                    otherParticipant: {
                                        id: otherUser.id,
                                        username: otherUser.username,
                                        avatar: otherUser.avatar,
                                        displayName: displayName,
                                        status: otherUser.status || 'offline',
                                        lastSeen: otherUser.lastSeen
                                    },
                                    chatName:    displayName,
                                    // FIX: top-level fields for messages-core conversation matching
                                    friendId:     otherUser.id,
                                    friendName:   displayName,
                                    friendAvatar: otherUser.avatar || null,
                                    avatar:       otherUser.avatar,
                                    createdAt:    chat.createdAt,
                                    updatedAt:    chat.updatedAt,
                                    unreadCount: 0
                                }
                            }
                        });
                    }
                }
            }
            
            // No existing direct chat found - create new one
            const newChat = await Chat.create({
                type: 'direct',
                createdBy: userId,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date()
            });
            
            // Add participants
            await ChatParticipant.bulkCreate([
                {
                    chatId: newChat.id,
                    userId: userId,
                    joinedAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date()
                },
                {
                    chatId: newChat.id,
                    userId: otherUserId,
                    joinedAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            ]);
            
            const displayName = [otherUser.firstName, otherUser.lastName].filter(Boolean).join(' ').trim() || otherUser.username;
            
            // Broadcast to both users
            if (req.io) {
                const chatData = {
                    id: newChat.id,
                    type: 'direct',
                    otherParticipant: {
                        id: otherUser.id,
                        username: otherUser.username,
                        avatar: otherUser.avatar,
                        displayName: displayName,
                        status: otherUser.status || 'offline'
                    },
                    chatName: displayName,
                    createdAt: newChat.createdAt,
                    updatedAt: newChat.updatedAt
                };
                
                // ✅ FIX 12b: Use emitToUser (wsService rooms) instead of stale DB socketIds
                await emitToUser(req.io, userId, 'chat:created', chatData);
                console.log(`[Chats] 📡 FIX12 chat:created emitted to creator uid=${userId}`);

                const otherUserChatData = {
                    ...chatData,
                    otherParticipant: {
                        id: userId,
                        username: req.user?.username || 'User',
                        avatar: req.user?.avatar || null,
                        displayName: req.user?.username || 'User'
                    }
                };
                await emitToUser(req.io, otherUserId, 'chat:created', otherUserChatData);
                console.log(`[Chats] 📡 FIX12 chat:created emitted to receiver uid=${otherUserId}`);
            }
            
            res.status(201).json({
                status: 'success',
                success: true,
                message: 'Direct chat created successfully',
                data: {
                    chat: {
                        id: newChat.id,
                        chatId: newChat.id,
                        type: 'direct',
                        otherParticipant: {
                            id: otherUser.id,
                            username: otherUser.username,
                            avatar: otherUser.avatar,
                            displayName: displayName,
                            status: otherUser.status || 'offline',
                            lastSeen: otherUser.lastSeen
                        },
                        chatName:    displayName,
                        // FIX: top-level fields for messages-core conversation matching
                        friendId:     otherUser.id,
                        friendName:   displayName,
                        friendAvatar: otherUser.avatar || null,
                        avatar:       otherUser.avatar,
                        createdAt: newChat.createdAt,
                        updatedAt: newChat.updatedAt,
                        unreadCount: 0
                    }
                }
            });
        } catch (error) {
            console.error('[Chats] Error starting direct chat:', error.message);
            console.error('[Chats] Stack:', error.stack);
            res.status(500).json({
                status: 'error',
                message: 'Failed to start direct chat',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    })
);

// ============================================================================
// CREATE GROUP CHAT
// ============================================================================
router.post(
    '/',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { name, participantIds, description, avatar } = req.body;
            
            if (!name || !name.trim()) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Group name is required'
                });
            }
            
            if (name.length > 100) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Group name must be less than 100 characters'
                });
            }
            
            if (!Array.isArray(participantIds) || participantIds.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    message: 'At least one participant is required'
                });
            }
            
            // Ensure unique participants and include creator
            const allParticipants = [...new Set([userId, ...participantIds])];
            
            // Verify all participants exist
            const participants = await User.findAll({
                where: { id: allParticipants },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'socketIds']
            });
            
            if (participants.length !== allParticipants.length) {
                const foundIds = participants.map(p => p.id);
                const missingIds = allParticipants.filter(id => !foundIds.includes(id));
                return res.status(404).json({
                    status: 'error',
                    message: `Users not found: ${missingIds.join(', ')}`
                });
            }
            
            const currentUser = participants.find(p => p.id === userId);
            
            // Create group chat
            const chat = await Chat.create({
                type: 'group',
                name: name.trim(),
                description: description?.trim() || null,
                avatar: avatar || null,
                createdBy: userId,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date()
            });
            
            if (!chat) {
                return res.status(500).json({
                    status: 'error',
                    message: 'Failed to create group chat'
                });
            }
            
            // Add participants
            const participantRecords = allParticipants.map(participantId => ({
                chatId: chat.id,
                userId: participantId,
                joinedAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date()
            }));
            
            await ChatParticipant.bulkCreate(participantRecords);
            
            // Fetch created chat with details
            const createdChat = await Chat.findByPk(chat.id, {
                include: [
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    }
                ]
            });
            
            const chatObj = createdChat.toJSON ? createdChat.toJSON() : createdChat;
            
            // Add participants to response
            chatObj.participants = participants.map(p => ({
                id: p.id,
                username: p.username,
                avatar: p.avatar,
                firstName: p.firstName,
                lastName: p.lastName
            }));
            chatObj.participantCount = participants.length;
            chatObj.isCreator = true;
            
            // Broadcast to all participants
            if (req.io) {
                const notificationData = {
                    chat: chatObj,
                    addedBy: {
                        id: userId,
                        username: currentUser?.username || req.user?.username,
                        avatar: currentUser?.avatar || req.user?.avatar
                    }
                };
                
                // ✅ FIX 12c: emit group:created to all participants via live wsService rooms
                await Promise.allSettled(
                    participants.map(participant =>
                        emitToUser(req.io, participant.id, 'group:created', notificationData)
                            .then(() => console.log(`[Chats] 📡 FIX12 group:created → uid=${participant.id}`))
                    )
                );
            }
            
            res.status(201).json({
                status: 'success',
                message: 'Group chat created successfully',
                data: { chat: chatObj }
            });
        } catch (error) {
            console.error('[Chats] Error creating group chat:', error.message);
            console.error('[Chats] Stack:', error.stack);
            res.status(500).json({
                status: 'error',
                message: 'Failed to create group chat',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    })
);

// ============================================================================
// UPDATE CHAT (GROUP ONLY - NAME, DESCRIPTION, AVATAR)
// ============================================================================
router.patch(
    '/:chatId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            const { name, description, avatar } = req.body;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            // Only group chats can be updated
            if (chat.type !== 'group') {
                return res.status(400).json({
                    status: 'error',
                    message: 'Only group chats can be updated'
                });
            }
            
            // Check if user is creator
            if (chat.createdBy !== userId) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Only group creator can update chat settings'
                });
            }
            
            const updates = {};
            if (name && name.trim()) updates.name = name.trim();
            if (description !== undefined) updates.description = description?.trim() || null;
            if (avatar !== undefined) updates.avatar = avatar;
            updates.updatedAt = new Date();
            
            await chat.update(updates);
            
            const updatedChat = await Chat.findByPk(chatId, {
                include: [
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    }
                ]
            });
            
            // Broadcast updates to all participants
            if (req.io) {
                await broadcastToChat(req, chatId, 'group:updated', {
                    chatId: chat.id,
                    updates: updates,
                    updatedBy: {
                        id: userId,
                        username: req.user?.username
                    },
                    timestamp: new Date().toISOString()
                });
            }
            
            res.status(200).json({
                status: 'success',
                message: 'Chat updated successfully',
                data: { chat: updatedChat }
            });
        } catch (error) {
            console.error('[Chats] Error updating chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update chat'
            });
        }
    })
);

// ============================================================================
// ADD PARTICIPANTS TO GROUP CHAT
// ============================================================================
router.post(
    '/:chatId/participants',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            const { participantIds } = req.body;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            if (!Array.isArray(participantIds) || participantIds.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Participant IDs are required'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            // Only group chats can have participants added
            if (chat.type !== 'group') {
                return res.status(400).json({
                    status: 'error',
                    message: 'Only group chats support adding participants'
                });
            }
            
            // Check if user is creator
            if (chat.createdBy !== userId) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Only group creator can add participants'
                });
            }
            
            // Get existing participants
            const existingParticipants = await ChatParticipant.findAll({
                where: { chatId: chat.id },
                attributes: ['userId']
            });
            const existingParticipantIds = new Set(existingParticipants.map(p => p.userId));
            
            // Filter out users already in chat
            const newParticipantIds = participantIds.filter(id => !existingParticipantIds.has(id));
            
            if (newParticipantIds.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    message: 'All specified users are already in the chat'
                });
            }
            
            // Verify new participants exist
            const newParticipants = await User.findAll({
                where: { id: newParticipantIds },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'socketIds']
            });
            
            if (newParticipants.length !== newParticipantIds.length) {
                const foundIds = newParticipants.map(p => p.id);
                const missingIds = newParticipantIds.filter(id => !foundIds.includes(id));
                return res.status(404).json({
                    status: 'error',
                    message: `Users not found: ${missingIds.join(', ')}`
                });
            }
            
            // Add new participants
            const participantRecords = newParticipants.map(participant => ({
                chatId: chat.id,
                userId: participant.id,
                joinedAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date()
            }));
            
            await ChatParticipant.bulkCreate(participantRecords);
            
            const currentUser = await User.findByPk(userId, {
                attributes: ['id', 'username', 'avatar']
            });
            
            // Broadcast to all participants
            if (req.io) {
                // ✅ FIX: Notify new participants (Promise.allSettled is await-safe)
                await Promise.allSettled(
                    newParticipants.map(p => emitToUser(req.io, p.id, 'group:joined', {
                        chat: { id: chat.id, name: chat.name, type: chat.type, avatar: chat.avatar },
                        addedBy: {
                            id: userId,
                            username: currentUser?.username || req.user?.username,
                            avatar: currentUser?.avatar || req.user?.avatar
                        }
                    }))
                );
                
                // Notify existing participants
                const existingUserIds = Array.from(existingParticipantIds);
                const existingUsers = await User.findAll({
                    where: { id: existingUserIds },
                    attributes: ['id', 'socketIds']
                });
                
                // ✅ FIX: emit group:participants-added to existing members
                await Promise.allSettled(
                    existingUserIds.map(uid => emitToUser(req.io, uid, 'group:participants-added', {
                        chatId: chat.id,
                        addedParticipants: newParticipants.map(p => ({
                            id: p.id, username: p.username, avatar: p.avatar,
                            firstName: p.firstName, lastName: p.lastName
                        })),
                        addedBy: { id: userId, username: currentUser?.username || req.user?.username },
                        timestamp: new Date().toISOString()
                    }))
                );
            }
            
            res.status(200).json({
                status: 'success',
                message: 'Participants added successfully',
                data: {
                    addedCount: newParticipants.length,
                    addedParticipants: newParticipants.map(p => ({
                        id: p.id,
                        username: p.username,
                        avatar: p.avatar,
                        firstName: p.firstName,
                        lastName: p.lastName
                    }))
                }
            });
        } catch (error) {
            console.error('[Chats] Error adding participants:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to add participants'
            });
        }
    })
);

// ============================================================================
// REMOVE PARTICIPANT FROM GROUP CHAT
// ============================================================================
router.delete(
    '/:chatId/participants/:userId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const currentUserId = getUserId(req);
            
            if (!currentUserId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId, userId: targetUserId } = req.params;
            
            if (!chatId || !targetUserId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID and User ID are required'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            // Only group chats support participant removal
            if (chat.type !== 'group') {
                return res.status(400).json({
                    status: 'error',
                    message: 'Only group chats support participant removal'
                });
            }
            
            const isSelfRemoval = parseInt(targetUserId) === parseInt(currentUserId);
            const isCreator = chat.createdBy === currentUserId;
            
            if (!isCreator && !isSelfRemoval) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Only group creator can remove other participants'
                });
            }
            
            // Cannot remove creator
            if (parseInt(targetUserId) === chat.createdBy && !isSelfRemoval) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Cannot remove group creator'
                });
            }
            
            // Check if user is in chat
            const participant = await ChatParticipant.findOne({
                where: {
                    chatId: chat.id,
                    userId: targetUserId
                }
            });
            
            if (!participant) {
                return res.status(400).json({
                    status: 'error',
                    message: 'User is not a member of this chat'
                });
            }
            
            await participant.destroy();
            
            const removedUser = await User.findByPk(targetUserId, {
                attributes: ['id', 'username', 'avatar', 'socketIds']
            });
            const currentUser = await User.findByPk(currentUserId, {
                attributes: ['id', 'username', 'avatar']
            });
            
            // Broadcast to remaining participants
            if (req.io && removedUser && currentUser) {
                // Notify removed user
                if (removedUser.socketIds && Array.isArray(removedUser.socketIds) && removedUser.socketIds.length > 0) {
                // ✅ FIX 12e: emitToUser replaces stale socketIds loop
                await emitToUser(req.io, removedUser.id || removedUser.userId, 'group:removed', {
                            chatId: chat.id,
                            chatName: chat.name,
                            removedBy: isSelfRemoval ? 'self' : {
                                id: currentUserId,
                                username: currentUser.username
                            },
                            timestamp: new Date().toISOString()
                        });
                }
                
                // Notify remaining participants
                const remainingParticipants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    attributes: ['userId']
                });
                
                const remainingUserIds = remainingParticipants.map(p => p.userId);
                const remainingUsers = await User.findAll({
                    where: { id: remainingUserIds },
                    attributes: ['id', 'socketIds']
                });
                
                // ✅ FIX: emit group:participant-removed via Promise.allSettled
                await Promise.allSettled(
                    remainingUsers.map(u => emitToUser(req.io, u.id || u.userId, 'group:participant-removed', {
                        chatId: chat.id,
                        removedUserId: parseInt(targetUserId),
                        removedUsername: removedUser.username,
                        removedBy: { id: currentUserId, username: currentUser.username },
                        timestamp: new Date().toISOString()
                    }))
                );
            }
            
            res.status(200).json({
                status: 'success',
                message: isSelfRemoval ? 'Left group chat successfully' : 'Participant removed successfully'
            });
        } catch (error) {
            console.error('[Chats] Error removing participant:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to remove participant'
            });
        }
    })
);

// ============================================================================
// LEAVE GROUP CHAT (Alias for DELETE /:chatId/participants/:userId with self)
// ============================================================================
router.post(
    '/:chatId/leave',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            // Only group chats support leaving
            if (chat.type !== 'group') {
                return res.status(400).json({
                    status: 'error',
                    message: 'Only group chats can be left'
                });
            }
            
            // Creator cannot leave
            if (chat.createdBy === userId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Group creator cannot leave. Delete the group instead.'
                });
            }
            
            // Check if user is in chat
            const participant = await ChatParticipant.findOne({
                where: {
                    chatId: chat.id,
                    userId: userId
                }
            });
            
            if (!participant) {
                return res.status(400).json({
                    status: 'error',
                    message: 'You are not a member of this group'
                });
            }
            
            await participant.destroy();
            
            const currentUser = await User.findByPk(userId, {
                attributes: ['id', 'username', 'avatar', 'socketIds']
            });
            
            // Broadcast to remaining participants
            if (req.io && currentUser) {
                const remainingParticipants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    attributes: ['userId']
                });
                
                const remainingUserIds = remainingParticipants.map(p => p.userId);
                const remainingUsers = await User.findAll({
                    where: { id: remainingUserIds },
                    attributes: ['id', 'socketIds']
                });
                
                // ✅ FIX: emit group:left via Promise.allSettled
                await Promise.allSettled(
                    remainingUsers.map(u => emitToUser(req.io, u.id || u.userId, 'group:left', {
                        chatId: chat.id,
                        userId: userId,
                        username: currentUser.username,
                        timestamp: new Date().toISOString()
                    }))
                );
            }
            
            res.status(200).json({
                status: 'success',
                message: 'Left group chat successfully'
            });
        } catch (error) {
            console.error('[Chats] Error leaving group chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to leave group chat'
            });
        }
    })
);

// ============================================================================
// DELETE CHAT (Soft delete - mark as inactive)
// ============================================================================
router.delete(
    '/:chatId',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            // Check permissions
            if (chat.type === 'group') {
                // Only group creator can delete group
                if (chat.createdBy !== userId) {
                    return res.status(403).json({
                        status: 'error',
                        message: 'Only group creator can delete the group'
                    });
                }
            } else {
                // For direct chats, either participant can "delete" (archive for themselves)
                const isParticipant = await ChatParticipant.findOne({
                    where: {
                        chatId: chat.id,
                        userId: userId
                    }
                });
                
                if (!isParticipant) {
                    return res.status(403).json({
                        status: 'error',
                        message: 'You are not a participant of this chat'
                    });
                }
            }
            
            // Soft delete - mark as inactive
            await chat.update({
                isActive: false,
                deletedAt: new Date(),
                deletedBy: userId
            });
            
            // Broadcast deletion to all participants
            if (req.io) {
                await broadcastToChat(req, chat.id, 'chat:deleted', {
                    chatId: chat.id,
                    deletedBy: userId,
                    timestamp: new Date().toISOString()
                });
            }
            
            // For group chats, also remove all participants
            if (chat.type === 'group') {
                await ChatParticipant.destroy({
                    where: { chatId: chat.id }
                });
            }
            
            res.status(200).json({
                status: 'success',
                message: 'Chat deleted successfully'
            });
        } catch (error) {
            console.error('[Chats] Error deleting chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to delete chat'
            });
        }
    })
);

// ============================================================================
// ARCHIVE CHAT
// FIX: Added PATCH alias alongside POST so frontend PATCH /chats/:id/archive works
// ============================================================================
router.post(
    '/:chatId/archive',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            // Check if user is participant
            const isParticipant = await ChatParticipant.findOne({
                where: {
                    chatId: chatId,
                    userId: userId
                }
            });
            
            if (!isParticipant) {
                return res.status(403).json({
                    status: 'error',
                    message: 'You are not a participant of this chat'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            await chat.update({
                isArchived: true,
                archivedBy: userId,
                archivedAt: new Date(),
                updatedAt: new Date()
            });
            
            res.status(200).json({
                status: 'success',
                message: 'Chat archived successfully'
            });
        } catch (error) {
            console.error('[Chats] Error archiving chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to archive chat'
            });
        }
    })
);

// FIX: PATCH alias — frontend api_core.js may use PATCH /chats/:id/archive
router.patch('/:chatId/archive', apiRateLimiter, asyncHandler(async (req, res) => {
    req.method = 'POST';
    // Re-use same handler by delegating to the archive logic inline
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ status: 'error', message: 'Authentication required' });
        if (!checkModels(res)) return;
        const { chatId } = req.params;
        if (!chatId) return res.status(400).json({ status: 'error', message: 'Chat ID is required' });
        const isParticipant = await ChatParticipant.findOne({ where: { chatId, userId } });
        if (!isParticipant) return res.status(403).json({ status: 'error', message: 'You are not a participant of this chat' });
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ status: 'error', message: 'Chat not found' });
        await chat.update({ isArchived: true, archivedBy: userId, archivedAt: new Date(), updatedAt: new Date() });
        res.status(200).json({ status: 'success', message: 'Chat archived successfully' });
    } catch (error) {
        console.error('[Chats] Error archiving chat (PATCH):', error.message);
        res.status(500).json({ status: 'error', message: 'Failed to archive chat' });
    }
}));

// ============================================================================
// UNARCHIVE CHAT
// ============================================================================
router.post(
    '/:chatId/unarchive',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            // Check if user is participant
            const isParticipant = await ChatParticipant.findOne({
                where: {
                    chatId: chatId,
                    userId: userId
                }
            });
            
            if (!isParticipant) {
                return res.status(403).json({
                    status: 'error',
                    message: 'You are not a participant of this chat'
                });
            }
            
            const chat = await Chat.findByPk(chatId);
            
            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found'
                });
            }
            
            await chat.update({
                isArchived: false,
                archivedBy: null,
                archivedAt: null,
                updatedAt: new Date()
            });
            
            res.status(200).json({
                status: 'success',
                message: 'Chat unarchived successfully'
            });
        } catch (error) {
            console.error('[Chats] Error unarchiving chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to unarchive chat'
            });
        }
    })
);

// ============================================================================
// MARK CHAT AS READ
// ============================================================================
router.post(
    '/:chatId/read',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { chatId } = req.params;
            
            if (!chatId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Chat ID is required'
                });
            }
            
            // Check if user is participant
            const isParticipant = await ChatParticipant.findOne({
                where: {
                    chatId: chatId,
                    userId: userId
                }
            });
            
            if (!isParticipant) {
                return res.status(403).json({
                    status: 'error',
                    message: 'You are not a participant of this chat'
                });
            }
            
            // Mark all unread messages as read
            await Message.update(
                { 
                    isRead: true, 
                    readAt: new Date(),
                    updatedAt: new Date()
                },
                {
                    where: {
                        chatId: chatId,
                        isRead: false,
                        senderId: { [Op.ne]: userId }
                    }
                }
            );
            
            // Update chat's updatedAt
            await Chat.update(
                { updatedAt: new Date() },
                { where: { id: chatId } }
            );

            // FIX: Emit read receipt to all chat participants so sender's tick turns blue
            try {
                const ws = require('../services/webSocketService');
                const io = ws.getIO ? ws.getIO() : global.__socketIO;
                if (io) {
                    io.to(`chat:${chatId}`).emit('message:read', {
                        chatId,
                        readerId: userId,
                        readAt: new Date().toISOString(),
                    });
                }
            } catch(_) {}
            
            res.status(200).json({
                status: 'success',
                message: 'Chat marked as read'
            });
        } catch (error) {
            console.error('[Chats] Error marking chat as read:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to mark chat as read'
            });
        }
    })
);

// ============================================================================
// GET ARCHIVED CHATS
// ============================================================================
router.get(
    '/archived/list',
    apiRateLimiter,
    asyncHandler(async (req, res) => {
        try {
            const userId = getUserId(req);
            
            if (!userId) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Authentication required'
                });
            }
            
            if (!checkModels(res)) return;
            
            const { page = 1, limit = 20 } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);
            
            const { count, rows: chats } = await Chat.findAndCountAll({
                where: {
                    isArchived: true
                },
                include: [
                    {
                        model: ChatParticipant,
                        as: 'chatParticipants',
                        where: { userId: userId },
                        required: true,
                        attributes: ['userId']
                    },
                    {
                        model: Message,
                        as: 'chatMessages',
                        required: false,
                        limit: 1,
                        order: [['createdAt', 'DESC']],
                        attributes: ['id', 'content', 'type', 'createdAt', 'senderId']
                    },
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    }
                ],
                order: [['archivedAt', 'DESC']],
                offset,
                limit: parseInt(limit),
                distinct: true
            });
            
            const formattedChats = await Promise.all((chats || []).map(async (chat) => {
                const chatObj = chat.toJSON ? chat.toJSON() : chat;
                
                // FIXED: Use correct alias for archived chats too
                const participants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    include: [{
                        model: User,
                        as: 'chatParticipantUser',
                        attributes: ['id', 'username', 'avatar', 'firstName', 'lastName']
                    }]
                });
                chatObj.participants = participants.map(p => p.chatParticipantUser).filter(p => p !== null);
                chatObj.unreadCount = 0;
                
                if (chatObj.type === 'direct') {
                    const otherParticipant = chatObj.participants?.find(p => p && p.id !== userId);
                    if (otherParticipant) {
                        const displayName = [otherParticipant.firstName, otherParticipant.lastName].filter(Boolean).join(' ').trim() || otherParticipant.username;
                        chatObj.otherParticipant = {
                            id: otherParticipant.id,
                            username: otherParticipant.username,
                            avatar: otherParticipant.avatar,
                            displayName: displayName
                        };
                        chatObj.chatName = displayName;
                    }
                } else if (chatObj.type === 'group') {
                    chatObj.chatName = chatObj.name;
                }
                
                return chatObj;
            }));
            
            res.status(200).json({
                status: 'success',
                data: {
                    chats: formattedChats,
                    pagination: {
                        total: count,
                        page: parseInt(page),
                        limit: parseInt(limit),
                        pages: Math.ceil(count / parseInt(limit))
                    }
                }
            });
        } catch (error) {
            console.error('[Chats] Error fetching archived chats:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to fetch archived chats'
            });
        }
    })
);

module.exports = router;