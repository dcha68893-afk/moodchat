const path = require('path');
const express = require('express');
const router = express.Router();
const { apiRateLimiter } = require('../middleware/rateLimiter');
const searchController = require('../controllers/searchController');

// All routes are protected by parent auth middleware in server.js
// No need for router.use(authenticate) as parent handles it

console.log('✅ Search routes initialized');

// Global search
router.get('/global', apiRateLimiter, searchController.globalSearch);

// Search messages
router.get('/messages', apiRateLimiter, searchController.searchMessages);
router.get('/messages/:chatId', apiRateLimiter, searchController.searchChatMessages);

// Search users
router.get('/users', apiRateLimiter, searchController.searchUsers);
router.get('/users/online', apiRateLimiter, searchController.searchOnlineUsers);
router.get('/users/nearby', apiRateLimiter, searchController.searchNearbyUsers);

// Search groups
router.get('/groups', apiRateLimiter, searchController.searchGroups);
router.get('/groups/public', apiRateLimiter, searchController.searchPublicGroups);
router.get('/groups/joined', apiRateLimiter, searchController.searchJoinedGroups);

// Search channels
router.get('/channels', apiRateLimiter, searchController.searchChannels);
router.get('/channels/public', apiRateLimiter, searchController.searchPublicChannels);
router.get('/channels/subscribed', apiRateLimiter, searchController.searchSubscribedChannels);

// Search files
router.get('/files', apiRateLimiter, searchController.searchFiles);
router.get('/files/images', apiRateLimiter, searchController.searchImages);
router.get('/files/documents', apiRateLimiter, searchController.searchDocuments);
router.get('/files/media', apiRateLimiter, searchController.searchMedia);

// Search notes
router.get('/notes', apiRateLimiter, searchController.searchNotes);
router.get('/notes/pinned', apiRateLimiter, searchController.searchPinnedNotes);
router.get('/notes/archived', apiRateLimiter, searchController.searchArchivedNotes);

// Search contacts
router.get('/contacts', apiRateLimiter, searchController.searchContacts);
router.get('/contacts/frequent', apiRateLimiter, searchController.searchFrequentContacts);

// Search events
router.get('/events', apiRateLimiter, searchController.searchEvents);
router.get('/events/upcoming', apiRateLimiter, searchController.searchUpcomingEvents);
router.get('/events/past', apiRateLimiter, searchController.searchPastEvents);

// Search tasks
router.get('/tasks', apiRateLimiter, searchController.searchTasks);
router.get('/tasks/completed', apiRateLimiter, searchController.searchCompletedTasks);
router.get('/tasks/pending', apiRateLimiter, searchController.searchPendingTasks);

// Search bookmarks
router.get('/bookmarks', apiRateLimiter, searchController.searchBookmarks);

// Search history
router.get('/history', apiRateLimiter, searchController.searchHistory);
router.get('/history/recent', apiRateLimiter, searchController.searchRecentHistory);
router.get('/history/clear', apiRateLimiter, searchController.clearSearchHistory);

// Advanced search
router.post('/advanced', apiRateLimiter, searchController.advancedSearch);

// Search by location
router.get('/location', apiRateLimiter, searchController.searchByLocation);

// Search by date
router.get('/date', apiRateLimiter, searchController.searchByDate);

// Search by tags
router.get('/tags', apiRateLimiter, searchController.searchByTags);
router.get('/tags/popular', apiRateLimiter, searchController.getPopularTags);

// Search by category
router.get('/category', apiRateLimiter, searchController.searchByCategory);

// Search suggestions
router.get('/suggestions', apiRateLimiter, searchController.getSearchSuggestions);
router.get('/autocomplete', apiRateLimiter, searchController.getAutocomplete);

// Search filters
router.post('/filters', apiRateLimiter, searchController.getSearchFilters);
router.post('/filters/save', apiRateLimiter, searchController.saveSearchFilter);
router.get('/filters/saved', apiRateLimiter, searchController.getSavedFilters);
router.delete('/filters/:filterId', apiRateLimiter, searchController.deleteSearchFilter);

// Search statistics
router.get('/stats/popular', apiRateLimiter, searchController.getPopularSearches);
router.get('/stats/trending', apiRateLimiter, searchController.getTrendingSearches);

// Search index management
router.post('/index/rebuild', apiRateLimiter, searchController.rebuildSearchIndex);
router.get('/index/status', apiRateLimiter, searchController.getIndexStatus);

// Real-time search
router.get('/realtime', apiRateLimiter, searchController.realtimeSearch);

// Voice search
router.post('/voice', apiRateLimiter, searchController.voiceSearch);

// Image search
router.post('/image', apiRateLimiter, searchController.imageSearch);

// Search sharing
router.post('/share', apiRateLimiter, searchController.shareSearch);
router.get('/shared/:shareId', apiRateLimiter, searchController.getSharedSearch);

// Search export
router.post('/export', apiRateLimiter, searchController.exportSearchResults);

// Search notifications
router.post('/notify', apiRateLimiter, searchController.setupSearchNotification);
router.get('/notifications', apiRateLimiter, searchController.getSearchNotifications);
router.delete('/notifications/:notificationId', apiRateLimiter, searchController.deleteSearchNotification);

module.exports = router;