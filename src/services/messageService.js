// =============================================================================
// messageService.js  — v2.1 (Real-time WebSocket delivery added)
// FIXED: After createMessage(), emit 'message:new' via webSocketService
// so the receiver's screen updates instantly without polling.
// =============================================================================

const { ValidationError, NotFoundError, ServerError } = require('../utils/errors');

function getDB() {
    try { return require('../models').sequelize; }
    catch (e) { throw new ServerError('Database not available'); }
}

// Safe reference to webSocketService — won't crash if not available
function getWS() {
    try { return require('./webSocketService'); }
    catch (e) { return null; }
}

const MESSAGE_LIMIT = parseInt(process.env.MESSAGE_LIMIT_PER_PAGE, 10) || 50;

class MessageService {

    async createMessage(messageData) {
        const sequelize = getDB();
        const { chatId, senderId, content, type = 'text', replyToId } = messageData;

        // CRITICAL SECURITY: Validate all required fields
        if (!chatId || !senderId || (!content && type === 'text')) {
            throw new ValidationError('chatId, senderId, and content are required');
        }
        
        // CRITICAL SECURITY: Prevent undefined/null values
        if (chatId === undefined || chatId === null || 
            senderId === undefined || senderId === null) {
            throw new ValidationError('Invalid chatId or senderId - undefined/null not allowed');
        }
        
        // CRITICAL SECURITY: Sanitize content
        const sanitizedContent = content ? content.toString().trim().substring(0, 5000) : '';
        if (type === 'text' && !sanitizedContent) {
            throw new ValidationError('Content cannot be empty for text messages');
        }

        const validTypes = ['text','image','video','audio','file','document','system'];
        if (!validTypes.includes(type)) throw new ValidationError(`Invalid message type: ${type}`);
        if (type === 'text' && sanitizedContent.length > 5000) throw new ValidationError('Message too long (max 5000 chars)');

        // CRITICAL SECURITY: Verify sender is a participant with proper authorization
        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:senderId LIMIT 1`,
            { replacements: { chatId, senderId }, type: sequelize.QueryTypes.SELECT }
        );
        if (!participant) throw new ValidationError('Sender is not a participant in this chat');

        // CRITICAL SECURITY: Use parameterized query to prevent SQL injection
        const [rows] = await sequelize.query(
            `INSERT INTO "Messages"
               ("chatId","senderId",content,type,reactions,"isEdited","isDeleted","sentAt","deliveredAt","createdAt","updatedAt")
             VALUES (:chatId,:senderId,:content,:type,'{}',false,false,NOW(),NOW(),NOW(),NOW())
             RETURNING *`,
            { replacements: { chatId, senderId, content: sanitizedContent, type },
              type: sequelize.QueryTypes.INSERT }
        );
        
        // CRITICAL SECURITY: Ensure message was actually created
        if (!rows || !rows[0] || !rows[0].id) {
            throw new ServerError('Failed to create message - database returned invalid data');
        }
        
        const message = rows[0];

        // Update chat's lastMessageId and lastMessageAt
        await sequelize.query(
            `UPDATE chats SET "updatedAt"=NOW(),"lastMessageId"=:mid,"lastMessageAt"=NOW() WHERE id=:chatId`,
            { replacements: { mid: message.id, chatId } }
        );

        // Attach sender info
        const [sender] = await sequelize.query(
            `SELECT id,username,avatar,"firstName","lastName" FROM "Users" WHERE id=:senderId`,
            { replacements: { senderId }, type: sequelize.QueryTypes.SELECT }
        );
        message.sender = sender || null;

        // CRITICAL SECURITY: Real-time delivery with error handling
        await this._emitMessageToParticipants(chatId, senderId, message, sequelize);

        console.log(`[MessageService] ✅ Message created successfully: ${message.id} for chat ${chatId}`);
        return message;
    }

    /**
     * After a message is saved, push it to every other participant via WebSocket.
     * This is what makes the receiver's screen update without a page reload.
     */
    async _emitMessageToParticipants(chatId, senderId, message, sequelize) {
        const ws = getWS();
        if (!ws) {
            console.warn('[MessageService] ⚠️ webSocketService not available — no real-time delivery');
            return;
        }

        try {
            // CRITICAL SECURITY: Get all participant userIds for this chat
            const participants = await sequelize.query(
                `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId"=:chatId AND "userId" != :senderId`,
                { replacements: { chatId, senderId }, type: sequelize.QueryTypes.SELECT }
            );
            
            if (!participants || participants.length === 0) {
                console.warn(`[MessageService] ⚠️ No other participants found for chat ${chatId}`);
                return;
            }

