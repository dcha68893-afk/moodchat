const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  NotFoundError,
  ValidationError,
  AuthorizationError,
} = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { Media, User, Chat, Message } = require('../models');
const config = require('../config/index');

router.use(authenticate);

// Ensure upload directories exist
const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// Use config values for upload paths
const UPLOAD_PATH = config.uploadPath || './uploads';
const UPLOAD_TEMP_DIR = config.uploadTempDir || path.join(UPLOAD_PATH, 'temp');
const UPLOAD_MEDIA_DIR = config.uploadMediaDir || path.join(UPLOAD_PATH, 'media');

ensureDirExists(UPLOAD_PATH);
ensureDirExists(UPLOAD_TEMP_DIR);
ensureDirExists(UPLOAD_MEDIA_DIR);

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter based on config
const ALLOWED_FILE_TYPES = config.uploadAllowedTypes?.split(',') || [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/mpeg',
  'audio/mpeg',
  'audio/wav',
  'application/pdf',
  'text/plain'
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_FILE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`File type ${file.mimetype} is not allowed. Allowed types: ${ALLOWED_FILE_TYPES.join(', ')}`), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: config.uploadMaxSize || 10 * 1024 * 1024, // 10MB default
  }
});

console.log('✅ Media routes initialized');

// Upload media
router.post(
  '/upload',
  apiRateLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    try {
      if (!req.file) {
        throw new ValidationError('No file uploaded');
      }

      const { description, isPublic = false, tags } = req.body;

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      // Determine file type
      let fileType = 'other';
      if (req.file.mimetype.startsWith('image/')) {
        fileType = 'image';
      } else if (req.file.mimetype.startsWith('video/')) {
        fileType = 'video';
      } else if (req.file.mimetype.startsWith('audio/')) {
        fileType = 'audio';
      } else if (req.file.mimetype === 'application/pdf') {
        fileType = 'document';
      }

      // Move file from temp to permanent location
      const finalFilename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(req.file.originalname)}`;
      const finalPath = path.join(UPLOAD_MEDIA_DIR, finalFilename);
      
      fs.renameSync(req.file.path, finalPath);

      // Generate thumbnail for images
      let thumbnailPath = null;
      if (fileType === 'image') {
        const thumbnailFilename = `thumb-${finalFilename}`;
        thumbnailPath = path.join(UPLOAD_MEDIA_DIR, thumbnailFilename);
        // In production, you'd use sharp or another library to create thumbnail
        // For now, we'll copy the original as thumbnail
        fs.copyFileSync(finalPath, thumbnailPath);
      }

      const media = await Media.create({
        userId: req.user.id,
        originalName: req.file.originalname,
        fileName: finalFilename,
        filePath: finalPath,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        fileType: fileType,
        thumbnailPath: thumbnailPath,
        description: description || null,
        isPublic: isPublic,
        tags: tags ? tags.split(',').map(tag => tag.trim()) : [],
        metadata: {
          uploadedAt: new Date(),
          uploadedBy: {
            id: user.id,
            username: user.username,
          },
          dimensions: req.file.size, // Would be actual dimensions for images/videos
        }
      });

      const mediaResponse = media.toJSON();
      mediaResponse.url = `${config.mediaBaseUrl || '/api/media'}/${media.id}`;
      mediaResponse.thumbnailUrl = thumbnailPath ? `${config.mediaBaseUrl || '/api/media'}/${media.id}/thumbnail` : null;

      res.status(201).json({
        status: 'success',
        message: 'Media uploaded successfully',
        data: { media: mediaResponse },
      });
    } catch (error) {
      console.error('Error uploading media:', error);
      // Clean up temp file if it exists
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to upload media'
      });
    }
  })
);

// Get user's media
router.get(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { page = 1, limit = 20, type, sortBy = 'createdAt', sortOrder = 'DESC' } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const where = { userId: req.user.id };

      if (type) {
        where.fileType = type;
      }

      const { count, rows: mediaItems } = await Media.findAndCountAll({
        where,
        order: [[sortBy, sortOrder]],
        offset,
        limit: parseInt(limit),
      });

      const mediaWithUrls = mediaItems.map(media => {
        const mediaObj = media.toJSON();
        mediaObj.url = `${config.mediaBaseUrl || '/api/media'}/${media.id}`;
        mediaObj.thumbnailUrl = media.thumbnailPath ? `${config.mediaBaseUrl || '/api/media'}/${media.id}/thumbnail` : null;
        return mediaObj;
      });

      res.status(200).json({
        status: 'success',
        data: {
          media: mediaWithUrls,
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching user media:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user media'
      });
    }
  })
);

// Get specific media
router.get(
  '/:mediaId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { mediaId } = req.params;

      const media = await Media.findOne({
        where: {
          id: mediaId,
          [require('sequelize').Op.or]: [
            { userId: req.user.id },
            { isPublic: true }
          ]
        }
      });

      if (!media) {
        throw new NotFoundError('Media not found or access denied');
      }

      const mediaObj = media.toJSON();
      mediaObj.url = `${config.mediaBaseUrl || '/api/media'}/${media.id}`;
      mediaObj.thumbnailUrl = media.thumbnailPath ? `${config.mediaBaseUrl || '/api/media'}/${media.id}/thumbnail` : null;

      res.status(200).json({
        status: 'success',
        data: { media: mediaObj },
      });
    } catch (error) {
      console.error('Error fetching media:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to fetch media'
      });
    }
  })
);

// Update media
router.put(
  '/:mediaId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { mediaId } = req.params;
      const { description, isPublic, tags } = req.body;

      const media = await Media.findOne({
        where: {
          id: mediaId,
          userId: req.user.id
        }
      });

      if (!media) {
        throw new NotFoundError('Media not found or not authorized');
      }

      const updates = {};
      if (description !== undefined) updates.description = description;
      if (isPublic !== undefined) updates.isPublic = isPublic;
      if (tags !== undefined) updates.tags = tags.split(',').map(tag => tag.trim());

      await media.update(updates);

      const updatedMedia = media.toJSON();
      updatedMedia.url = `${config.mediaBaseUrl || '/api/media'}/${media.id}`;
      updatedMedia.thumbnailUrl = media.thumbnailPath ? `${config.mediaBaseUrl || '/api/media'}/${media.id}/thumbnail` : null;

      res.status(200).json({
        status: 'success',
        message: 'Media updated successfully',
        data: { media: updatedMedia },
      });
    } catch (error) {
      console.error('Error updating media:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to update media'
      });
    }
  })
);

// Delete media
router.delete(
  '/:mediaId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { mediaId } = req.params;

      const media = await Media.findOne({
        where: {
          id: mediaId,
          userId: req.user.id
        }
      });

      if (!media) {
        throw new NotFoundError('Media not found or not authorized');
      }

      // Delete file from storage
      if (fs.existsSync(media.filePath)) {
        fs.unlinkSync(media.filePath);
      }
      
      if (media.thumbnailPath && fs.existsSync(media.thumbnailPath)) {
        fs.unlinkSync(media.thumbnailPath);
      }

      await media.destroy();

      res.status(200).json({
        status: 'success',
        message: 'Media deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting media:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to delete media'
      });
    }
  })
);

// Get chat media
router.get(
  '/chat/:chatId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { chatId } = req.params;
      const { page = 1, limit = 20, type } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const chat = await Chat.findOne({
        where: {
          id: chatId,
          '$participants.id$': req.user.id
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id'],
          through: { attributes: [] },
          required: true
        }]
      });

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      const messages = await Message.findAll({
        where: {
          chatId: chatId,
          messageType: { [require('sequelize').Op.in]: ['image', 'video', 'audio', 'file'] }
        },
        include: [{
          model: Media,
          as: 'messageMedia',
          required: true,
          where: type ? { fileType: type } : undefined
        }],
        order: [['createdAt', 'DESC']],
        offset,
        limit: parseInt(limit),
      });

      const mediaItems = messages
        .map(msg => msg.messageMedia)
        .filter(media => media !== null);

      const mediaWithUrls = mediaItems.map(media => {
        const mediaObj = media.toJSON();
        mediaObj.url = `${config.mediaBaseUrl || '/api/media'}/${media.id}`;
        mediaObj.thumbnailUrl = media.thumbnailPath ? `${config.mediaBaseUrl || '/api/media'}/${media.id}/thumbnail` : null;
        return mediaObj;
      });

      res.status(200).json({
        status: 'success',
        data: {
          media: mediaWithUrls,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching chat media:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch chat media'
      });
    }
  })
);

// Get media stats
router.get(
  '/stats',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const stats = await Media.findAll({
        where: { userId: req.user.id },
        attributes: [
          'fileType',
          [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
          [require('sequelize').fn('SUM', require('sequelize').col('fileSize')), 'totalSize']
        ],
        group: ['fileType'],
        raw: true
      });

      const totalStats = await Media.findOne({
        where: { userId: req.user.id },
        attributes: [
          [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'totalCount'],
          [require('sequelize').fn('SUM', require('sequelize').col('fileSize')), 'totalSize']
        ],
        raw: true
      });

      res.status(200).json({
        status: 'success',
        data: {
          byType: stats,
          total: {
            count: parseInt(totalStats?.totalCount || 0),
            size: parseInt(totalStats?.totalSize || 0),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching media stats:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch media stats'
      });
    }
  })
);

// Public access endpoint
router.get(
  '/public/:accessToken',
  asyncHandler(async (req, res) => {
    try {
      const { accessToken } = req.params;

      // In a real implementation, you'd validate the access token
      // For now, we'll just get public media
      const media = await Media.findOne({
        where: {
          isPublic: true,
          // You could also check accessToken against a separate access tokens table
        }
      });

      if (!media) {
        throw new NotFoundError('Media not found or access denied');
      }

      if (!fs.existsSync(media.filePath)) {
        throw new NotFoundError('Media file not found');
      }

      // Stream the file
      const fileStream = fs.createReadStream(media.filePath);
      res.setHeader('Content-Type', media.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${media.originalName}"`);
      
      fileStream.pipe(res);
    } catch (error) {
      console.error('Error serving public media:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Failed to serve media'
      });
    }
  })
);

module.exports = router;