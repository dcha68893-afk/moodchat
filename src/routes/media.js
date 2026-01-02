const express = require('express');
const router = express.Router();
const mediaController = require('../controllers/mediaController');
const { paginationValidation } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { uploadSingle, processUploadedFiles } = require('../middleware/upload');

// All routes require authentication except public media access
router.use(authenticate);

// Media management
router.post('/upload', uploadSingle('file'), processUploadedFiles, mediaController.uploadMedia);

router.get('/', paginationValidation, mediaController.getUserMedia);
router.get('/:mediaId', mediaController.getMedia);
router.put('/:mediaId', mediaController.updateMedia);
router.delete('/:mediaId', mediaController.deleteMedia);

// Media processing
router.post('/:mediaId/compress', mediaController.compressMedia);
router.post('/:mediaId/thumbnail', mediaController.generateThumbnail);

// Chat media
router.get('/chat/:chatId', paginationValidation, mediaController.getChatMedia);

// Stats
router.get('/stats', mediaController.getMediaStats);

// Public access (no authentication required)
router.get('/public/:accessToken', mediaController.getPublicMedia);

module.exports = router;
