// Helper function to format user data
const formatUser = (user) => {
    if (!user) return null;
    const userData = user.toJSON ? user.toJSON() : user;
    const displayName = [userData.firstName, userData.lastName].filter(Boolean).join(' ').trim() || userData.username;
    return {
        id: userData.id,
        username: userData.username,
        avatar: userData.avatar,
        displayName: displayName,
        status: userData.status
    };
};

const path = require('path');
const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();

// Import database models
const db = require('../models');
const User = db.User || db.Users;
const Chat = db.Chat || db.Chats;
const Message = db.Message || db.Messages;
const ChatParticipant = db.ChatParticipant;

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op } = Sequelize;

// Import middleware
const { apiRateLimiter } = require('../middleware/rateLimiter');

console.log('✅ Chats routes initialized');

// Helper function to get user ID with validation
const getUserId = (req) => {
    if (!req.user) {
        console.error('[Chats] req.user is undefined!');
        return null;
    }
    return req.user.userId || req.user.id;
};

// Helper function to check database models
const checkModels = (res) => {
    if (!db || !Chat || !User || !Message) {
        return res.status(503).json({
            status: 'error',
            message: 'Database service not available'
        });
    }
    return true;
};

// ===== GET ALL CHATS =====
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
            
            console.log('[Chats] Fetching chats for user:', userId);

            if (!checkModels(res)) return;

            // Get all chats for user using correct alias 'chatParticipants' from model
            const chats = await Chat.findAll({
                where: {
                    isActive: true
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
                        attributes: ['id', 'content', 'messageType', 'createdAt', 'senderId']
                    },
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar']
                    }
                ],
                order: [['lastMessageAt', 'DESC NULLS LAST'], ['updatedAt', 'DESC']],
                limit: 50
            });

            // Get all participant IDs for each chat to find other participants
            const chatIds = chats.map(chat => chat.id);
            let participantsMap = {};
            
            if (chatIds.length > 0 && ChatParticipant) {
                const allParticipants = await ChatParticipant.findAll({
                    where: { chatId: { [Op.in]: chatIds } },
                    attributes: ['chatId', 'userId']
                });
                
                participantsMap = allParticipants.reduce((map, p) => {
                    if (!map[p.chatId]) map[p.chatId] = [];
                    map[p.chatId].push(p.userId);
                    return map;
                }, {});
            }

            // Get all other participants info
            const allUserIds = new Set();
            Object.values(participantsMap).forEach(ids => ids.forEach(id => allUserIds.add(id)));
            const userInfos = await User.findAll({
                where: { id: { [Op.in]: Array.from(allUserIds) } },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
            });
            const userMap = userInfos.reduce((map, user) => {
                map[user.id] = user;
                return map;
            }, {});

            // Format chats for response
            const formattedChats = (chats || []).map(chat => {
                const chatObj = chat.toJSON ? chat.toJSON() : chat;
                const participantIds = participantsMap[chat.id] || [];
                
                // For direct chats, get the other participant info
                if (chatObj.type === 'direct') {
                    const otherUserId = participantIds.find(id => id !== userId);
                    if (otherUserId && userMap[otherUserId]) {
                        const otherUser = userMap[otherUserId];
                        const displayName = [otherUser.firstName, otherUser.lastName].filter(Boolean).join(' ').trim() || otherUser.username;
                        chatObj.otherParticipant = {
                            id: otherUser.id,
                            username: otherUser.username,
                            avatar: otherUser.avatar,
                            displayName: displayName,
                            status: otherUser.status || 'offline'
                        };
                        chatObj.chatName = displayName;
                        chatObj.avatar = otherUser.avatar;
                    }
                } else if (chatObj.type === 'group') {
                    // For groups, use chat name
                    if (!chatObj.chatName && chatObj.name) {
                        chatObj.chatName = chatObj.name;
                    }
                }
                
                chatObj.unreadCount = 0;
                return chatObj;
            });

            res.status(200).json({
                status: 'success',
                data: {
                    chats: formattedChats,
                    pagination: { total: chats.length, page: 1, limit: 50, pages: 1 }
                }
            });
        } catch (error) {
            console.error('[Chats] Error fetching chats:', error.message);
            res.status(200).json({
                status: 'success',
                data: { chats: [] }
            });
        }
    })
);

