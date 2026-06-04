import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import mediaService from '../../../src/services/mediaService';
import Media from '../../../src/models/Media';
import User from '../../../src/models/User';
import Chat from '../../../src/models/Chat';

jest.mock('../../../src/models/Media');
jest.mock('../../../src/models/User');
jest.mock('../../../src/models/Chat');
jest.mock('fs/promises');
jest.mock('sharp');

describe('Media Service', () => {
  let mockMedia;
  let mockUser;
  let mockChat;
  let mockFile;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
      storageUsed: 0,
      storageLimit: 1024 * 1024 * 100, // 100MB
      save: jest.fn().mockResolvedValue(true),
    };

    mockChat = {
      _id: '507f1f77bcf86cd799439021',
      participants: [{ user: '507f1f77bcf86cd799439011' }],
    };

    mockMedia = {
      _id: '507f1f77bcf86cd799439061',
      user: '507f1f77bcf86cd799439011',
      chat: '507f1f77bcf86cd799439021',
      filename: 'test.jpg',
      originalName: 'test.jpg',
      mimeType: 'image/jpeg',
      size: 1024 * 1024, // 1MB
      url: '/uploads/test.jpg',
      thumbnailUrl: '/uploads/thumbnails/test.jpg',
      metadata: {
        width: 1920,
        height: 1080,
        duration: null,
      },
      isPublic: false,
      uploadDate: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };

    mockFile = {
      originalname: 'test.jpg',
      mimetype: 'image/jpeg',
      size: 1024 * 1024,
      buffer: Buffer.from('fake image data'),
    };
  });

  describe('uploadMedia', () => {
    it('should upload image successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const chatId = '507f1f77bcf86cd799439021';
      const file = mockFile;

      User.findById.mockResolvedValue(mockUser);
      Chat.findById.mockResolvedValue(mockChat);
      fs.mkdir.mockResolvedValue();
      fs.writeFile.mockResolvedValue();
      
      const sharp = require('sharp');
      sharp.mockReturnValue({
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('thumbnail')),
      });

      Media.create.mockResolvedValue(mockMedia);

      const result = await mediaService.uploadMedia(userId, chatId, file);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(Chat.findById).toHaveBeenCalledWith(chatId);
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledTimes(2); // Original + thumbnail
      expect(Media.create).toHaveBeenCalled();
      expect(mockUser.storageUsed).toBeGreaterThan(0);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.media).toBeDefined();
    });

    it('should upload video successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const chatId = '507f1f77bcf86cd799439021';
      const videoFile = {
        ...mockFile,
        mimetype: 'video/mp4',
        originalname: 'test.mp4',
      };

      User.findById.mockResolvedValue(mockUser);
      Chat.findById.mockResolvedValue(mockChat);
      
      const ffmpeg = require('fluent-ffmpeg');
      const mockFfmpeg = {
        ffprobe: jest.fn().mockImplementation((callback) => {
          callback(null, { format: { duration: 60 }, streams: [{ width: 1920, height: 1080 }] });
        }),
        screenshots: jest.fn().mockReturnThis(),
        on: jest.fn().mockImplementation((event, callback) => {
          if (event === 'end') callback();
          return mockFfmpeg;
        }),
        run: jest.fn(),
      };
      ffmpeg.mockReturnValue(mockFfmpeg);

      fs.writeFile.mockResolvedValue();
      Media.create.mockResolvedValue(mockMedia);

      const result = await mediaService.uploadMedia(userId, chatId, videoFile);

      expect(result.success).toBe(true);
      expect(result.media.metadata.duration).toBe(60);
    });

    it('should fail if storage limit exceeded', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const chatId = '507f1f77bcf86cd799439021';
      const file = {
        ...mockFile,
        size: 1024 * 1024 * 200, // 200MB
      };

      mockUser.storageUsed = mockUser.storageLimit - 1024 * 1024; // 1MB left
      User.findById.mockResolvedValue(mockUser);

      const result = await mediaService.uploadMedia(userId, chatId, file);

      expect(result.success).toBe(false);
      expect(result.error).toContain('storage limit');
    });

    it('should fail if user not in chat', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const chatId = '507f1f77bcf86cd799439021';
      const file = mockFile;

      const unauthorizedChat = {
        ...mockChat,
        participants: [{ user: 'differentUser' }],
      };

      User.findById.mockResolvedValue(mockUser);
      Chat.findById.mockResolvedValue(unauthorizedChat);

      const result = await mediaService.uploadMedia(userId, chatId, file);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a participant');
    });
  });

  describe('getMedia', () => {
    it('should get media by ID', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMedia),
      });

      const result = await mediaService.getMedia(mediaId, userId);

      expect(Media.findById).toHaveBeenCalledWith(mediaId);
      expect(result.success).toBe(true);
      expect(result.media).toBeDefined();
    });

    it('should fail if media not found', async () => {
      const mediaId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await mediaService.getMedia(mediaId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail if user not authorized', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = 'unauthorizedUser';

      const privateMedia = {
        ...mockMedia,
        user: 'differentUser',
        chat: null,
        isPublic: false,
      };

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(privateMedia),
      });

      const result = await mediaService.getMedia(mediaId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorized');
    });
  });

  describe('getChatMedia', () => {
    it('should get chat media with pagination', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const type = 'image';
      const page = 1;
      const limit = 10;

      Chat.findById.mockResolvedValue(mockChat);

      const mockMedias = [mockMedia, { ...mockMedia, _id: '507f1f77bcf86cd799439062' }];

      Media.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockMedias),
      });

      Media.countDocuments.mockResolvedValue(2);

      const result = await mediaService.getChatMedia(chatId, userId, type, page, limit);

      expect(Chat.findById).toHaveBeenCalledWith(chatId);
      expect(Media.find).toHaveBeenCalledWith({
        chat: chatId,
        mimeType: { $regex: '^image/', $options: 'i' },
      });
      expect(result.success).toBe(true);
      expect(result.media).toHaveLength(2);
    });

    it('should get all media types if type not specified', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';

      Chat.findById.mockResolvedValue(mockChat);
      Media.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await mediaService.getChatMedia(chatId, userId);

      expect(Media.find).toHaveBeenCalledWith({
        chat: chatId,
      });
    });
  });

  describe('deleteMedia', () => {
    it('should delete media successfully', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMedia),
      });

      fs.unlink.mockResolvedValue();
      Media.findByIdAndDelete.mockResolvedValue(mockMedia);

      const result = await mediaService.deleteMedia(mediaId, userId);

      expect(fs.unlink).toHaveBeenCalledTimes(2); // Original + thumbnail
      expect(Media.findByIdAndDelete).toHaveBeenCalledWith(mediaId);
      expect(mockUser.storageUsed).toBeLessThan(mockMedia.size);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should handle missing files gracefully', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMedia),
      });

      fs.unlink.mockRejectedValue(new Error('File not found'));
      Media.findByIdAndDelete.mockResolvedValue(mockMedia);

      const result = await mediaService.deleteMedia(mediaId, userId);

      // Should still succeed even if file deletion fails
      expect(result.success).toBe(true);
    });
  });

  describe('updateMediaInfo', () => {
    it('should update media information', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';
      const updates = {
        description: 'Updated description',
        tags: ['vacation', 'beach'],
        isPublic: true,
      };

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMedia),
      });

      const result = await mediaService.updateMediaInfo(mediaId, userId, updates);

      expect(mockMedia.description).toBe(updates.description);
      expect(mockMedia.tags).toEqual(updates.tags);
      expect(mockMedia.isPublic).toBe(updates.isPublic);
      expect(mockMedia.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('compressImage', () => {
    it('should compress image successfully', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';
      const quality = 80;

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMedia),
      });

      const sharp = require('sharp');
      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ size: 1024 * 1024 }),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('compressed')),
      };
      sharp.mockReturnValue(mockSharpInstance);

      fs.readFile.mockResolvedValue(Buffer.from('original'));
      fs.writeFile.mockResolvedValue();
      fs.unlink.mockResolvedValue();

      const result = await mediaService.compressImage(mediaId, userId, quality);

      expect(fs.readFile).toHaveBeenCalled();
      expect(sharp).toHaveBeenCalled();
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({ quality });
      expect(fs.writeFile).toHaveBeenCalled();
      expect(mockMedia.size).toBeLessThan(1024 * 1024);
      expect(mockUser.storageUsed).toBeLessThan(1024 * 1024);
      expect(result.success).toBe(true);
    });

    it('should fail if not an image', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';
      const quality = 80;

      const videoMedia = {
        ...mockMedia,
        mimeType: 'video/mp4',
      };

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(videoMedia),
      });

      const result = await mediaService.compressImage(mediaId, userId, quality);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not an image');
    });
  });

  describe('generateThumbnail', () => {
    it('should generate thumbnail for video', async () => {
      const mediaId = '507f1f77bcf86cd799439061';
      const userId = '507f1f77bcf86cd799439011';
      const timestamp = 30;

      const videoMedia = {
        ...mockMedia,
        mimeType: 'video/mp4',
        metadata: { duration: 120 },
      };

      Media.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(videoMedia),
      });

      const ffmpeg = require('fluent-ffmpeg');
      const mockFfmpeg = {
        screenshots: jest.fn().mockReturnThis(),
        on: jest.fn().mockImplementation((event, callback) => {
          if (event === 'end') callback();
          return mockFfmpeg;
        }),
        run: jest.fn(),
      };
      ffmpeg.mockReturnValue(mockFfmpeg);

      const result = await mediaService.generateThumbnail(mediaId, userId, timestamp);

      expect(mockFfmpeg.screenshots).toHaveBeenCalledWith({
        timestamps: [timestamp],
        filename: expect.any(String),
        folder: expect.any(String),
        size: '320x240',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('getUserStorageInfo', () => {
    it('should get user storage information', async () => {
      const userId = '507f1f77bcf86cd799439011';

      User.findById.mockResolvedValue(mockUser);
      Media.aggregate.mockResolvedValue([
        { _id: 'image', totalSize: 1024 * 1024 * 50 },
        { _id: 'video', totalSize: 1024 * 1024 * 30 },
      ]);

      const result = await mediaService.getUserStorageInfo(userId);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(Media.aggregate).toHaveBeenCalledWith([
        { $match: { user: userId } },
        {
          $group: {
            _id: {
              $cond: [
                { $regexMatch: { input: '$mimeType', regex: /^image\// } },
                'image',
                { $cond: [
                  { $regexMatch: { input: '$mimeType', regex: /^video\// } },
                  'video',
                  'other'
                ]}
              ]
            },
            totalSize: { $sum: '$size' },
            count: { $sum: 1 },
          },
        },
      ]);
      expect(result.success).toBe(true);
      expect(result.storage).toBeDefined();
      expect(result.usageByType).toBeDefined();
    });
  });

  describe('cleanupOrphanedMedia', () => {
    it('should cleanup orphaned media', async () => {
      const daysThreshold = 30;

      const orphanedMedia = [
        { ...mockMedia, _id: 'orphaned1' },
        { ...mockMedia, _id: 'orphaned2' },
      ];

      Media.find.mockResolvedValue(orphanedMedia);
      fs.unlink.mockResolvedValue();
      Media.deleteMany.mockResolvedValue({ deletedCount: 2 });

      const result = await mediaService.cleanupOrphanedMedia(daysThreshold);

      expect(Media.find).toHaveBeenCalledWith({
        chat: null,
        uploadDate: { $lt: expect.any(Date) },
      });
      expect(fs.unlink).toHaveBeenCalledTimes(4); // 2 media × 2 files each
      expect(Media.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ['orphaned1', 'orphaned2'] },
      });
      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(2);
    });
  });
});