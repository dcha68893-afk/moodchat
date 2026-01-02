const express = require('express');
const router = express.Router();
const moodController = require('../controllers/moodController');
const { moodValidation, paginationValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Mood management
router.post('/', moodValidation.createMood, moodController.createMood);
router.get('/', paginationValidation, moodController.getUserMoods);
router.get('/public', paginationValidation, moodController.getPublicMoods);
router.get('/:moodId', moodController.getMoodById);
router.put('/:moodId', moodController.updateMood);
router.delete('/:moodId', moodController.deleteMood);

// Mood sharing
router.post('/:moodId/share', moodController.shareMoodWithFriend);
router.get('/shared', paginationValidation, moodController.getSharedMoods);
router.post('/shared/:sharedMoodId/view', moodController.markSharedMoodAsViewed);

// Analytics
router.get('/stats', moodController.getMoodStats);
router.get('/trend', moodController.getMoodTrend);

module.exports = router;