// ===== GET SINGLE CHAT =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    isActive: true
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
                        attributes: ['id', 'content', 'messageType', 'createdAt', 'senderId']
                    },
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar']
                    }
                ]
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found or access denied'
                });
            }

            // Get all participants for this chat
            const participants = await ChatParticipant.findAll({
                where: { chatId: chat.id },
                attributes: ['userId']
            });
            
            const participantIds = participants.map(p => p.userId);
            
            // Get all user details for participants
            const participantUsers = await User.findAll({
                where: { id: { [Op.in]: participantIds } },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'status', 'lastSeen']
            });

            const chatData = chat.toJSON ? chat.toJSON() : chat;
            
            chatData.unreadCount = 0;
            chatData.participants = participantUsers;

            if (chat.type === 'direct') {
                const otherParticipant = participantUsers.find(p => p.id !== userId);
                chatData.otherParticipant = otherParticipant || null;
                if (!chatData.chatName && otherParticipant) {
                    chatData.chatName = [otherParticipant.firstName, otherParticipant.lastName].filter(Boolean).join(' ').trim() || otherParticipant.username;
                }
            } else if (chat.type === 'group') {
                if (!chatData.chatName && chatData.name) {
                    chatData.chatName = chatData.name;
                }
            }

            res.status(200).json({
                status: 'success',
                data: { chat: chatData },
            });
        } catch (error) {
            console.error('Error fetching chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to fetch chat'
            });
        }
    })
);

// ===== CREATE DIRECT CHAT =====
router.post(
    '/direct',
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
                    message: 'Cannot create chat with yourself'
                });
            }

            const otherUser = await User.findByPk(otherUserId);
            if (!otherUser) {
                return res.status(404).json({
                    status: 'error',
                    message: 'User not found'
                });
            }

            // Check if direct chat already exists
            let existingChat = null;
            
            // Manual check for existing chat
            const chatsWithParticipant = await Chat.findAll({
                include: [
                    {
                        model: ChatParticipant,
                        as: 'chatParticipants',
                        where: { userId: userId },
                        required: true
                    }
                ],
                where: { type: 'direct', isActive: true }
            });
            
            for (const chat of chatsWithParticipant) {
                const participants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    attributes: ['userId']
                });
                const participantIds = participants.map(p => p.userId);
                if (participantIds.includes(userId) && participantIds.includes(otherUserId)) {
                    existingChat = chat;
                    break;
                }
            }

            if (existingChat) {
                const chatData = existingChat.toJSON ? existingChat.toJSON() : existingChat;
                chatData.otherParticipant = otherUser;
                chatData.chatName = [otherUser.firstName, otherUser.lastName].filter(Boolean).join(' ').trim() || otherUser.username;

                return res.status(200).json({
                    status: 'success',
                    message: 'Chat already exists',
                    data: { chat: chatData },
                });
            }

            const currentUser = await User.findByPk(userId);

            // Create new chat
            const chat = await Chat.create({
                type: 'direct',
                createdBy: userId,
                name: null,
                isActive: true
            });

            if (!chat) {
                return res.status(500).json({
                    status: 'error',
                    message: 'Failed to create chat'
                });
            }

            // Add participants
            if (ChatParticipant) {
                await ChatParticipant.bulkCreate([
                    { chatId: chat.id, userId: userId },
                    { chatId: chat.id, userId: otherUserId }
                ]);
            }

            const chatData = chat.toJSON ? chat.toJSON() : chat;
            chatData.otherParticipant = otherUser;
            chatData.chatName = [otherUser.firstName, otherUser.lastName].filter(Boolean).join(' ').trim() || otherUser.username;

            if (req.io && otherUser.socketIds && Array.isArray(otherUser.socketIds) && otherUser.socketIds.length > 0) {
                otherUser.socketIds.forEach(socketId => {
                    req.io.to(socketId).emit('chat:created', {
                        chat: chatData,
                        createdBy: {
                            id: userId,
                            username: currentUser.username,
                            avatar: currentUser.avatar,
                        },
                    });
                });
            }

            res.status(201).json({
                status: 'success',
                message: 'Chat created successfully',
                data: { chat: chatData },
            });
        } catch (error) {
            console.error('Error creating direct chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to create direct chat'
            });
        }
    })
);

