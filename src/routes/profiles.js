
const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const upload = require('../utils/fileUpload');

router.use(authenticate);

router.get('/:userId', apiRateLimiter, profileController.getProfile);
router.put('/update', apiRateLimiter, profileController.updateProfile);
router.post('/picture', apiRateLimiter, upload.single('avatar'), profileController.uploadProfilePicture);
router.post('/cover', apiRateLimiter, upload.single('cover'), profileController.uploadCoverPhoto);
router.delete('/picture', apiRateLimiter, profileController.deleteProfilePicture);
router.delete('/cover', apiRateLimiter, profileController.deleteCoverPhoto);
router.put('/privacy', apiRateLimiter, profileController.updateProfilePrivacy);
router.get('/views/count', apiRateLimiter, profileController.getProfileViews);
router.get('/views/visitors', apiRateLimiter, profileController.getProfileVisitors);
router.get('/stats/:userId', apiRateLimiter, profileController.getProfileStatistics);
router.get('/search', apiRateLimiter, profileController.searchProfiles);
router.post('/:userId/follow', apiRateLimiter, profileController.followUser);
router.delete('/:userId/follow', apiRateLimiter, profileController.unfollowUser);
router.get('/:userId/followers', apiRateLimiter, profileController.getFollowers);
router.get('/:userId/following', apiRateLimiter, profileController.getFollowing);
router.get('/:userId/mutual', apiRateLimiter, profileController.getMutualConnections);
router.post('/:userId/block', apiRateLimiter, profileController.blockUser);
router.delete('/:userId/block', apiRateLimiter, profileController.unblockUser);
router.get('/blocked/list', apiRateLimiter, profileController.getBlockedUsers);
router.post('/:userId/report', apiRateLimiter, profileController.reportProfile);
router.post('/:userId/verify', apiRateLimiter, profileController.verifyProfile);
router.get('/:userId/verification', apiRateLimiter, profileController.getVerificationStatus);
router.get('/export/data', apiRateLimiter, profileController.exportProfileData);
router.post('/change-password', apiRateLimiter, profileController.changePassword);

module.exports = router;