            // CRITICAL SECURITY: Validate message data before broadcasting
            const payload = {
                id:           message.id,
                chatId:       message.chatId,
                conversationId: message.chatId,
                senderId:     message.senderId,
                content:      message.content,
                type:         message.type,
                sender:       message.sender,
                createdAt:    message.createdAt,
                sentAt:       message.sentAt,
                deliveredAt:  new Date().toISOString()
            };
            
            // CRITICAL SECURITY: Validate payload integrity
            if (!payload.id || !payload.chatId || !payload.senderId) {
                console.error('[MessageService] ❌ Invalid message payload - missing required fields');
                return;
            }

            // Check blocked relationships before delivering
            let blockedUserIds = new Set();
            try {
                const { isBlocked } = require('./friendService');
                for (const { userId } of participants) {
                    const blocked = await isBlocked(senderId, userId);
                    if (blocked) blockedUserIds.add(String(userId));
                }
            } catch(_) { /* friendService unavailable – deliver to all */ }

            // Get Socket.IO instance directly for reliable delivery
            const io = ws.getIO();
            if (io) {
                // Use Socket.IO for real-time delivery to all participants
                for (const { userId } of participants) {
                    // CRITICAL: skip blocked users
                    if (blockedUserIds.has(String(userId))) continue;
                    // Send to user's Socket.IO room
                    io.to(`user:${userId}`).emit('message:new', payload);
                    io.to(`user_${userId}`).emit('new_message', payload);
                }
                // Also broadcast to chat room
                io.to(`chat:${chatId}`).emit('message:new', payload);
                // FIX Bug7: one summary log instead of per-recipient spam
                console.log(`[MessageService] ✅ Real-time delivery: chatId=${chatId}, recipients=${participants.length}`);
                console.log(`[MessageService] 📤 Emitting to rooms:`, participants.map(p => [`user:${p.userId}`, `user_${p.userId}`]).flat());
                console.log(`[MessageService] 📤 Message payload:`, { id: payload.id, chatId: payload.chatId, senderId: payload.senderId, content: payload.content?.substring(0, 50) });
            } else {
                // Fallback to raw WebSocket service
                for (const { userId } of participants) {
                    await ws.sendToUser(userId, 'message:new', payload);
                    await ws.sendToUser(userId, 'new_message', payload);
                }
                console.log(`[MessageService] ⚠️ Fallback WS delivery: chatId=${chatId}, recipients=${participants.length}`);
            }
        } catch (err) {
            // Real-time failure is non-fatal — message is already saved
            console.error('[MessageService] Real-time delivery error:', err.message);
        }
    }

    async getConversationMessages(chatId, userId, page = 1, limit = MESSAGE_LIMIT) {
        const sequelize = getDB();
        if (!chatId || !userId) throw new ValidationError('chatId and userId are required');

        page  = Math.max(1, parseInt(page,10)||1);
        limit = Math.min(100, Math.max(1, parseInt(limit,10)||MESSAGE_LIMIT));

        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:userId LIMIT 1`,
            { replacements: { chatId, userId }, type: sequelize.QueryTypes.SELECT }
        );
        if (!participant) throw new ValidationError('User is not a participant in this chat');

        const offset = (page-1)*limit;

        const messages = await sequelize.query(
            `SELECT m.id,m."chatId",m."senderId",m.content,
                    m.type AS "messageType",m.reactions,m."isEdited",
                    m."editedAt",m."isDeleted",m."sentAt",m."createdAt",m."updatedAt",
                    jsonb_build_object('id',u.id,'username',u.username,'avatar',u.avatar) AS sender
             FROM "Messages" m
             LEFT JOIN "Users" u ON u.id=m."senderId"
             WHERE m."chatId"=:chatId AND m."isDeleted"=false
             ORDER BY m."createdAt" DESC LIMIT :limit OFFSET :offset`,
            { replacements:{chatId,limit,offset}, type: sequelize.QueryTypes.SELECT }
        );

        const [{total}] = await sequelize.query(
            `SELECT COUNT(*) AS total FROM "Messages" WHERE "chatId"=:chatId AND "isDeleted"=false`,
            { replacements:{chatId}, type: sequelize.QueryTypes.SELECT }
        );
        const totalCount = parseInt(total,10);

        return {
            messages: messages.reverse(),
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalCount/limit),
                totalMessages: totalCount,
                hasNext: page < Math.ceil(totalCount/limit),
                hasPrevious: page > 1,
            }
        };
    }

    async markMessagesAsRead(chatId, userId, messageIds = null) {
        const sequelize = getDB();
        if (!chatId||!userId) throw new ValidationError('chatId and userId are required');

        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:userId LIMIT 1`,
            { replacements:{chatId,userId}, type: sequelize.QueryTypes.SELECT }
        );
        if (!participant) throw new ValidationError('Access denied');

        if (messageIds && messageIds.length > 0) {
            const safeIds = messageIds.map(id=>parseInt(id,10)).filter(n=>!isNaN(n));
            for (const msgId of safeIds) {
                await sequelize.query(
                    `INSERT INTO "ReadReceipts"("messageId","userId","readAt","createdAt","updatedAt")
                     VALUES(:msgId,:userId,NOW(),NOW(),NOW())
                     ON CONFLICT("messageId","userId") DO NOTHING`,
                    { replacements:{msgId,userId} }
                ).catch(()=>{});
            }
            return { success:true, markedCount: safeIds.length };
        }

        const [{count}] = await sequelize.query(
            `SELECT COUNT(*) AS count FROM "Messages"
             WHERE "chatId"=:chatId AND "senderId"!=:userId AND "isDeleted"=false`,
            { replacements:{chatId,userId}, type: sequelize.QueryTypes.SELECT }
        );
        return { success:true, markedCount: parseInt(count,10) };
    }

    async deleteMessage(messageId, userId, deleteForEveryone = false) {
        const sequelize = getDB();
        if (!messageId||!userId) throw new ValidationError('messageId and userId are required');

        const [message] = await sequelize.query(
            `SELECT id,"chatId","senderId" FROM "Messages" WHERE id=:messageId AND "isDeleted"=false LIMIT 1`,
            { replacements:{messageId}, type: sequelize.QueryTypes.SELECT }
        );
        if (!message) throw new NotFoundError('Message not found');

        if (deleteForEveryone) {
            const [chat] = await sequelize.query(
                `SELECT "createdBy" FROM chats WHERE id=:chatId LIMIT 1`,
                { replacements:{chatId:message.chatId}, type: sequelize.QueryTypes.SELECT }
            );
            if (chat?.createdBy !== userId && message.senderId !== userId)
                throw new ValidationError('Not authorised to delete for everyone');
        } else if (message.senderId !== userId) {
            throw new ValidationError('Only the sender can delete their own message');
        }

        await sequelize.query(
            `UPDATE "Messages" SET "isDeleted"=true,"deletedAt"=NOW(),"deletedBy"=:userId,"updatedAt"=NOW()
             WHERE id=:messageId`,
            { replacements:{userId,messageId} }
        );

        // PHASE10: Record tombstone in entity store + hydration engine BEFORE broadcast
        try {
            global.__MessageEntityStore?.recordDelete?.(messageId, message.chatId, 'deleted');
            global.__HydrationEngine?.recordDeletion?.('message', messageId, message.chatId, 'deleted');
        } catch(_) {}

        // Notify chat participants of deletion - using full broadcast to user rooms
        const ws = getWS();
        if (ws) {
            const delPayload = {
                messageId, messageIds: [messageId],
                chatId: message.chatId, deletedBy: userId, deleteForEveryone,
                _tombstone: true, ts: Date.now()
            };
            if (typeof ws.broadcastToChatFull === 'function') {
                ws.broadcastToChatFull(message.chatId, 'message:deleted', delPayload).catch(() => {
                    if (typeof ws.broadcastToChat === 'function') ws.broadcastToChat(message.chatId, 'message:deleted', delPayload);
                });
            } else if (typeof ws.broadcastToChat === 'function') {
                ws.broadcastToChat(message.chatId, 'message:deleted', delPayload);
            }
        }

        return { success:true, message:'Message deleted successfully' };
    }

    async getUnreadCounts(userId) {
        const sequelize = getDB();
        if (!userId) throw new ValidationError('userId is required');

        const rows = await sequelize.query(
            `SELECT m."chatId", COUNT(*) AS count
             FROM "Messages" m
             JOIN chat_participants cp ON cp."chatId"=m."chatId" AND cp."userId"=:userId
             WHERE m."senderId"!=:userId AND m."isDeleted"=false
               AND NOT EXISTS (
                   SELECT 1 FROM "ReadReceipts" rr WHERE rr."messageId"=m.id AND rr."userId"=:userId
               )
             GROUP BY m."chatId"`,
            { replacements:{userId}, type: sequelize.QueryTypes.SELECT }
        ).catch(()=>[]);

        const result = {};
        rows.forEach(r=>{ result[r.chatId]=parseInt(r.count,10); });
        return result;
    }

    async searchMessages(chatId, userId, query, limit = 20) {
        const sequelize = getDB();
        if (!chatId||!userId||!query) throw new ValidationError('chatId, userId, and query are required');

        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:userId LIMIT 1`,
            { replacements:{chatId,userId}, type: sequelize.QueryTypes.SELECT }
        );
        if (!participant) throw new ValidationError('User cannot access this chat');

        const safeLimit = Math.min(50, Math.max(1, parseInt(limit,10)||20));

        return await sequelize.query(
            `SELECT m.id,m."chatId",m."senderId",m.content,m.type,m."createdAt",
                    jsonb_build_object('id',u.id,'username',u.username,'avatar',u.avatar) AS sender
             FROM "Messages" m
             LEFT JOIN "Users" u ON u.id=m."senderId"
             WHERE m."chatId"=:chatId AND m."isDeleted"=false AND m.content ILIKE :pattern
             ORDER BY m."createdAt" DESC LIMIT :limit`,
            { replacements:{chatId, pattern:`%${query.trim()}%`, limit:safeLimit},
              type: sequelize.QueryTypes.SELECT }
        );
    }

    async editMessage(messageId, userId, newContent) {
        const sequelize = getDB();
        if (!messageId||!userId) throw new ValidationError('messageId and userId are required');
        if (!newContent?.trim()) throw new ValidationError('Content cannot be empty');

        const [message] = await sequelize.query(
            `SELECT id,"senderId","createdAt","chatId" FROM "Messages"
             WHERE id=:messageId AND "isDeleted"=false LIMIT 1`,
            { replacements:{messageId}, type: sequelize.QueryTypes.SELECT }
        );
        if (!message) throw new NotFoundError('Message not found');
        if (message.senderId !== userId) throw new ValidationError('Only the sender can edit this message');

        if (Date.now() - new Date(message.createdAt).getTime() > 15 * 60 * 1000)
            throw new ValidationError('Message can only be edited within 15 minutes of sending');

        await sequelize.query(
            `UPDATE "Messages" SET content=:content,"isEdited"=true,"editedAt"=NOW(),"updatedAt"=NOW()
             WHERE id=:messageId`,
            { replacements:{content:newContent.trim(),messageId} }
        );

        // Broadcast edit
        const ws = getWS();
        if (ws && typeof ws.broadcastToChat === 'function') {
            ws.broadcastToChat(message.chatId, 'message:edited', {
                messageId, chatId: message.chatId, content: newContent.trim(), editedAt: new Date().toISOString()
            });
        }

        return { success:true, messageId, content:newContent.trim(), editedAt:new Date().toISOString() };
    }

    async addReaction(messageId, userId, emoji) { return this._toggleReaction(messageId,userId,emoji,'add'); }
    async removeReaction(messageId, userId, emoji) { return this._toggleReaction(messageId,userId,emoji,'remove'); }

    async _toggleReaction(messageId, userId, emoji, action) {
        const sequelize = getDB();
        if (!messageId||!userId||!emoji) throw new ValidationError('messageId, userId, and emoji required');

        const [message] = await sequelize.query(
            `SELECT id,"chatId",reactions FROM "Messages" WHERE id=:messageId AND "isDeleted"=false LIMIT 1`,
            { replacements:{messageId}, type: sequelize.QueryTypes.SELECT }
        );
        if (!message) throw new NotFoundError('Message not found');

        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:userId LIMIT 1`,
            { replacements:{chatId:message.chatId,userId}, type: sequelize.QueryTypes.SELECT }
        );
        if (!participant) throw new ValidationError('Access denied');

        const reactions = message.reactions || {};
        const key = emoji.trim().substring(0,10);

        if (action==='add') {
            if (!reactions[key]) reactions[key]=[];
            Object.keys(reactions).forEach(k=>{ if(k!==key) reactions[k]=reactions[k].filter(id=>id!==userId); });
            if (!reactions[key].includes(userId)) reactions[key].push(userId);
        } else {
            if (reactions[key]) {
                reactions[key]=reactions[key].filter(id=>id!==userId);
                if (!reactions[key].length) delete reactions[key];
            }
        }

        await sequelize.query(
            `UPDATE "Messages" SET reactions=:reactions::jsonb,"updatedAt"=NOW() WHERE id=:messageId`,
            { replacements:{reactions:JSON.stringify(reactions),messageId} }
        );

        // Broadcast reaction
        const ws = getWS();
        if (ws && typeof ws.broadcastToChat === 'function') {
            ws.broadcastToChat(message.chatId, 'message:reaction', { messageId, chatId: message.chatId, reactions });
        }

        return { success:true, messageId, reactions };
    }
}

module.exports = new MessageService();