// ===== CREATE GROUP CHAT =====
router.post(
    '/group',
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

            const allParticipants = [...new Set([userId, ...participantIds])];

            const participants = await User.findAll({
                where: { id: allParticipants },
                attributes: ['id', 'username', 'avatar', 'firstName', 'lastName', 'socketIds']
            });

            if (participants.length !== allParticipants.length) {
                return res.status(404).json({
                    status: 'error',
                    message: 'One or more participants not found'
                });
            }

            const currentUser = await User.findByPk(userId);

            // Create chat
            const chat = await Chat.create({
                type: 'group',
                name: name.trim(),
                description: description?.trim(),
                avatar: avatar,
                createdBy: userId,
                isActive: true
            });

            if (!chat) {
                return res.status(500).json({
                    status: 'error',
                    message: 'Failed to create group'
                });
            }

            // Add participants
            if (ChatParticipant) {
                const participantRecords = allParticipants.map(participantId => ({
                    chatId: chat.id,
                    userId: participantId
                }));
                await ChatParticipant.bulkCreate(participantRecords);
            }

            const populatedChat = await Chat.findByPk(chat.id, {
                include: [
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar']
                    }
                ]
            });

            if (req.io && participants) {
                const notificationData = {
                    chat: populatedChat.toJSON ? populatedChat.toJSON() : populatedChat,
                    addedBy: {
                        id: userId,
                        username: currentUser.username,
                        avatar: currentUser.avatar,
                    },
                };

                participants.forEach(participant => {
                    if (participant.socketIds && Array.isArray(participant.socketIds) && participant.socketIds.length > 0) {
                        participant.socketIds.forEach(socketId => {
                            req.io.to(socketId).emit('group:created', notificationData);
                        });
                    }
                });
            }

            res.status(201).json({
                status: 'success',
                message: 'Group chat created successfully',
                data: { chat: populatedChat },
            });
        } catch (error) {
            console.error('Error creating group chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to create group chat'
            });
        }
    })
);

// ===== UPDATE CHAT =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    type: 'group',
                    createdBy: userId,
                    isActive: true
                }
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Group chat not found or access denied'
                });
            }

            const updates = {};
            if (name && name.trim()) updates.name = name.trim();
            if (description !== undefined) updates.description = description?.trim();
            if (avatar !== undefined) updates.avatar = avatar;

            await chat.update(updates);

            const updatedChat = await Chat.findByPk(chatId, {
                include: [
                    {
                        model: User,
                        as: 'chatCreator',
                        attributes: ['id', 'username', 'avatar']
                    }
                ]
            });

            // Get all participants for broadcasting
            const participants = await ChatParticipant.findAll({
                where: { chatId: chat.id },
                attributes: ['userId']
            });
            
            const participantUsers = await User.findAll({
                where: { id: participants.map(p => p.userId) },
                attributes: ['id', 'socketIds']
            });

            if (req.io && updatedChat) {
                participantUsers.forEach(participant => {
                    if (participant.socketIds && Array.isArray(participant.socketIds) && participant.socketIds.length > 0) {
                        participant.socketIds.forEach(socketId => {
                            req.io.to(socketId).emit('group:updated', {
                                chatId: chat.id,
                                updates,
                                updatedBy: {
                                    id: userId,
                                    username: req.user.username,
                                },
                            });
                        });
                    }
                });
            }

            res.status(200).json({
                status: 'success',
                message: 'Chat updated successfully',
                data: { chat: updatedChat },
            });
        } catch (error) {
            console.error('Error updating chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update chat'
            });
        }
    })
);

