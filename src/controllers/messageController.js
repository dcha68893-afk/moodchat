// =============================================================================
// messageController.js — v2.0
// FIXED: Rewired all methods to call the corrected messageService (Sequelize).
// The original controller called messageService.sendMessage(chatId, userId, data, file)
// with a positional signature that did not match what messageService.createMessage()
// expected. Every route that delegated here would throw immediately.
//
// HOW TO USE THIS CONTROLLER:
// In messages.js route file you can optionally delegate to this controller
// instead of using inline handlers. Example:
//   const ctrl = require('../controllers/messageController');
//   router.post('/', ctrl.sendMessage);
//   router.get('/',  ctrl.getMessages);
// The inline handlers in messages.js already work, so this controller is
// provided as the clean-architecture alternative.
// =============================================================================

const messageService = require('../services/messageService');
const { AppError }   = require('../middleware/errorHandler');
const logger         = require('../utils/logger');

// Safe integer parser — prevents NaN from being passed to the DB
const safeInt = (val) => { const n = parseInt(val, 10); return (!isNaN(n) && n > 0) ? n : null; };

class MessageController {

    // POST /api/messages
    async sendMessage(req, res, next) {
        try {
            const userId  = req.user.id;
            const { chatId, content, type = 'text', replyToId } = req.body;

            const safeChatId = safeInt(chatId);
            if (!safeChatId) return res.status(400).json({ success:false, message:'chatId is required' });
            if (!content || !content.trim()) return res.status(400).json({ success:false, message:'content is required' });
            if (content.length > 5000) return res.status(400).json({ success:false, message:'Message too long (max 5000 chars)' });

            const message = await messageService.createMessage({
                chatId: safeChatId,
                senderId: userId,
                content: content.trim(),
                type,
                replyToId: safeInt(replyToId) || null,
            });

            res.status(201).json({ success:true, message:'Message sent successfully', data:{ message } });
        } catch (error) {
            logger.error('Send message controller error:', error);
            next(error);
        }
    }

    // GET /api/messages?chatId=&page=&limit=
    async getMessages(req, res, next) {
        try {
            const userId = req.user.id;
            const chatId = safeInt(req.query.chatId || req.params.chatId);
            if (!chatId) return res.status(400).json({ success:false, message:'chatId is required' });

            const page  = safeInt(req.query.page)  || 1;
            const limit = Math.min(safeInt(req.query.limit) || 50, 100);

            const result = await messageService.getConversationMessages(chatId, userId, page, limit);

            res.json({ success:true, data: result });
        } catch (error) {
            logger.error('Get messages controller error:', error);
            next(error);
        }
    }

    // PATCH /api/messages/:messageId
    async editMessage(req, res, next) {
        try {
            const userId    = req.user.id;
            const messageId = safeInt(req.params.messageId);
            const { content } = req.body;

            if (!messageId) return res.status(400).json({ success:false, message:'Invalid messageId' });
            if (!content || !content.trim()) return res.status(400).json({ success:false, message:'content cannot be empty' });

            const result = await messageService.editMessage(messageId, userId, content);
            res.json({ success:true, message:'Message edited successfully', data: result });
        } catch (error) {
            logger.error('Edit message controller error:', error);
            next(error);
        }
    }

    // DELETE /api/messages/:messageId
    async deleteMessage(req, res, next) {
        try {
            const userId          = req.user.id;
            const messageId       = safeInt(req.params.messageId);
            const deleteForEveryone = req.body.deleteForEveryone === true || req.body.deleteForEveryone === 'true';

            if (!messageId) return res.status(400).json({ success:false, message:'Invalid messageId' });

            await messageService.deleteMessage(messageId, userId, deleteForEveryone);
            res.json({ success:true, message:'Message deleted successfully' });
        } catch (error) {
            logger.error('Delete message controller error:', error);
            next(error);
        }
    }

    // POST /api/messages/:messageId/react
    async addReaction(req, res, next) {
        try {
            const userId    = req.user.id;
            const messageId = safeInt(req.params.messageId);
            const { emoji } = req.body;

            if (!messageId) return res.status(400).json({ success:false, message:'Invalid messageId' });
            if (!emoji)     return res.status(400).json({ success:false, message:'emoji is required' });

            const result = await messageService.addReaction(messageId, userId, emoji);
            res.json({ success:true, message:'Reaction added', data: result });
        } catch (error) {
            logger.error('Add reaction controller error:', error);
            next(error);
        }
    }

    // DELETE /api/messages/:messageId/react
    async removeReaction(req, res, next) {
        try {
            const userId    = req.user.id;
            const messageId = safeInt(req.params.messageId);
            const { emoji } = req.body;

            if (!messageId) return res.status(400).json({ success:false, message:'Invalid messageId' });
            if (!emoji)     return res.status(400).json({ success:false, message:'emoji is required' });

            const result = await messageService.removeReaction(messageId, userId, emoji);
            res.json({ success:true, message:'Reaction removed', data: result });
        } catch (error) {
            logger.error('Remove reaction controller error:', error);
            next(error);
        }
    }

    // POST /api/messages/mark-read/batch
    async markAsRead(req, res, next) {
        try {
            const userId           = req.user.id;
            const { chatId, messageIds } = req.body;
            const safeChatId       = safeInt(chatId);

            if (!safeChatId) return res.status(400).json({ success:false, message:'chatId is required' });

            const result = await messageService.markMessagesAsRead(safeChatId, userId, messageIds || null);
            res.json({ success:true, data: result });
        } catch (error) {
            logger.error('Mark as read controller error:', error);
            next(error);
        }
    }

    // GET /api/messages/:chatId/search?query=&page=&limit=
    async searchMessages(req, res, next) {
        try {
            const userId = req.user.id;
            const chatId = safeInt(req.params.chatId);
            const { query, limit = 20 } = req.query;

            if (!chatId) return res.status(400).json({ success:false, message:'Invalid chatId' });
            if (!query || query.trim().length < 2)
                return res.status(400).json({ success:false, message:'Search query must be at least 2 characters' });

            const messages = await messageService.searchMessages(chatId, userId, query, safeInt(limit)||20);
            res.json({ success:true, data:{ messages, count: messages.length } });
        } catch (error) {
            logger.error('Search messages controller error:', error);
            next(error);
        }
    }

    // GET /api/messages/unread-counts
    async getUnreadCounts(req, res, next) {
        try {
            const userId = req.user.id;
            const counts = await messageService.getUnreadCounts(userId);
            res.json({ success:true, data:{ unreadCounts: counts } });
        } catch (error) {
            logger.error('Get unread counts controller error:', error);
            next(error);
        }
    }
}

module.exports = new MessageController();