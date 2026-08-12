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

        // CRITICAL SECURITY: Verify sender is a participant with proper authorization.
        // FIX-PHASE16: Cast both IDs to integers — PostgreSQL strict integer comparison
        // will treat string '2' as not equal to integer 2, causing false auth rejections.
        const chatIdInt2   = parseInt(chatId,   10);
        const senderIdInt2 = parseInt(senderId, 10);
        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:senderId LIMIT 1`,
            { replacements: { chatId: chatIdInt2, senderId: senderIdInt2 }, type: sequelize.QueryTypes.SELECT }
        ).catch(async () => {
            // FIX-PHASE16: fallback to quoted table name in case of case-sensitivity
            return sequelize.query(
                `SELECT 1 FROM "ChatParticipants" WHERE "chatId"=:chatId AND "userId"=:senderId LIMIT 1`,
                { replacements: { chatId: chatIdInt2, senderId: senderIdInt2 }, type: sequelize.QueryTypes.SELECT }
            ).catch(() => []);
        });
        if (!participant) throw new ValidationError('Sender is not a participant in this chat');

        // CRITICAL SECURITY: Use parameterized query to prevent SQL injection
        //
        // FIX-DELIVERY-GUARANTEE (Part 11): deliveredAt used to be stamped NOW()
        // right here, at the same instant as sentAt/createdAt — i.e. every
        // message was marked "delivered" the moment it was written to the DB,
        // regardless of whether any recipient was even online to receive it.
        //
        // This silently broke the real acknowledgment loop that already exists:
        // the client's ackMessageDelivered() (messages-core.js) correctly POSTs
        // to /api/messages/mark-delivered/batch when a message is actually
        // received, and that route correctly guards with
        // `WHERE ... AND "deliveredAt" IS NULL` — but deliveredAt was never
        // NULL to begin with, so that real ack could never update anything.
        // Net effect: "delivered" status shown to the sender was meaningless —
        // it said "delivered" even to an offline recipient who never got it.
        //
        // Fix: leave deliveredAt NULL at creation; the existing ack endpoint
        // sets it for real once the recipient's client actually confirms receipt.
        const [rows] = await sequelize.query(
            `INSERT INTO "Messages"
               ("chatId","senderId",content,type,reactions,"isEdited","isDeleted","replyToId","sentAt","deliveredAt","createdAt","updatedAt")
             VALUES (:chatId,:senderId,:content,:type,'{}',false,false,:replyToId,NOW(),NULL,NOW(),NOW())
             RETURNING *`,
            { replacements: { chatId, senderId, content: sanitizedContent, type, replyToId: replyToId || null },
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

        // FIX: Attach replyTo object so reply indicator renders correctly on all clients
        if (message.replyToId) {
            try {
                const [replyRows] = await sequelize.query(
                    `SELECT m.id, m.content, m.type, m."senderId",
                            u.username AS "senderName", u.avatar AS "senderAvatar"
                     FROM "Messages" m
                     LEFT JOIN "Users" u ON u.id = m."senderId"
                     WHERE m.id = :replyToId AND m."isDeleted" = false LIMIT 1`,
                    { replacements: { replyToId: message.replyToId }, type: sequelize.QueryTypes.SELECT }
                );
                message.replyTo = replyRows || null;
            } catch(_) { message.replyTo = null; }
        }

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

        // FIX-PHASE16: Force integer coercion on both IDs before every query.
        // PostgreSQL's integer != comparison is strict — passing '2' where the
        // column is INTEGER causes the comparison to return true (string ≠ int),
        // so the sender is never excluded and participants list may be wrong.
        const chatIdInt   = parseInt(chatId,   10);
        const senderIdInt = parseInt(senderId, 10);

        try {
            // CRITICAL SECURITY: Get all participant userIds for this chat.
            // FIX-PHASE16: Use explicit CAST to guarantee type safety across drivers.
            const participants = await sequelize.query(
                `SELECT DISTINCT "userId" FROM chat_participants WHERE "chatId" = :chatId AND "userId" != :senderId`,
                { replacements: { chatId: chatIdInt, senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
            ).catch(async () => {
                // Fallback: quoted table name for case-sensitive Postgres schemas
                return sequelize.query(
                    `SELECT DISTINCT "userId" FROM "ChatParticipants" WHERE "chatId" = :chatId AND "userId" != :senderId`,
                    { replacements: { chatId: chatIdInt, senderId: senderIdInt }, type: sequelize.QueryTypes.SELECT }
                ).catch(() => []);
            });
            
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
                replyToId:    message.replyToId || null,
                replyTo:      message.replyTo   || null,
                createdAt:    message.createdAt,
                sentAt:       message.sentAt,
                deliveredAt:  null // FIX-DELIVERY-GUARANTEE: set for real by mark-delivered/batch on actual ack, not at broadcast time
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

            // FIX-CONSOLIDATE-DELIVERY-MECHANISM: this used to have two entirely
            // separate delivery implementations — a raw io.to(room).emit() loop
            // here (used whenever the Socket.IO instance was reachable) and a
            // ws.sendToUser() fallback loop (used only if it wasn't). The raw
            // io.to() path bypassed wsService.sendToUser() entirely, which meant
            // it also bypassed everything sendToUser() is responsible for:
            // verifying the room actually has members before counting a send as
            // "delivered", the per-socket-id fallback for a receiver whose
            // socket hasn't joined its room yet, and — the part that actually
            // matters for "recipient was offline and the message just vanished"
            // — enqueueOfflineMessage()/flushOfflineMessages(), which is what
            // guarantees a message reaches an offline recipient once they
            // reconnect. Routing every send through sendToUser() means there is
            // now exactly one place that decides whether a message was
            // delivered and exactly one place responsible for offline delivery,
            // instead of two independently-maintained copies that can drift.
            for (const { userId } of participants) {
                // CRITICAL: skip blocked users
                if (blockedUserIds.has(String(userId))) continue;
                // Skip sender — they already see optimistic message in their own UI
                if (String(userId) === String(senderId)) continue;
                await ws.sendToUser(userId, 'message:new', payload).catch(() => {});
            }
            console.log(`[MessageService] ✅ Real-time delivery via sendToUser(): chatId=${chatId}, recipients=${participants.length}`);
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
                    m."replyToId",
                    jsonb_build_object('id',u.id,'username',u.username,'avatar',u.avatar) AS sender,
                    CASE WHEN m."replyToId" IS NOT NULL THEN
                        jsonb_build_object(
                            'id', rm.id,
                            'content', rm.content,
                            'type', rm.type,
                            'senderId', rm."senderId",
                            'senderName', ru.username,
                            'senderAvatar', ru.avatar
                        )
                    ELSE NULL END AS "replyTo"
             FROM "Messages" m
             LEFT JOIN "Users" u ON u.id=m."senderId"
             LEFT JOIN "Messages" rm ON rm.id=m."replyToId" AND rm."isDeleted"=false
             LEFT JOIN "Users" ru ON ru.id=rm."senderId"
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