// ===== ADD PARTICIPANTS TO GROUP =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    type: 'group',
                    isActive: true
                }
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Group chat not found'
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
            const existingParticipantIds = existingParticipants.map(p => p.userId);
            
            const newParticipants = participantIds.filter(id => !existingParticipantIds.includes(id));

            if (newParticipants.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    message: 'All users are already in the chat'
                });
            }

            // Add new participants
            const newParticipantRecords = newParticipants.map(participantId => ({
                chatId: chat.id,
                userId: participantId
            }));
            await ChatParticipant.bulkCreate(newParticipantRecords);

            const newParticipantUsers = await User.findAll({
                where: { id: newParticipants },
                attributes: ['id', 'username', 'avatar', 'socketIds']
            });

            const currentUser = await User.findByPk(userId);

            if (req.io && currentUser) {
                newParticipantUsers.forEach(participant => {
                    if (participant.socketIds && Array.isArray(participant.socketIds) && participant.socketIds.length > 0) {
                        participant.socketIds.forEach(socketId => {
                            req.io.to(socketId).emit('group:joined', {
                                chat: chat.toJSON ? chat.toJSON() : chat,
                                addedBy: {
                                    id: userId,
                                    username: currentUser.username,
                                    avatar: currentUser.avatar,
                                },
                            });
                        });
                    }
                });

                const existingUsers = await User.findAll({
                    where: { id: existingParticipantIds },
                    attributes: ['id', 'socketIds']
                });

                existingUsers.forEach(user => {
                    if (user.socketIds && Array.isArray(user.socketIds) && user.socketIds.length > 0) {
                        user.socketIds.forEach(socketId => {
                            req.io.to(socketId).emit('group:participants-added', {
                                chatId: chat.id,
                                addedParticipants: newParticipantUsers.map(p => ({
                                    id: p.id,
                                    username: p.username,
                                    avatar: p.avatar,
                                })),
                                addedBy: {
                                    id: userId,
                                    username: currentUser.username,
                                },
                            });
                        });
                    }
                });
            }

            res.status(200).json({
                status: 'success',
                message: 'Participants added successfully',
                data: {
                    addedCount: newParticipants.length,
                },
            });
        } catch (error) {
            console.error('Error adding participants:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to add participants'
            });
        }
    })
);

// ===== REMOVE PARTICIPANT FROM GROUP =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    type: 'group',
                    isActive: true
                }
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Group chat not found'
                });
            }

            const isSelfRemoval = targetUserId === currentUserId;
            const isCreator = chat.createdBy === currentUserId;

            if (!isCreator && !isSelfRemoval) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Only group creator can remove other participants'
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
                    message: 'User is not in this chat'
                });
            }

            await participant.destroy();

            const removedUser = await User.findByPk(targetUserId);
            const currentUser = await User.findByPk(currentUserId);

            if (req.io && removedUser && currentUser) {
                if (removedUser.socketIds && Array.isArray(removedUser.socketIds) && removedUser.socketIds.length > 0) {
                    removedUser.socketIds.forEach(socketId => {
                        req.io.to(socketId).emit('group:removed', {
                            chatId: chat.id,
                            removedBy: isSelfRemoval
                                ? 'self'
                                : {
                                    id: currentUserId,
                                    username: currentUser.username,
                                  },
                        });
                    });
                }

                const remainingParticipants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    attributes: ['userId']
                });
                
                const remainingUsers = await User.findAll({
                    where: { id: remainingParticipants.map(p => p.userId) },
                    attributes: ['id', 'socketIds']
                });

                remainingUsers.forEach(user => {
                    if (user.socketIds && Array.isArray(user.socketIds) && user.socketIds.length > 0) {
                        user.socketIds.forEach(socketId => {
                            req.io.to(socketId).emit('group:participant-removed', {
                                chatId: chat.id,
                                removedUserId: targetUserId,
                                removedUsername: removedUser.username,
                                removedBy: {
                                    id: currentUserId,
                                    username: currentUser.username,
                                },
                            });
                        });
                    }
                });
            }

            res.status(200).json({
                status: 'success',
                message: 'Participant removed successfully',
            });
        } catch (error) {
            console.error('Error removing participant:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to remove participant'
            });
        }
    })
);

