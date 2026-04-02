// src/routes/profiles.js
const path = require('path');
const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const { authenticateToken } = require(path.join(__dirname, '../middleware/auth'));
const { apiRateLimiter } = require('../middleware/rateLimiter');
const upload = require('../utils/fileUpload');
const asyncHandler = require('express-async-handler');


// GET /api/profile - get current user profile
router.get('/', apiRateLimiter, asyncHandler(async (req, res) => {
  const userId = req.user.userId || req.user.id;
  // Create a mock request with params for the controller
  req.params = { userId };
  await profileController.getProfile(req, res);
}));

// GET /api/profile - get user profile by ID
router.get('/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
  await profileController.getProfile(req, res);
}));

// PUT /api/profile - update current user profile
router.put('/', apiRateLimiter, asyncHandler(async (req, res) => {
  // Ensure userId is set for the controller
  req.body.userId = req.user.userId || req.user.id;
  await profileController.updateProfile(req, res);
}));

// POST /api/profile/avatar - upload avatar
router.post('/avatar', apiRateLimiter, upload.single('avatar'), asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.uploadProfilePicture(req, res);
}));

// Existing routes - keep as is
router.put('/update', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.updateProfile(req, res);
}));

router.post('/cover', apiRateLimiter, upload.single('cover'), asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.uploadCoverPhoto(req, res);
}));

router.delete('/picture', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.deleteProfilePicture(req, res);
}));

router.delete('/cover', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.deleteCoverPhoto(req, res);
}));

router.put('/privacy', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.updateProfilePrivacy(req, res);
}));

router.get('/views/count', apiRateLimiter, asyncHandler(async (req, res) => {
  req.query.userId = req.user.userId || req.user.id;
  await profileController.getProfileViews(req, res);
}));

router.get('/views/visitors', apiRateLimiter, asyncHandler(async (req, res) => {
  req.query.userId = req.user.userId || req.user.id;
  await profileController.getProfileVisitors(req, res);
}));

router.get('/stats/:userId', apiRateLimiter, asyncHandler(async (req, res) => {
  await profileController.getProfileStatistics(req, res);
}));

router.get('/search', apiRateLimiter, asyncHandler(async (req, res) => {
  await profileController.searchProfiles(req, res);
}));

router.post('/:userId/follow', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.followUser(req, res);
}));

router.delete('/:userId/follow', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.unfollowUser(req, res);
}));

router.get('/:userId/followers', apiRateLimiter, asyncHandler(async (req, res) => {
  await profileController.getFollowers(req, res);
}));

router.get('/:userId/following', apiRateLimiter, asyncHandler(async (req, res) => {
  await profileController.getFollowing(req, res);
}));

router.get('/:userId/mutual', apiRateLimiter, asyncHandler(async (req, res) => {
  req.query.userId = req.user.userId || req.user.id;
  await profileController.getMutualConnections(req, res);
}));

router.post('/:userId/block', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.blockUser(req, res);
}));

router.delete('/:userId/block', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.unblockUser(req, res);
}));

router.get('/blocked/list', apiRateLimiter, asyncHandler(async (req, res) => {
  req.query.userId = req.user.userId || req.user.id;
  await profileController.getBlockedUsers(req, res);
}));

router.post('/:userId/report', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.reporterId = req.user.userId || req.user.id;
  await profileController.reportProfile(req, res);
}));

router.post('/:userId/verify', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.verifyProfile(req, res);
}));

router.get('/:userId/verification', apiRateLimiter, asyncHandler(async (req, res) => {
  await profileController.getVerificationStatus(req, res);
}));

router.get('/export/data', apiRateLimiter, asyncHandler(async (req, res) => {
  req.query.userId = req.user.userId || req.user.id;
  await profileController.exportProfileData(req, res);
}));

router.post('/change-password', apiRateLimiter, asyncHandler(async (req, res) => {
  req.body.userId = req.user.userId || req.user.id;
  await profileController.changePassword(req, res);
}));

module.exports = router;