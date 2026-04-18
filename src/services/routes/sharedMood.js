const path = require('path');
const express = require('express');
const router = express.Router();
const sharedMoodController = require('../controllers/sharedMoodController');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
// Apply authentication to all routes


// Share a mood
router.post('/share', apiRateLimiter, sharedMoodController.shareMood);

// Get user's mood history
router.get('/history/:userId', apiRateLimiter, sharedMoodController.getMoodHistory);

// Get current mood of a user
router.get('/current/:userId', apiRateLimiter, sharedMoodController.getCurrentMood);

// Get mood insights
router.get('/insights', apiRateLimiter, sharedMoodController.getMoodInsights);

// React to a mood
router.post('/:moodId/react', apiRateLimiter, sharedMoodController.reactToMood);

// Comment on a mood
router.post('/:moodId/comment', apiRateLimiter, sharedMoodController.commentOnMood);

// Get mood comments
router.get('/:moodId/comments', apiRateLimiter, sharedMoodController.getMoodComments);

// Delete a mood
router.delete('/:moodId', apiRateLimiter, sharedMoodController.deleteMood);

// Get mood statistics
router.get('/stats/:userId', apiRateLimiter, sharedMoodController.getMoodStatistics);

// Get shared moods feed
router.get('/feed', apiRateLimiter, sharedMoodController.getMoodFeed);

// Set mood privacy
router.put('/:moodId/privacy', apiRateLimiter, sharedMoodController.setMoodPrivacy);

// Search moods by emotion
router.get('/search/emotion', apiRateLimiter, sharedMoodController.searchMoodsByEmotion);

// Get mood trends
router.get('/trends', apiRateLimiter, sharedMoodController.getMoodTrends);

// Export mood data
router.get('/export/:userId', apiRateLimiter, sharedMoodController.exportMoodData);

module.exports = router;