// ===== LEAVE GROUP CHAT =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    type: 'group',
                    isActive: true
                }
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Group chat not found'
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

            // Check if user is creator - cannot leave if creator
            if (chat.createdBy === userId) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Group creator cannot leave. Delete the group instead.'
                });
            }

            await participant.destroy();

            const currentUser = await User.findByPk(userId);

            if (req.io && currentUser) {
                const remainingParticipants = await ChatParticipant.findAll({
                    where: { chatId: chat.id },
                    attributes: ['userId']
                });
                
                const remainingUsers = await User.findAll({
                    where: { id: remainingParticipants.map(p => p.userId) },
                    attributes: ['id', 'socketIds']
                });

                remainingUsers.forEach(user => {
                    if (user.socketIds && Array.isArray(user.socketIds) && user.socketIds.length > 0) {
                        user.socketIds.forEach(socketId => {
                            req.io.to(socketId).emit('group:left', {
                                chatId: chat.id,
                                userId: userId,
                                username: currentUser.username,
                            });
                        });
                    }
                });
            }

            res.status(200).json({
                status: 'success',
                message: 'Left group chat successfully',
            });
        } catch (error) {
            console.error('Error leaving group chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to leave group chat'
            });
        }
    })
);

// ===== ARCHIVE CHAT =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    isArchived: false,
                    '$chatParticipants.userId$': userId
                },
                include: [{
                    model: ChatParticipant,
                    as: 'chatParticipants',
                    attributes: ['userId'],
                    where: { userId: userId },
                    required: true
                }]
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found or already archived'
                });
            }

            await chat.update({
                isArchived: true,
                archivedBy: userId,
                archivedAt: new Date()
            });

            res.status(200).json({
                status: 'success',
                message: 'Chat archived successfully',
            });
        } catch (error) {
            console.error('Error archiving chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to archive chat'
            });
        }
    })
);

// ===== UNARCHIVE CHAT =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    isArchived: true,
                    '$chatParticipants.userId$': userId
                },
                include: [{
                    model: ChatParticipant,
                    as: 'chatParticipants',
                    attributes: ['userId'],
                    where: { userId: userId },
                    required: true
                }]
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found or not archived'
                });
            }

            await chat.update({
                isArchived: false,
                archivedBy: null,
                archivedAt: null
            });

            res.status(200).json({
                status: 'success',
                message: 'Chat unarchived successfully',
            });
        } catch (error) {
            console.error('Error unarchiving chat:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to unarchive chat'
            });
        }
    })
);

// ===== MARK CHAT AS READ =====
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

            const chat = await Chat.findOne({
                where: {
                    id: chatId,
                    '$chatParticipants.userId$': userId
                },
                include: [{
                    model: ChatParticipant,
                    as: 'chatParticipants',
                    attributes: ['userId'],
                    where: { userId: userId },
                    required: true
                }]
            });

            if (!chat) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Chat not found or access denied'
                });
            }

            // Mark all unread messages as read
            if (Message) {
                await Message.update(
                    { isRead: true, readAt: new Date() },
                    {
                        where: {
                            chatId: chat.id,
                            isRead: false,
                            senderId: { [Op.ne]: userId }
                        }
                    }
                );
            }

            res.status(200).json({
                status: 'success',
                message: 'Chat marked as read',
            });
        } catch (error) {
            console.error('Error marking chat as read:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to mark chat as read'
            });
        }
    })
);

// ===== GET ARCHIVED CHATS =====
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
                        attributes: ['id', 'content', 'messageType', 'createdAt', 'senderId']
                    }
                ],
                order: [['archivedAt', 'DESC']],
                offset,
                limit: parseInt(limit),
                distinct: true
            });

            const formattedChats = (chats || []).map(chat => {
                const chatObj = chat.toJSON ? chat.toJSON() : chat;
                chatObj.unreadCount = 0;
                return chatObj;
            });

            res.status(200).json({
                status: 'success',
                data: {
                    chats: formattedChats,
                    pagination: {
                        total: count || 0,
                        page: parseInt(page),
                        limit: parseInt(limit),
                        pages: count ? Math.ceil(count / parseInt(limit)) : 0,
                    },
                },
            });
        } catch (error) {
            console.error('Error fetching archived chats:', error.message);
            res.status(500).json({
                status: 'error',
                message: 'Failed to fetch archived chats'
            });
        }
    })
);

module.exports = router;