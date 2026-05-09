/**
 * chatService.js — v2.0 (Sequelize / PostgreSQL)
 *
 * FULL REWRITE: The original 1,497-line file used Mongoose/MongoDB syntax
 * throughout (findById, $all, $addToSet, populate, mongoose.Types.ObjectId,
 * Map-based unreadCounts, etc.) against a PostgreSQL/Sequelize database.
 * Every method threw immediately on first call.
 *
 * This version preserves every method signature and all business logic,
 * rewritten with raw Sequelize parameterised queries matching the pattern
 * already used by messageService.js and the inline handlers in chats.js.
 */

'use strict';

const { ValidationError, NotFoundError, ServerError } = require('../utils/errors');
const { AppError, AuthorizationError, ConflictError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const MAX_CHAT_PARTICIPANTS  = parseInt(process.env.MAX_CHAT_PARTICIPANTS,  10) || 1000;
const MAX_MESSAGE_LENGTH     = parseInt(process.env.MAX_MESSAGE_LENGTH,     10) || 5000;
const MESSAGE_RETENTION_DAYS = parseInt(process.env.MESSAGE_RETENTION_DAYS, 10) || 365;

const DEFAULT_CHAT_SETTINGS = {
    allowMemberInvites:   true,
    allowMessageDeletion: true,
    requireAdminApproval: false,
    maxParticipants:      1000,
    joinSettings:         'invite_only',
};

function getDB() {
    try { return require('../models').sequelize; }
    catch (e) { throw new ServerError('Database not available'); }
}

const safeInt = (val) => {
    const n = parseInt(val, 10);
    return (!isNaN(n) && n > 0) ? n : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _getParticipants(sequelize, chatId) {
    return sequelize.query(
        `SELECT u.id, u.username, u.avatar, u."firstName", u."lastName",
                u.status, u."lastSeen", u.email
         FROM chat_participants cp
         JOIN "Users" u ON u.id = cp."userId"
         WHERE cp."chatId" = :chatId`,
        { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
    );
}

async function _getUnreadCount(sequelize, chatId, userId) {
    const [row] = await sequelize.query(
        `SELECT COUNT(*) AS count FROM "Messages" m
         LEFT JOIN "ReadReceipts" rr ON rr."messageId" = m.id AND rr."userId" = :userId
         WHERE m."chatId" = :chatId AND m."isDeleted" = false
           AND m."senderId" != :userId AND rr.id IS NULL`,
        { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
    );
    return parseInt(row.count, 10) || 0;
}

function _formatChat(chat, participants, unreadCount, userId) {
    const obj = { ...chat, participants: participants || [], unreadCount: unreadCount || 0 };
    if (obj.type === 'direct') {
        const other = (participants || []).find(p => p && p.id !== userId);
        if (other) {
            const displayName = [other.firstName, other.lastName].filter(Boolean).join(' ').trim() || other.username;
            obj.otherParticipant = { id: other.id, username: other.username, avatar: other.avatar, displayName, status: other.status || 'offline', lastSeen: other.lastSeen };
            obj.chatName = displayName;
            obj.avatar   = other.avatar;
        }
    } else if (obj.type === 'group') {
        obj.chatName         = obj.name;
        obj.participantCount = (participants || []).length;
        obj.onlineCount      = (participants || []).filter(p => p && p.online).length;
        obj.isCreator        = String(obj.createdBy) === String(userId);
    }
    return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatService
// ─────────────────────────────────────────────────────────────────────────────

class ChatService {

    // ── Create direct chat ────────────────────────────────────────────────────

    static async createDirectChat(userId, targetUserId) {
        const sequelize = getDB();
        try {
            if (!userId || !targetUserId) throw new ValidationError('Both user IDs are required');
            if (String(userId) === String(targetUserId)) throw new ValidationError('Cannot create chat with yourself');

            const users = await sequelize.query(
                `SELECT id FROM "Users" WHERE id IN (:userId, :targetUserId)`,
                { replacements: { userId, targetUserId }, type: sequelize.QueryTypes.SELECT }
            );
            if (users.length < 2) throw new NotFoundError('One or both users not found');

            const existing = await sequelize.query(
                `SELECT c.id FROM chats c
                 JOIN chat_participants cp1 ON cp1."chatId" = c.id AND cp1."userId" = :userId
                 JOIN chat_participants cp2 ON cp2."chatId" = c.id AND cp2."userId" = :targetUserId
                 WHERE c.type = 'direct' AND c."isActive" = true LIMIT 1`,
                { replacements: { userId, targetUserId }, type: sequelize.QueryTypes.SELECT }
            );
            if (existing && existing.length > 0) {
                return { chat: await ChatService.getChatDetails(existing[0].id, userId), isNew: false };
            }

            const result = await sequelize.query(
                `INSERT INTO chats (type, "createdBy", "isActive", "createdAt", "updatedAt")
                 VALUES ('direct', :userId, true, NOW(), NOW()) RETURNING id`,
                { replacements: { userId }, type: sequelize.QueryTypes.INSERT }
            );
            const chatId = result[0][0].id;

            await sequelize.query(
                `INSERT INTO chat_participants ("chatId", "userId", "joinedAt", "createdAt", "updatedAt")
                 VALUES (:chatId, :userId, NOW(), NOW(), NOW()),
                        (:chatId, :targetUserId, NOW(), NOW(), NOW())`,
                { replacements: { chatId, userId, targetUserId } }
            );

            return { chat: await ChatService.getChatDetails(chatId, userId), isNew: true };
        } catch (error) {
            logger.error('Create direct chat failed:', error);
            throw error;
        }
    }

    // ── Create group chat ─────────────────────────────────────────────────────

    static async createGroupChat(userId, groupData) {
        const sequelize = getDB();
        try {
            const { name, description, avatar, participantIds = [], settings = {} } = groupData;

            if (!name || !name.trim()) throw new ValidationError('Group name is required');
            if (name.length > 100)     throw new ValidationError('Group name must be less than 100 characters');

            const uniqueIds = [...new Set([userId, ...participantIds.filter(id => String(id) !== String(userId))])];
            if (uniqueIds.length > MAX_CHAT_PARTICIPANTS) {
                throw new ValidationError(`Group cannot have more than ${MAX_CHAT_PARTICIPANTS} participants`);
            }

            const found = await sequelize.query(
                `SELECT id FROM "Users" WHERE id IN (:ids)`,
                { replacements: { ids: uniqueIds }, type: sequelize.QueryTypes.SELECT }
            );
            if (found.length !== uniqueIds.length) throw new NotFoundError('One or more users not found');

            const groupSettings = { ...DEFAULT_CHAT_SETTINGS, ...settings };

            const result = await sequelize.query(
                `INSERT INTO chats (type, name, description, avatar, "createdBy", settings, "isActive", "createdAt", "updatedAt")
                 VALUES ('group', :name, :description, :avatar, :userId, :settings::jsonb, true, NOW(), NOW())
                 RETURNING id`,
                {
                    replacements: {
                        name: name.trim(),
                        description: description?.trim() || null,
                        avatar: avatar || null,
                        userId,
                        settings: JSON.stringify(groupSettings),
                    },
                    type: sequelize.QueryTypes.INSERT
                }
            );
            const chatId = result[0][0].id;

            const vals = uniqueIds.map(pid => `(${safeInt(chatId)}, ${safeInt(pid)}, NOW(), NOW(), NOW())`).join(',');
            await sequelize.query(
                `INSERT INTO chat_participants ("chatId", "userId", "joinedAt", "createdAt", "updatedAt") VALUES ${vals}`
            );

            return await ChatService.getChatDetails(chatId, userId);
        } catch (error) {
            logger.error('Create group chat failed:', error);
            throw error;
        }
    }

    // ── Get user chats ────────────────────────────────────────────────────────

    static async getUserChats(userId, options = {}) {
        const sequelize = getDB();
        try {
            const {
                page       = 1,
                limit      = 20,
                chatType   = 'all',
                unreadOnly = false,
                search     = '',
                sortBy     = 'updatedAt',
                sortOrder  = 'desc',
                offset: rawOffset,
            } = options;

            const pageNum  = Math.max(1, safeInt(page) || 1);
            const limitNum = Math.min(100, safeInt(limit) || 20);
            const offset   = rawOffset !== undefined ? rawOffset : (pageNum - 1) * limitNum;
            const replacements = { userId, limit: limitNum, offset };

            let typeClause = '', searchClause = '';

            if (chatType !== 'all') {
                typeClause = 'AND c.type = :chatType';
                replacements.chatType = chatType;
            }
            if (search && search.trim()) {
                searchClause = `AND (c.name ILIKE :search OR EXISTS (
                    SELECT 1 FROM chat_participants cp2
                    JOIN "Users" su ON su.id = cp2."userId"
                    WHERE cp2."chatId" = c.id
                      AND (su.username ILIKE :search OR su."firstName" ILIKE :search OR su."lastName" ILIKE :search)
                ))`;
                replacements.search = `%${search.trim()}%`;
            }

            const orderCol = sortBy === 'lastMessage' ? 'c."lastMessageAt"' : 'c."updatedAt"';
            const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

            const chats = await sequelize.query(
                `SELECT
                   c.id, c.type, c.name, c."createdBy", c."isArchived", c."updatedAt", c."createdAt",
                   c.avatar, c.description, c.settings,
                   (
                     SELECT jsonb_build_object(
                       'id', m.id, 'content', m.content, 'senderId', m."senderId",
                       'createdAt', m."createdAt", 'type', m.type,
                       'sender', jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar)
                     )
                     FROM "Messages" m LEFT JOIN "Users" u ON u.id = m."senderId"
                     WHERE m."chatId" = c.id AND m."isDeleted" = false
                     ORDER BY m."createdAt" DESC LIMIT 1
                   ) AS "lastMessage",
                   (
                     SELECT COUNT(*) FROM "Messages" m2
                     LEFT JOIN "ReadReceipts" rr ON rr."messageId" = m2.id AND rr."userId" = :userId
                     WHERE m2."chatId" = c.id AND m2."isDeleted" = false
                       AND m2."senderId" != :userId AND rr.id IS NULL
                   ) AS "unreadCount"
                 FROM chats c
                 WHERE EXISTS (
                   SELECT 1 FROM chat_participants cp WHERE cp."chatId" = c.id AND cp."userId" = :userId
                 )
                 AND c."isActive" = true
                 ${typeClause} ${searchClause}
                 ORDER BY ${orderCol} ${orderDir} NULLS LAST
                 LIMIT :limit OFFSET :offset`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const processed = await Promise.all(chats.map(async (chat) => {
                const participants = await _getParticipants(sequelize, chat.id);
                return _formatChat(chat, participants, parseInt(chat.unreadCount || 0, 10), userId);
            }));

            const [{ total }] = await sequelize.query(
                `SELECT COUNT(*) AS total FROM chats c
                 WHERE EXISTS (
                   SELECT 1 FROM chat_participants cp WHERE cp."chatId" = c.id AND cp."userId" = :userId
                 )
                 AND c."isActive" = true ${typeClause} ${searchClause}`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            return {
                chats: processed,
                pagination: {
                    total: parseInt(total, 10),
                    page: pageNum,
                    limit: limitNum,
                    pages: Math.ceil(parseInt(total, 10) / limitNum),
                },
            };
        } catch (error) {
            logger.error('Get user chats failed:', error);
            throw error;
        }
    }

    // ── Get chat details ──────────────────────────────────────────────────────

    static async getChatDetails(chatId, userId) {
        const sequelize = getDB();
        try {
            if (!chatId || !userId) throw new ValidationError('chatId and userId are required');

            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new ValidationError('Chat not found or access denied');

            const [chat] = await sequelize.query(
                `SELECT id, type, name, description, avatar, "createdBy", settings,
                        "isArchived", "isActive", "updatedAt", "createdAt"
                 FROM chats WHERE id = :chatId LIMIT 1`,
                { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!chat) throw new NotFoundError('Chat not found');

            const participants = await _getParticipants(sequelize, chatId);
            const unreadCount  = await _getUnreadCount(sequelize, chatId, userId);

            return _formatChat(chat, participants, unreadCount, userId);
        } catch (error) {
            logger.error('Get chat details failed:', error);
            throw error;
        }
    }

    // ── Send message ──────────────────────────────────────────────────────────

    static async sendMessage(chatId, userId, messageData) {
        const sequelize = getDB();
        try {
            const { content, replyTo, messageType = 'text' } = messageData;

            if (messageType === 'text' && (!content || !content.trim())) throw new ValidationError('Message content is required');
            if (messageType === 'text' && content.length > MAX_MESSAGE_LENGTH) {
                throw new ValidationError(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
            }

            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants cp
                 JOIN chats c ON c.id = cp."chatId" AND c."isActive" = true
                 WHERE cp."chatId" = :chatId AND cp."userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new NotFoundError('Chat not found or access denied');

            const safeReplyTo = replyTo ? safeInt(replyTo) : null;
            if (safeReplyTo) {
                const [replyMsg] = await sequelize.query(
                    `SELECT id FROM "Messages" WHERE id = :replyTo AND "chatId" = :chatId AND "isDeleted" = false LIMIT 1`,
                    { replacements: { replyTo: safeReplyTo, chatId }, type: sequelize.QueryTypes.SELECT }
                );
                if (!replyMsg) throw new ValidationError('Message to reply to not found');
            }

            const msgResult = await sequelize.query(
                `INSERT INTO "Messages" ("chatId","senderId",content,type,reactions,"replyToId","sentAt","deliveredAt","createdAt","updatedAt")
                 VALUES (:chatId, :userId, :content, :type, '{}', :replyToId, NOW(), NOW(), NOW(), NOW())
                 RETURNING id,"chatId","senderId",content,type,"replyToId","createdAt","updatedAt"`,
                {
                    replacements: { chatId, userId, content: (content || '').trim(), type: messageType, replyToId: safeReplyTo },
                    type: sequelize.QueryTypes.INSERT
                }
            );
            const message = msgResult[0][0];

            const [sender] = await sequelize.query(
                `SELECT id, username, avatar, "firstName", "lastName" FROM "Users" WHERE id = :userId`,
                { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
            );
            message.sender = sender || null;

            await sequelize.query(
                `UPDATE chats SET "updatedAt" = NOW(), "lastMessageId" = :messageId WHERE id = :chatId`,
                { replacements: { messageId: message.id, chatId } }
            );

            return { message, chatUpdate: { lastMessage: message.id, updatedAt: new Date().toISOString() } };
        } catch (error) {
            logger.error('Send message failed:', error);
            throw error;
        }
    }

    // ── Get chat messages ─────────────────────────────────────────────────────

    static async getChatMessages(chatId, userId, options = {}) {
        const sequelize = getDB();
        try {
            const { page = 1, limit = 50, before = null, after = null, senderId = null } = options;
            const pageNum  = Math.max(1, safeInt(page) || 1);
            const limitNum = Math.min(100, safeInt(limit) || 50);
            const offset   = (pageNum - 1) * limitNum;

            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new NotFoundError('Chat not found or access denied');

            const replacements = { chatId };
            let beforeClause = '', afterClause = '', senderClause = '';

            if (before) {
                const d = new Date(before);
                if (!isNaN(d.getTime())) { beforeClause = 'AND m."createdAt" < :before'; replacements.before = d.toISOString(); }
            }
            if (after) {
                const d = new Date(after);
                if (!isNaN(d.getTime())) { afterClause = 'AND m."createdAt" > :after'; replacements.after = d.toISOString(); }
            }
            if (senderId) {
                senderClause = 'AND m."senderId" = :senderId';
                replacements.senderId = safeInt(senderId);
            }

            const messages = await sequelize.query(
                `SELECT m.id, m."chatId", m."senderId", m.content, m.type AS "messageType",
                        m.reactions, m."isEdited", m."editedAt", m."replyToId",
                        m."createdAt", m."updatedAt",
                        jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar,
                                           'firstName', u."firstName", 'lastName', u."lastName") AS sender
                 FROM "Messages" m
                 LEFT JOIN "Users" u ON u.id = m."senderId"
                 WHERE m."chatId" = :chatId AND m."isDeleted" = false
                 ${beforeClause} ${afterClause} ${senderClause}
                 ORDER BY m."createdAt" DESC LIMIT ${limitNum} OFFSET ${offset}`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const [{ total }] = await sequelize.query(
                `SELECT COUNT(*) AS total FROM "Messages" m
                 WHERE m."chatId" = :chatId AND m."isDeleted" = false
                 ${beforeClause} ${afterClause} ${senderClause}`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const chronological = messages.reverse();

            // Mark unread messages as read
            const unreadIds = chronological
                .filter(msg => String(msg.senderId) !== String(userId))
                .map(msg => msg.id);

            if (unreadIds.length > 0) {
                const vals = unreadIds.map(id => `(${id}, ${safeInt(userId)}, NOW(), NOW())`).join(',');
                await sequelize.query(
                    `INSERT INTO "ReadReceipts" ("messageId","userId","readAt","createdAt")
                     VALUES ${vals} ON CONFLICT ("messageId","userId") DO NOTHING`
                ).catch(() => {});
            }

            return {
                messages: chronological,
                pagination: {
                    total: parseInt(total, 10),
                    page: pageNum,
                    limit: limitNum,
                    pages: Math.ceil(parseInt(total, 10) / limitNum),
                },
            };
        } catch (error) {
            logger.error('Get chat messages failed:', error);
            throw error;
        }
    }

    // ── Mark messages as read ─────────────────────────────────────────────────

    static async markMessagesAsRead(chatId, userId, messageIds = []) {
        const sequelize = getDB();
        try {
            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new NotFoundError('Chat not found or access denied');

            let targetIds = [];
            if (messageIds.length > 0) {
                targetIds = messageIds.map(safeInt).filter(Boolean);
            } else {
                const rows = await sequelize.query(
                    `SELECT m.id FROM "Messages" m
                     LEFT JOIN "ReadReceipts" rr ON rr."messageId" = m.id AND rr."userId" = :userId
                     WHERE m."chatId" = :chatId AND m."isDeleted" = false
                       AND m."senderId" != :userId AND rr.id IS NULL`,
                    { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
                );
                targetIds = rows.map(r => r.id);
            }

            if (targetIds.length > 0) {
                const vals = targetIds.map(id => `(${id}, ${safeInt(userId)}, NOW(), NOW())`).join(',');
                await sequelize.query(
                    `INSERT INTO "ReadReceipts" ("messageId","userId","readAt","createdAt")
                     VALUES ${vals} ON CONFLICT ("messageId","userId") DO NOTHING`
                );
            }

            return { markedCount: targetIds.length, chatId, userId };
        } catch (error) {
            logger.error('Mark messages as read failed:', error);
            throw error;
        }
    }

    // ── Edit message ──────────────────────────────────────────────────────────

    static async editMessage(messageId, userId, content) {
        const sequelize = getDB();
        try {
            if (!content || !content.trim()) throw new ValidationError('Message content is required');
            if (content.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);

            const [message] = await sequelize.query(
                `SELECT id, "chatId", "senderId", "createdAt" FROM "Messages"
                 WHERE id = :messageId AND "senderId" = :userId AND "isDeleted" = false LIMIT 1`,
                { replacements: { messageId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!message) throw new NotFoundError('Message not found or not authorized to edit');

            if (Date.now() - new Date(message.createdAt).getTime() > 15 * 60 * 1000) {
                throw new ValidationError('Message can only be edited within 15 minutes of sending');
            }

            await sequelize.query(
                `UPDATE "Messages" SET content = :content, "isEdited" = true, "editedAt" = NOW(), "updatedAt" = NOW()
                 WHERE id = :messageId`,
                { replacements: { content: content.trim(), messageId } }
            );

            const [updated] = await sequelize.query(
                `SELECT m.id, m."chatId", m."senderId", m.content, m."isEdited", m."editedAt", m."updatedAt",
                        jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) AS sender
                 FROM "Messages" m LEFT JOIN "Users" u ON u.id = m."senderId"
                 WHERE m.id = :messageId LIMIT 1`,
                { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
            );
            return updated;
        } catch (error) {
            logger.error('Edit message failed:', error);
            throw error;
        }
    }

    // ── Delete message ────────────────────────────────────────────────────────

    static async deleteMessage(messageId, userId, deleteForEveryone = false) {
        const sequelize = getDB();
        try {
            const [message] = await sequelize.query(
                `SELECT m.id, m."chatId", m."senderId", c."createdBy" AS "chatCreatedBy"
                 FROM "Messages" m JOIN chats c ON c.id = m."chatId"
                 WHERE m.id = :messageId AND m."isDeleted" = false LIMIT 1`,
                { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!message) throw new NotFoundError('Message not found');

            const isSender    = String(message.senderId)      === String(userId);
            const isGroupAdmin = String(message.chatCreatedBy) === String(userId);

            if (!isSender && !isGroupAdmin) throw new AuthorizationError('Not authorized to delete this message');
            if (deleteForEveryone && !isSender && !isGroupAdmin) {
                throw new AuthorizationError('Only admins can delete messages for everyone');
            }

            await sequelize.query(
                `UPDATE "Messages"
                 SET "isDeleted" = true, "deletedAt" = NOW(), "deletedBy" = :userId, "updatedAt" = NOW()
                 WHERE id = :messageId`,
                { replacements: { userId, messageId } }
            );

            return { messageId, deletedAt: new Date().toISOString(), deleteForEveryone };
        } catch (error) {
            logger.error('Delete message failed:', error);
            throw error;
        }
    }

    // ── Add/remove reaction ───────────────────────────────────────────────────

    static async addMessageReaction(messageId, userId, emoji) {
        const sequelize = getDB();
        try {
            const [message] = await sequelize.query(
                `SELECT id, "chatId", reactions FROM "Messages"
                 WHERE id = :messageId AND "isDeleted" = false LIMIT 1`,
                { replacements: { messageId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!message) throw new NotFoundError('Message not found');

            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId: message.chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new AuthorizationError('Access denied');

            const reactions = message.reactions || {};
            const key = (emoji || '').trim().substring(0, 10);
            if (!reactions[key]) reactions[key] = [];

            let action;
            const idx = reactions[key].indexOf(userId);
            if (idx >= 0) {
                reactions[key].splice(idx, 1);
                if (!reactions[key].length) delete reactions[key];
                action = 'removed';
            } else {
                reactions[key].push(userId);
                action = 'added';
            }

            await sequelize.query(
                `UPDATE "Messages" SET reactions = :reactions::jsonb, "updatedAt" = NOW() WHERE id = :messageId`,
                { replacements: { reactions: JSON.stringify(reactions), messageId } }
            );

            return { reactions, action };
        } catch (error) {
            logger.error('Add message reaction failed:', error);
            throw error;
        }
    }

    // ── Update group settings ─────────────────────────────────────────────────

    static async updateGroupSettings(groupId, userId, settings) {
        const sequelize = getDB();
        try {
            const [group] = await sequelize.query(
                `SELECT id, "createdBy", settings FROM chats
                 WHERE id = :groupId AND type = 'group' AND "isActive" = true LIMIT 1`,
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!group) throw new NotFoundError('Group not found or admin access required');
            if (String(group.createdBy) !== String(userId)) throw new AuthorizationError('Admin access required');

            const merged = { ...(group.settings || {}), ...settings };
            await sequelize.query(
                `UPDATE chats SET settings = :settings::jsonb, "updatedAt" = NOW() WHERE id = :groupId`,
                { replacements: { settings: JSON.stringify(merged), groupId } }
            );

            return ChatService.getChatDetails(groupId, userId);
        } catch (error) {
            logger.error('Update group settings failed:', error);
            throw error;
        }
    }

    // ── Add group participants ────────────────────────────────────────────────

    static async addGroupParticipants(groupId, userId, participantIds) {
        const sequelize = getDB();
        try {
            if (!Array.isArray(participantIds) || !participantIds.length) {
                throw new ValidationError('Participant IDs are required');
            }

            const [group] = await sequelize.query(
                `SELECT id, "createdBy", settings FROM chats
                 WHERE id = :groupId AND type = 'group' AND "isActive" = true LIMIT 1`,
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!group) throw new NotFoundError('Group not found or admin access required');
            if (String(group.createdBy) !== String(userId)) throw new AuthorizationError('Admin access required');

            const existing = await sequelize.query(
                `SELECT "userId" FROM chat_participants WHERE "chatId" = :groupId`,
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            const existingIds = new Set(existing.map(r => String(r.userId)));

            const maxPax = group.settings?.maxParticipants || MAX_CHAT_PARTICIPANTS;
            if (existingIds.size + participantIds.length > maxPax) {
                throw new ValidationError(`Group cannot have more than ${maxPax} members`);
            }

            const newIds = participantIds.map(safeInt).filter(id => id && !existingIds.has(String(id)));
            if (!newIds.length) throw new ValidationError('All users are already members of the group');

            const found = await sequelize.query(
                `SELECT id FROM "Users" WHERE id IN (:ids)`,
                { replacements: { ids: newIds }, type: sequelize.QueryTypes.SELECT }
            );
            if (found.length !== newIds.length) throw new NotFoundError('One or more users not found');

            const vals = newIds.map(pid => `(${safeInt(groupId)}, ${pid}, NOW(), NOW(), NOW())`).join(',');
            await sequelize.query(
                `INSERT INTO chat_participants ("chatId","userId","joinedAt","createdAt","updatedAt")
                 VALUES ${vals} ON CONFLICT ("chatId","userId") DO NOTHING`
            );

            return {
                group: await ChatService.getChatDetails(groupId, userId),
                addedCount: newIds.length,
                addedUsers: found.map(u => ({ id: u.id })),
            };
        } catch (error) {
            logger.error('Add group participants failed:', error);
            throw error;
        }
    }

    // ── Remove group participant ──────────────────────────────────────────────

    static async removeGroupParticipant(groupId, userId, targetUserId) {
        const sequelize = getDB();
        try {
            const [group] = await sequelize.query(
                `SELECT id, "createdBy" FROM chats
                 WHERE id = :groupId AND type = 'group' AND "isActive" = true LIMIT 1`,
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!group) throw new NotFoundError('Group not found or access denied');

            const isAdmin      = String(group.createdBy)  === String(userId);
            const isSelfRemoval = String(targetUserId)    === String(userId);

            if (!isAdmin && !isSelfRemoval) throw new AuthorizationError('Only admins can remove other members');
            if (String(targetUserId) === String(group.createdBy) && !isSelfRemoval) {
                throw new ValidationError('Cannot remove the group creator');
            }

            await sequelize.query(
                `DELETE FROM chat_participants WHERE "chatId" = :groupId AND "userId" = :targetUserId`,
                { replacements: { groupId, targetUserId } }
            );

            return { groupId, removedUserId: targetUserId, isSelfRemoval };
        } catch (error) {
            logger.error('Remove group participant failed:', error);
            throw error;
        }
    }

    // ── Promote / demote admin ────────────────────────────────────────────────

    static async promoteToAdmin(groupId, userId, targetUserId) {
        const sequelize = getDB();
        try {
            const [group] = await sequelize.query(
                `SELECT id, "createdBy" FROM chats WHERE id = :groupId AND type = 'group' AND "isActive" = true LIMIT 1`,
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!group) throw new NotFoundError('Group not found or admin access required');
            if (String(group.createdBy) !== String(userId)) throw new AuthorizationError('Admin access required');

            await sequelize.query(
                `UPDATE chats SET metadata = jsonb_set(
                    COALESCE(metadata, '{}'),
                    '{admins}',
                    COALESCE(metadata->'admins', '[]'::jsonb) || :uid::jsonb,
                    true
                 ), "updatedAt" = NOW()
                 WHERE id = :groupId`,
                { replacements: { uid: JSON.stringify(safeInt(targetUserId)), groupId } }
            );

            return { groupId, promotedUserId: targetUserId };
        } catch (error) {
            logger.error('Promote to admin failed:', error);
            throw error;
        }
    }

    static async demoteAdmin(groupId, userId, targetUserId) {
        const sequelize = getDB();
        try {
            const [group] = await sequelize.query(
                `SELECT id, "createdBy" FROM chats WHERE id = :groupId AND type = 'group' LIMIT 1`,
                { replacements: { groupId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!group) throw new NotFoundError('Group not found or admin access required');
            if (String(group.createdBy) !== String(userId)) throw new AuthorizationError('Admin access required');
            if (String(targetUserId) === String(userId)) throw new ValidationError('Cannot demote yourself');

            await sequelize.query(
                `UPDATE chats SET metadata = jsonb_set(
                    COALESCE(metadata, '{}'),
                    '{admins}',
                    COALESCE(
                        (SELECT jsonb_agg(elem) FROM jsonb_array_elements(COALESCE(metadata->'admins','[]'::jsonb)) elem
                         WHERE elem::text != :uid),
                        '[]'::jsonb
                    ),
                    true
                 ), "updatedAt" = NOW()
                 WHERE id = :groupId`,
                { replacements: { uid: JSON.stringify(safeInt(targetUserId)), groupId } }
            );

            return { groupId, demotedUserId: targetUserId };
        } catch (error) {
            logger.error('Demote admin failed:', error);
            throw error;
        }
    }

    // ── Archive / unarchive ───────────────────────────────────────────────────

    static async archiveChat(chatId, userId) {
        const sequelize = getDB();
        try {
            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new NotFoundError('Chat not found');

            await sequelize.query(
                `UPDATE chats SET "isArchived" = true, "archivedBy" = :userId, "archivedAt" = NOW(), "updatedAt" = NOW()
                 WHERE id = :chatId`,
                { replacements: { chatId, userId } }
            );

            return { chatId, archivedAt: new Date().toISOString() };
        } catch (error) {
            logger.error('Archive chat failed:', error);
            throw error;
        }
    }

    static async unarchiveChat(chatId, userId) {
        const sequelize = getDB();
        try {
            await sequelize.query(
                `UPDATE chats SET "isArchived" = false, "archivedBy" = NULL, "archivedAt" = NULL, "updatedAt" = NOW()
                 WHERE id = :chatId AND EXISTS (
                   SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId
                 )`,
                { replacements: { chatId, userId } }
            );

            return { chatId, unarchivedAt: new Date().toISOString() };
        } catch (error) {
            logger.error('Unarchive chat failed:', error);
            throw error;
        }
    }

    // ── Search messages ───────────────────────────────────────────────────────

    static async searchChatMessages(chatId, userId, searchOptions = {}) {
        const sequelize = getDB();
        try {
            const { query, page = 1, limit = 20, senderId, dateFrom, dateTo, messageType } = searchOptions;

            if (!query || query.trim().length < 2) throw new ValidationError('Search query must be at least 2 characters');

            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new NotFoundError('Chat not found or access denied');

            const pageNum  = Math.max(1, safeInt(page) || 1);
            const limitNum = Math.min(50, safeInt(limit) || 20);
            const offset   = (pageNum - 1) * limitNum;
            const replacements = { chatId, pattern: `%${query.trim()}%` };
            let extra = '';

            if (senderId)   { extra += ' AND m."senderId" = :senderId';   replacements.senderId = safeInt(senderId); }
            if (messageType){ extra += ' AND m.type = :messageType';       replacements.messageType = messageType; }
            if (dateFrom)   {
                const d = new Date(dateFrom);
                if (!isNaN(d)) { extra += ' AND m."createdAt" >= :dateFrom'; replacements.dateFrom = d.toISOString(); }
            }
            if (dateTo) {
                const d = new Date(dateTo);
                if (!isNaN(d)) { extra += ' AND m."createdAt" <= :dateTo'; replacements.dateTo = d.toISOString(); }
            }

            const messages = await sequelize.query(
                `SELECT m.id, m."chatId", m."senderId", m.content, m.type AS "messageType", m."createdAt",
                        jsonb_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar) AS sender
                 FROM "Messages" m LEFT JOIN "Users" u ON u.id = m."senderId"
                 WHERE m."chatId" = :chatId AND m."isDeleted" = false AND m.content ILIKE :pattern
                 ${extra}
                 ORDER BY m."createdAt" DESC LIMIT ${limitNum} OFFSET ${offset}`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const [{ total }] = await sequelize.query(
                `SELECT COUNT(*) AS total FROM "Messages" m
                 WHERE m."chatId" = :chatId AND m."isDeleted" = false AND m.content ILIKE :pattern ${extra}`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            return {
                messages,
                pagination: {
                    total: parseInt(total, 10),
                    page: pageNum,
                    limit: limitNum,
                    pages: Math.ceil(parseInt(total, 10) / limitNum),
                },
            };
        } catch (error) {
            logger.error('Search chat messages failed:', error);
            throw error;
        }
    }

    // ── Cleanup old messages (background job) ─────────────────────────────────

    static async cleanupOldMessages() {
        const sequelize = getDB();
        try {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - MESSAGE_RETENTION_DAYS);

            const [, meta] = await sequelize.query(
                `UPDATE "Messages"
                 SET "isDeleted" = true, "deletedAt" = NOW(), "deletedBy" = 'system', "updatedAt" = NOW()
                 WHERE "isDeleted" = false AND "createdAt" < :cutoff`,
                { replacements: { cutoff: cutoff.toISOString() } }
            );

            const cleaned = meta?.rowCount || 0;
            logger.info(`Cleaned up ${cleaned} old messages`);
            return { cleaned };
        } catch (error) {
            logger.error('Cleanup old messages failed:', error);
            throw error;
        }
    }

    // ── Chat statistics ───────────────────────────────────────────────────────

    static async getChatStatistics(chatId, userId, period = '30d') {
        const sequelize = getDB();
        try {
            const isParticipant = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!isParticipant || !isParticipant.length) throw new NotFoundError('Chat not found or access denied');

            let days;
            switch (period) {
                case '7d':  days = 7;     break;
                case '30d': days = 30;    break;
                case '90d': days = 90;    break;
                case 'all': days = 99999; break;
                default:    days = 30;
            }
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            const replacements = { chatId, startDate: startDate.toISOString() };

            const dailyStats = await sequelize.query(
                `SELECT TO_CHAR(m."createdAt", 'YYYY-MM-DD') AS day,
                        COUNT(*) AS count,
                        COUNT(DISTINCT m."senderId") AS senders
                 FROM "Messages" m
                 WHERE m."chatId" = :chatId AND m."isDeleted" = false AND m."createdAt" >= :startDate
                 GROUP BY day ORDER BY day ASC`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const topSenders = await sequelize.query(
                `SELECT m."senderId", COUNT(*) AS "messageCount",
                        u.username, u.avatar, MAX(m."createdAt") AS "lastMessage"
                 FROM "Messages" m JOIN "Users" u ON u.id = m."senderId"
                 WHERE m."chatId" = :chatId AND m."isDeleted" = false AND m."createdAt" >= :startDate
                 GROUP BY m."senderId", u.username, u.avatar
                 ORDER BY "messageCount" DESC LIMIT 10`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const messageTypes = await sequelize.query(
                `SELECT type AS "_id", COUNT(*) AS count FROM "Messages"
                 WHERE "chatId" = :chatId AND "isDeleted" = false AND "createdAt" >= :startDate
                 GROUP BY type`,
                { replacements, type: sequelize.QueryTypes.SELECT }
            );

            const [chatInfo] = await sequelize.query(
                `SELECT id, type AS "chatType", name AS "chatName", "createdAt" FROM chats WHERE id = :chatId LIMIT 1`,
                { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
            );

            return {
                period,
                totalMessages: dailyStats.reduce((s, d) => s + parseInt(d.count, 10), 0),
                activeDays:    dailyStats.length,
                uniqueSenders: topSenders.length,
                dailyStats,
                topSenders,
                messageTypes,
                chatInfo,
            };
        } catch (error) {
            logger.error('Get chat statistics failed:', error);
            throw error;
        }
    }

    // ── Wrappers used by chatController.js ───────────────────────────────────

    static async updateChat(chatId, userId, updateData) {
        const sequelize = getDB();
        try {
            const [chat] = await sequelize.query(
                `SELECT id, type, "createdBy" FROM chats WHERE id = :chatId AND "isActive" = true LIMIT 1`,
                { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!chat) throw new NotFoundError('Chat not found');
            if (chat.type !== 'group') throw new ValidationError('Only group chats can be updated');
            if (String(chat.createdBy) !== String(userId)) throw new AuthorizationError('Only group creator can update chat settings');

            const sets = [], replacements = { chatId };
            if (updateData.name        !== undefined) { sets.push('name = :name');               replacements.name        = updateData.name?.trim() || null; }
            if (updateData.description !== undefined) { sets.push('description = :description'); replacements.description = updateData.description?.trim() || null; }
            if (updateData.avatar      !== undefined) { sets.push('avatar = :avatar');           replacements.avatar      = updateData.avatar; }
            sets.push('"updatedAt" = NOW()');

            await sequelize.query(`UPDATE chats SET ${sets.join(', ')} WHERE id = :chatId`, { replacements });
            return ChatService.getChatDetails(chatId, userId);
        } catch (error) {
            logger.error('Update chat failed:', error);
            throw error;
        }
    }

    static async addParticipant(chatId, userId, participantId, role = 'member') {
        return ChatService.addGroupParticipants(chatId, userId, [participantId]);
    }

    static async removeParticipant(chatId, userId, targetUserId) {
        return ChatService.removeGroupParticipant(chatId, userId, targetUserId);
    }

    static async updateParticipantRole(chatId, userId, targetUserId, role) {
        if (role === 'admin') return ChatService.promoteToAdmin(chatId, userId, targetUserId);
        return ChatService.demoteAdmin(chatId, userId, targetUserId);
    }

    static async leaveChat(chatId, userId) {
        return ChatService.removeGroupParticipant(chatId, userId, userId);
    }

    static async deleteChat(chatId, userId) {
        const sequelize = getDB();
        try {
            const [chat] = await sequelize.query(
                `SELECT id, type, "createdBy", metadata FROM chats WHERE id = :chatId AND "isActive" = true LIMIT 1`,
                { replacements: { chatId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!chat) throw new NotFoundError('Chat not found');

            // Verify the user is a participant
            const [participant] = await sequelize.query(
                `SELECT 1 FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId LIMIT 1`,
                { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
            );
            if (!participant) throw new AuthorizationError('Not a participant in this chat');

            if (chat.type === 'group' && String(chat.createdBy) === String(userId)) {
                // Group creator deletes for everyone
                await sequelize.query(
                    `UPDATE chats SET "isActive" = false, "deletedAt" = NOW(), "deletedBy" = :userId, "updatedAt" = NOW()
                     WHERE id = :chatId`,
                    { replacements: { chatId, userId } }
                );
                await sequelize.query(`DELETE FROM chat_participants WHERE "chatId" = :chatId`, { replacements: { chatId } });
            } else {
                // Any user: remove them from participants (hides chat for them only)
                // Store deleted userId in chat metadata so it persists after refresh
                let metadata = {};
                try { metadata = (typeof chat.metadata === 'string' ? JSON.parse(chat.metadata) : chat.metadata) || {}; } catch (_) {}
                const deletedFor = Array.isArray(metadata.deletedFor) ? metadata.deletedFor : [];
                if (!deletedFor.includes(userId)) deletedFor.push(userId);
                metadata.deletedFor = deletedFor;

                await sequelize.query(
                    `UPDATE chats SET metadata = :metadata, "updatedAt" = NOW() WHERE id = :chatId`,
                    { replacements: { metadata: JSON.stringify(metadata), chatId } }
                );
                // Remove them from participants so getUserChats won't return it
                await sequelize.query(
                    `DELETE FROM chat_participants WHERE "chatId" = :chatId AND "userId" = :userId`,
                    { replacements: { chatId, userId } }
                );
            }
            return true;
        } catch (error) {
            logger.error('Delete chat failed:', error);
            throw error;
        }
    }

    static async markAsRead(chatId, userId) {
        const result = await ChatService.markMessagesAsRead(chatId, userId, []);
        return result.markedCount;
    }

    static async getUnreadCount(chatId, userId) {
        const sequelize = getDB();
        return _getUnreadCount(sequelize, chatId, userId);
    }
}

module.exports = ChatService;