const mediaService = require('../services/mediaService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class MediaController {
  async uploadMedia(req, res, next) {
    try {
      const userId = req.user.id;

      if (!req.file) {
        throw new AppError('No file uploaded', 400);
      }

      const media = await mediaService.uploadMedia(userId, req.file, req.body);

      res.status(201).json({
        success: true,
        message: 'Media uploaded successfully',
        data: {
          media,
        },
      });
    } catch (error) {
      logger.error('Upload media controller error:', error);
      next(error);
    }
  }

  async getMedia(req, res, next) {
    try {
      const userId = req.user.id;
      const { mediaId } = req.params;

      const media = await mediaService.getMedia(parseInt(mediaId), userId);

      res.json({
        success: true,
        data: {
          media,
        },
      });
    } catch (error) {
      logger.error('Get media controller error:', error);
      next(error);
    }
  }

  async getPublicMedia(req, res, next) {
    try {
      const { accessToken } = req.params;

      const media = await mediaService.getMediaByAccessToken(accessToken);

      res.json({
        success: true,
        data: {
          media,
        },
      });
    } catch (error) {
      logger.error('Get public media controller error:', error);
      next(error);
    }
  }

  async getUserMedia(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20, type, startDate, endDate } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (type) {
        options.type = type;
      }

      if (startDate) {
        options.startDate = new Date(startDate);
      }

      if (endDate) {
        options.endDate = new Date(endDate);
      }

      const media = await mediaService.getUserMedia(userId, options);

      res.json({
        success: true,
        data: {
          media,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: media.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get user media controller error:', error);
      next(error);
    }
  }

  async getChatMedia(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.params;
      const { page = 1, limit = 20, type } = req.query;

      const options = {
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (type) {
        options.where = { type };
      }

      const media = await mediaService.getChatMedia(parseInt(chatId), userId, options);

      res.json({
        success: true,
        data: {
          media,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: media.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get chat media controller error:', error);
      next(error);
    }
  }

  async updateMedia(req, res, next) {
    try {
      const userId = req.user.id;
      const { mediaId } = req.params;
      const updateData = req.body;

      const media = await mediaService.updateMedia(parseInt(mediaId), userId, updateData);

      res.json({
        success: true,
        message: 'Media updated successfully',
        data: {
          media,
        },
      });
    } catch (error) {
      logger.error('Update media controller error:', error);
      next(error);
    }
  }

  async deleteMedia(req, res, next) {
    try {
      const userId = req.user.id;
      const { mediaId } = req.params;

      await mediaService.deleteMedia(parseInt(mediaId), userId);

      res.json({
        success: true,
        message: 'Media deleted successfully',
      });
    } catch (error) {
      logger.error('Delete media controller error:', error);
      next(error);
    }
  }

  async compressMedia(req, res, next) {
    try {
      const userId = req.user.id;
      const { mediaId } = req.params;
      const { quality = 80 } = req.body;

      const media = await mediaService.compressMedia(parseInt(mediaId), userId, quality);

      res.json({
        success: true,
        message: 'Media compressed successfully',
        data: {
          media,
        },
      });
    } catch (error) {
      logger.error('Compress media controller error:', error);
      next(error);
    }
  }

  async generateThumbnail(req, res, next) {
    try {
      const userId = req.user.id;
      const { mediaId } = req.params;

      const media = await mediaService.generateThumbnailForMedia(parseInt(mediaId), userId);

      res.json({
        success: true,
        message: 'Thumbnail generated successfully',
        data: {
          media,
        },
      });
    } catch (error) {
      logger.error('Generate thumbnail controller error:', error);
      next(error);
    }
  }

  async getMediaStats(req, res, next) {
    try {
      const userId = req.user.id;

      const stats = await mediaService.getMediaStats(userId);

      res.json({
        success: true,
        data: {
          stats,
        },
      });
    } catch (error) {
      logger.error('Get media stats controller error:', error);
      next(error);
    }
  }
}

module.exports = new MediaController();
