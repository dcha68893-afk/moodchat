const path = require('path');
const express = require('express');
const router = express.Router();
const chatParticipantController = require('../controllers/chatParticipantController');
const { apiRateLimiter } = require('../middleware/rateLimiter');

console.log('✅ Chats Participant routes initialized');

// Get chat participants
router.get('/:chatId/participants', apiRateLimiter, chatParticipantController.getChatParticipants);

// Add participant to chat
router.post('/:chatId/participants', apiRateLimiter, chatParticipantController.addParticipantToChat);

// Remove participant from chat
router.delete('/:chatId/participants/:participantId', apiRateLimiter, chatParticipantController.removeParticipantFromChat);

// Get participant details
router.get('/:chatId/participants/:participantId', apiRateLimiter, chatParticipantController.getParticipantDetails);

// Update participant settings
router.put('/:chatId/settings', apiRateLimiter, chatParticipantController.updateParticipantSettings);

// Leave chat
router.post('/:chatId/leave', apiRateLimiter, chatParticipantController.leaveChat);

// Mute chat notifications
router.post('/:chatId/mute', apiRateLimiter, chatParticipantController.muteChat);

// Unmute chat notifications
router.delete('/:chatId/mute', apiRateLimiter, chatParticipantController.unmuteChat);

// Get participant's read status
router.get('/:chatId/participants/:participantId/read', apiRateLimiter, chatParticipantController.getReadStatus);

// Update last read message
router.put('/:chatId/read', apiRateLimiter, chatParticipantController.updateLastRead);

// Get participant's typing status
router.get('/:chatId/typing', apiRateLimiter, chatParticipantController.getTypingStatus);

// Update typing status
router.put('/:chatId/typing', apiRateLimiter, chatParticipantController.updateTypingStatus);

// Get participant's presence status
router.get('/:chatId/participants/:participantId/presence', apiRateLimiter, chatParticipantController.getPresenceStatus);

// Update participant's presence
router.put('/:chatId/presence', apiRateLimiter, chatParticipantController.updatePresence);

// Check if user is participant in chat
router.get('/:chatId/check', apiRateLimiter, chatParticipantController.checkParticipant);

// Get participant statistics
router.get('/:chatId/statistics', apiRateLimiter, chatParticipantController.getParticipantStatistics);

// Search participants in chat
router.get('/:chatId/search', apiRateLimiter, chatParticipantController.searchParticipants);

// Get online participants
router.get('/:chatId/online', apiRateLimiter, chatParticipantController.getOnlineParticipants);

module.exports = router;