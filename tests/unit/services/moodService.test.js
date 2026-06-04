import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import moodService from '../../../src/services/moodService';
import Mood from '../../../src/models/Mood';
import User from '../../../src/models/User';
import redisClient from '../../../src/config/redis';

jest.mock('../../../src/models/Mood');
jest.mock('../../../src/models/User');
jest.mock('../../../src/config/redis');

describe('Mood Service', () => {
  let mockMood;
  let mockUser;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
      mood: null,
      save: jest.fn().mockResolvedValue(true),
    };

    mockMood = {
      _id: '507f1f77bcf86cd799439051',
      user: '507f1f77bcf86cd799439011',
      mood: 'happy',
      intensity: 8,
      note: 'Having a great day!',
      tags: ['productive', 'energetic'],
      isPublic: true,
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue({
        ...mockMood,
        user: mockUser,
      }),
    };
  });

  describe('setMood', () => {
    it('should set mood successfully', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const moodData = {
        mood: 'happy',
        intensity: 8,
        note: 'Feeling great!',
        tags: ['productive'],
        isPublic: true,
      };

      User.findById.mockResolvedValue(mockUser);
      Mood.create.mockResolvedValue(mockMood);
      redisClient.publish.mockResolvedValue(1);

      const result = await moodService.setMood(userId, moodData);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(Mood.create).toHaveBeenCalledWith({
        user: userId,
        ...moodData,
      });
      expect(mockUser.mood).toBe(mockMood._id);
      expect(mockUser.save).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.mood).toBeDefined();
    });

    it('should fail if user not found', async () => {
      const userId = 'nonexistent';
      const moodData = { mood: 'happy' };

      User.findById.mockResolvedValue(null);

      const result = await moodService.setMood(userId, moodData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should validate mood intensity', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const moodData = {
        mood: 'happy',
        intensity: 15, // Invalid
      };

      User.findById.mockResolvedValue(mockUser);

      const result = await moodService.setMood(userId, moodData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('intensity');
    });
  });

  describe('getCurrentMood', () => {
    it('should get current mood', async () => {
      const userId = '507f1f77bcf86cd799439011';

      User.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue({
          ...mockUser,
          mood: mockMood,
        }),
      });

      const result = await moodService.getCurrentMood(userId);

      expect(User.findById).toHaveBeenCalledWith(userId);
      expect(result.success).toBe(true);
      expect(result.mood).toBeDefined();
    });

    it('should return null if no mood set', async () => {
      const userId = '507f1f77bcf86cd799439011';

      User.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockUser),
      });

      const result = await moodService.getCurrentMood(userId);

      expect(result.success).toBe(true);
      expect(result.mood).toBeNull();
    });
  });

  describe('getMoodHistory', () => {
    it('should get mood history with pagination', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      const page = 1;
      const limit = 10;

      const mockMoods = [mockMood, { ...mockMood, _id: '507f1f77bcf86cd799439052' }];

      Mood.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(mockMoods),
      });

      Mood.countDocuments.mockResolvedValue(2);

      const result = await moodService.getMoodHistory(userId, startDate, endDate, page, limit);

      expect(Mood.find).toHaveBeenCalledWith({
        user: userId,
        createdAt: {
          $gte: startDate,
          $lte: endDate,
        },
      });
      expect(result.success).toBe(true);
      expect(result.moods).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
    });

    it('should filter by mood type', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const moodType = 'happy';

      Mood.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await moodService.getMoodHistory(userId, null, null, 1, 10, moodType);

      expect(Mood.find).toHaveBeenCalledWith({
        user: userId,
        mood: moodType,
      });
    });
  });

  describe('updateMood', () => {
    it('should update mood successfully', async () => {
      const moodId = '507f1f77bcf86cd799439051';
      const userId = '507f1f77bcf86cd799439011';
      const updates = {
        note: 'Updated note',
        intensity: 9,
        tags: ['updated'],
      };

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMood),
      });

      const result = await moodService.updateMood(moodId, userId, updates);

      expect(Mood.findById).toHaveBeenCalledWith(moodId);
      expect(mockMood.note).toBe(updates.note);
      expect(mockMood.intensity).toBe(updates.intensity);
      expect(mockMood.tags).toEqual(updates.tags);
      expect(mockMood.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if mood not found', async () => {
      const moodId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';
      const updates = { note: 'Updated' };

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await moodService.updateMood(moodId, userId, updates);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail if user not authorized', async () => {
      const moodId = '507f1f77bcf86cd799439051';
      const userId = 'unauthorizedUser';
      const updates = { note: 'Updated' };

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMood),
      });

      const result = await moodService.updateMood(moodId, userId, updates);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorized');
    });
  });

  describe('deleteMood', () => {
    it('should delete mood successfully', async () => {
      const moodId = '507f1f77bcf86cd799439051';
      const userId = '507f1f77bcf86cd799439011';

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMood),
      });

      const result = await moodService.deleteMood(moodId, userId);

      expect(Mood.findByIdAndDelete).toHaveBeenCalledWith(moodId);
      expect(mockUser.mood).toBeNull();
      expect(mockUser.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should handle deletion of non-current mood', async () => {
      const moodId = '507f1f77bcf86cd799439051';
      const userId = '507f1f77bcf86cd799439011';

      const differentMood = {
        ...mockMood,
        _id: 'differentMoodId',
      };

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(differentMood),
      });

      User.findById.mockResolvedValue(mockUser);

      const result = await moodService.deleteMood(moodId, userId);

      expect(Mood.findByIdAndDelete).toHaveBeenCalledWith(moodId);
      expect(mockUser.mood).not.toBeNull(); // Should not clear if different mood
      expect(result.success).toBe(true);
    });
  });

  describe('getFriendMoods', () => {
    it('should get friends moods', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const page = 1;
      const limit = 10;

      mockUser.friends = ['507f1f77bcf86cd799439012', '507f1f77bcf86cd799439013'];

      User.findById.mockResolvedValue(mockUser);

      Mood.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockMood]),
      });

      Mood.countDocuments.mockResolvedValue(1);

      const result = await moodService.getFriendMoods(userId, page, limit);

      expect(Mood.find).toHaveBeenCalledWith({
        user: { $in: mockUser.friends },
        isPublic: true,
      });
      expect(result.success).toBe(true);
      expect(result.moods).toHaveLength(1);
    });

    it('should return empty if no friends', async () => {
      const userId = '507f1f77bcf86cd799439011';

      mockUser.friends = [];

      User.findById.mockResolvedValue(mockUser);

      Mood.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      const result = await moodService.getFriendMoods(userId);

      expect(result.success).toBe(true);
      expect(result.moods).toHaveLength(0);
    });
  });

  describe('getMoodAnalytics', () => {
    it('should get mood analytics', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');

      Mood.aggregate.mockResolvedValue([
        { _id: 'happy', count: 10 },
        { _id: 'sad', count: 5 },
        { _id: 'neutral', count: 15 },
      ]);

      const result = await moodService.getMoodAnalytics(userId, startDate, endDate);

      expect(Mood.aggregate).toHaveBeenCalledWith([
        {
          $match: {
            user: userId,
            createdAt: {
              $gte: startDate,
              $lte: endDate,
            },
          },
        },
        {
          $group: {
            _id: '$mood',
            count: { $sum: 1 },
            avgIntensity: { $avg: '$intensity' },
          },
        },
        { $sort: { count: -1 } },
      ]);
      expect(result.success).toBe(true);
      expect(result.analytics).toBeDefined();
    });

    it('should get weekly trends', async () => {
      const userId = '507f1f77bcf86cd799439011';

      Mood.aggregate.mockResolvedValue([
        { _id: { week: 1, mood: 'happy' }, count: 5 },
        { _id: { week: 1, mood: 'sad' }, count: 2 },
      ]);

      const result = await moodService.getMoodAnalytics(userId, null, null, 'weekly');

      expect(result.success).toBe(true);
      expect(result.trends).toBeDefined();
    });
  });

  describe('shareMood', () => {
    it('should toggle mood visibility', async () => {
      const moodId = '507f1f77bcf86cd799439051';
      const userId = '507f1f77bcf86cd799439011';
      const isPublic = false;

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockMood),
      });

      const result = await moodService.shareMood(moodId, userId, isPublic);

      expect(mockMood.isPublic).toBe(isPublic);
      expect(mockMood.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if mood not found', async () => {
      const moodId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';

      Mood.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await moodService.shareMood(moodId, userId, true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});