// =============================================================================
// messageService.js  — v2.0 (Sequelize / PostgreSQL)
// FIXED: Replaced Mongoose (MongoDB) implementation with Sequelize queries to
// match the PostgreSQL database used by every other part of the application.
// The original file used mongoose.Types.ObjectId, .findById(), $addToSet, etc.
// — none of which exist in Sequelize — so the entire service was dead code.
// =============================================================================

const { ValidationError, NotFoundError, ServerError } = require('../utils/errors');

function getDB() {
    try { return require('../models').sequelize; }
    catch (e) { throw new ServerError('Database not available'); }
}

const MESSAGE_LIMIT = parseInt(process.env.MESSAGE_LIMIT_PER_PAGE, 10) || 50;

class MessageService {

    async createMessage(messageData) {
        const sequelize = getDB();
        const { chatId, senderId, content, type = 'text' } = messageData;

        if (!chatId || !senderId || (!content && type === 'text'))
            throw new ValidationError('chatId, senderId, and content are required');

        const validTypes = ['text','image','video','audio','file','document','system'];
        if (!validTypes.includes(type)) throw new ValidationError(`Invalid message type: ${type}`);
        if (type === 'text' && content.length > 5000) throw new ValidationError('Message too long (max 5000 chars)');

        const [participant] = await sequelize.query(
            `SELECT 1 FROM chat_participants WHERE "chatId"=:chatId AND "userId"=:senderId LIMIT 1`,
            { replacements: { chatId, senderId }, type: sequelize.QueryTypes.SELECT }
        );
        if (!participant) throw new ValidationError('Sender is not a participant in this chat');

        const [rows] = await sequelize.query(
            `INSERT INTO "Messages"
               ("chatId","senderId",content,type,reactions,"isEdited","isDeleted","sentAt","deliveredAt","createdAt","updatedAt")
             VALUES (:chatId,:senderId,:content,:type,'{}',false,false,NOW(),NOW(),NOW(),NOW())
             RETURNING *`,
            { replacements: { chatId, senderId, content: (content||'').trim(), type },
              type: sequelize.QueryTypes.INSERT }
        );
        const message = rows[0];

        await sequelize.query(
            `UPDATE chats SET "updatedAt"=NOW(),"lastMessageId"=:mid WHERE id=:chatId`,
            { replacements: { mid: message.id, chatId } }
        );

        const [sender] = await sequelize.query(
            `SELECT id,username,avatar,"firstName","lastName" FROM "Users" WHERE id=:senderId`,
            { replacements: { senderId }, type: sequelize.QueryTypes.SELECT }
        );
        message.sender = sender || null;
        return message;
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
            `SELECT id,"senderId","createdAt" FROM "Messages"
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
        return { success:true, messageId, reactions };
    }
}

module.exports = new MessageService();