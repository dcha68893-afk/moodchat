const userController = require('../../../src/controllers/userController');
const userService = require('../../../src/services/userService');
const { validationResult } = require('express-validator');

jest.mock('../../../src/services/userService');
jest.mock('express-validator');

describe('User Controller', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      user: {},
      params: {},
      body: {},
      query: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
    validationResult.mockReturnValue({
      isEmpty: jest.fn().mockReturnValue(true),
      array: jest.fn().mockReturnValue([])
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getCurrentUser', () => {
    it('should return current user profile', async () => {
      const mockUser = {
        id: '123',
        email: 'test@example.com',
        username: 'testuser',
        profile: { bio: 'Test bio' }
      };

      req.user = { id: '123' };
      userService.getUserProfile.mockResolvedValue(mockUser);

      await userController.getCurrentUser(req, res, next);

      expect(userService.getUserProfile).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockUser
      });
    });

    it('should handle user not found', async () => {
      const error = new Error('User not found');
      userService.getUserProfile.mockRejectedValue(error);

      await userController.getCurrentUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'User not found'
      });
    });
  });

  describe('updateProfile', () => {
    it('should update profile successfully', async () => {
      const updatedUser = {
        id: '123',
        firstName: 'Updated',
        lastName: 'Name',
        bio: 'Updated bio'
      };

      req.user = { id: '123' };
      req.body = {
        firstName: 'Updated',
        lastName: 'Name',
        bio: 'Updated bio'
      };

      userService.updateUserProfile.mockResolvedValue(updatedUser);

      await userController.updateProfile(req, res, next);

      expect(userService.updateUserProfile).toHaveBeenCalledWith('123', {
        firstName: 'Updated',
        lastName: 'Name',
        bio: 'Updated bio'
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedUser,
        message: 'Profile updated successfully'
      });
    });

    it('should handle validation errors', async () => {
      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'firstName', message: 'Invalid first name' }])
      });

      await userController.updateProfile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Validation failed',
        details: [{ field: 'firstName', message: 'Invalid first name' }]
      });
    });
  });

  describe('updateAvatar', () => {
    it('should update avatar successfully', async () => {
      const updatedUser = {
        id: '123',
        avatarUrl: 'https://example.com/avatar.jpg'
      };

      req.user = { id: '123' };
      req.file = { path: '/uploads/avatar.jpg' };
      userService.updateAvatar.mockResolvedValue(updatedUser);

      await userController.updateAvatar(req, res, next);

      expect(userService.updateAvatar).toHaveBeenCalledWith('123', '/uploads/avatar.jpg');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedUser,
        message: 'Avatar updated successfully'
      });
    });

    it('should handle missing file', async () => {
      req.user = { id: '123' };
      req.file = null;

      await userController.updateAvatar(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'No file uploaded'
      });
    });

    it('should handle invalid file type', async () => {
      req.user = { id: '123' };
      req.file = { path: '/uploads/avatar.exe' };

      userService.updateAvatar.mockRejectedValue(new Error('Invalid file type'));

      await userController.updateAvatar(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      req.user = { id: '123' };
      req.body = {
        currentPassword: 'OldPassword123!',
        newPassword: 'NewPassword123!',
        confirmPassword: 'NewPassword123!'
      };

      userService.changeUserPassword.mockResolvedValue();

      await userController.changePassword(req, res, next);

      expect(userService.changeUserPassword).toHaveBeenCalledWith(
        '123',
        'OldPassword123!',
        'NewPassword123!'
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Password changed successfully'
      });
    });

    it('should handle incorrect current password', async () => {
      const error = new Error('Current password is incorrect');
      userService.changeUserPassword.mockRejectedValue(error);

      await userController.changePassword(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Current password is incorrect'
      });
    });
  });

  describe('deleteAccount', () => {
    it('should delete account successfully', async () => {
      req.user = { id: '123' };
      req.body = { password: 'Password123!' };

      userService.deleteUserAccount.mockResolvedValue();

      await userController.deleteAccount(req, res, next);

      expect(userService.deleteUserAccount).toHaveBeenCalledWith('123', 'Password123!');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Account deleted successfully'
      });
    });

    it('should handle incorrect password', async () => {
      const error = new Error('Incorrect password');
      userService.deleteUserAccount.mockRejectedValue(error);

      await userController.deleteAccount(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Incorrect password'
      });
    });
  });

  describe('searchUsers', () => {
    it('should search users successfully', async () => {
      const mockUsers = [
        { id: '1', username: 'user1' },
        { id: '2', username: 'user2' }
      ];

      req.query = { query: 'user', page: '1', limit: '10' };
      userService.searchUsers.mockResolvedValue({
        users: mockUsers,
        total: 2,
        page: 1,
        limit: 10
      });

      await userController.searchUsers(req, res, next);

      expect(userService.searchUsers).toHaveBeenCalledWith('user', {
        page: 1,
        limit: 10,
        excludeUserId: req.user.id
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          users: mockUsers,
          pagination: {
            page: 1,
            limit: 10,
            total: 2,
            hasMore: false
          }
        }
      });
    });

    it('should handle empty query', async () => {
      req.query = { query: '' };

      await userController.searchUsers(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Search query is required'
      });
    });
  });

  describe('getUserProfile', () => {
    it('should get user profile by ID', async () => {
      const mockUser = {
        id: '456',
        username: 'otheruser',
        profile: { bio: 'Other bio' }
      };

      req.params = { userId: '456' };
      userService.getUserProfileById.mockResolvedValue(mockUser);

      await userController.getUserProfile(req, res, next);

      expect(userService.getUserProfileById).toHaveBeenCalledWith('456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockUser
      });
    });

    it('should handle private profile', async () => {
      const error = new Error('Profile is private');
      error.code = 'PRIVATE_PROFILE';

      userService.getUserProfileById.mockRejectedValue(error);

      await userController.getUserProfile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Profile is private',
        code: 'PRIVATE_PROFILE'
      });
    });
  });

  describe('getUserOnlineStatus', () => {
    it('should get online status successfully', async () => {
      const status = { online: true, lastSeen: new Date() };

      req.params = { userId: '456' };
      userService.getUserOnlineStatus.mockResolvedValue(status);

      await userController.getUserOnlineStatus(req, res, next);

      expect(userService.getUserOnlineStatus).toHaveBeenCalledWith('456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: status
      });
    });

    it('should handle user not found', async () => {
      userService.getUserOnlineStatus.mockRejectedValue(new Error('User not found'));

      await userController.getUserOnlineStatus(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('blockUser', () => {
    it('should block user successfully', async () => {
      req.user = { id: '123' };
      req.params = { userId: '456' };

      userService.blockUser.mockResolvedValue();

      await userController.blockUser(req, res, next);

      expect(userService.blockUser).toHaveBeenCalledWith('123', '456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'User blocked successfully'
      });
    });

    it('should handle self-block attempt', async () => {
      req.user = { id: '123' };
      req.params = { userId: '123' };

      await userController.blockUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot block yourself'
      });
    });
  });

  describe('unblockUser', () => {
    it('should unblock user successfully', async () => {
      req.user = { id: '123' };
      req.params = { userId: '456' };

      userService.unblockUser.mockResolvedValue();

      await userController.unblockUser(req, res, next);

      expect(userService.unblockUser).toHaveBeenCalledWith('123', '456');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'User unblocked successfully'
      });
    });
  });

  describe('getUserActivity', () => {
    it('should get user activity history', async () => {
      const activities = [
        { action: 'login', timestamp: new Date() },
        { action: 'message', timestamp: new Date() }
      ];

      req.user = { id: '123', role: 'admin' };
      req.params = { userId: '456' };
      req.query = { page: '1', limit: '10' };

      userService.getUserActivity.mockResolvedValue({
        activities,
        total: 2,
        page: 1,
        limit: 10
      });

      await userController.getUserActivity(req, res, next);

      expect(userService.getUserActivity).toHaveBeenCalledWith('456', {
        page: 1,
        limit: 10
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          activities,
          pagination: {
            page: 1,
            limit: 10,
            total: 2,
            hasMore: false
          }
        }
      });
    });

    it('should handle unauthorized access', async () => {
      req.user = { id: '123', role: 'user' };
      req.params = { userId: '456' };

      // User trying to access another user's activity
      await userController.getUserActivity(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Not authorized to view this user\'s activity'
      });
    });
  });

  describe('reportUser', () => {
    it('should report user successfully', async () => {
      req.user = { id: '123' };
      req.params = { userId: '456' };
      req.body = {
        reason: 'Spam',
        details: 'Sending spam messages'
      };

      userService.reportUser.mockResolvedValue();

      await userController.reportUser(req, res, next);

      expect(userService.reportUser).toHaveBeenCalledWith('123', '456', {
        reason: 'Spam',
        details: 'Sending spam messages'
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'User reported successfully'
      });
    });

    it('should handle self-report', async () => {
      req.user = { id: '123' };
      req.params = { userId: '123' };

      await userController.reportUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot report yourself'
      });
    });
  });

  describe('getUserStats', () => {
    it('should get user statistics', async () => {
      const stats = {
        totalMessages: 150,
        totalFriends: 25,
        totalChats: 10
      };

      req.user = { id: '123' };
      userService.getUserStatistics.mockResolvedValue(stats);

      await userController.getUserStats(req, res, next);

      expect(userService.getUserStatistics).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: stats
      });
    });
  });

  describe('getUserSettings', () => {
    it('should get user settings', async () => {
      const settings = {
        notifications: true,
        privacy: 'friends_only',
        theme: 'dark'
      };

      req.user = { id: '123' };
      userService.getUserSettings.mockResolvedValue(settings);

      await userController.getUserSettings(req, res, next);

      expect(userService.getUserSettings).toHaveBeenCalledWith('123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: settings
      });
    });
  });

  describe('updateUserSettings', () => {
    it('should update user settings successfully', async () => {
      const updatedSettings = {
        notifications: false,
        privacy: 'private',
        theme: 'light'
      };

      req.user = { id: '123' };
      req.body = updatedSettings;

      userService.updateUserSettings.mockResolvedValue(updatedSettings);

      await userController.updateUserSettings(req, res, next);

      expect(userService.updateUserSettings).toHaveBeenCalledWith('123', updatedSettings);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: updatedSettings,
        message: 'Settings updated successfully'
      });
    });

    it('should handle invalid settings', async () => {
      validationResult.mockReturnValue({
        isEmpty: jest.fn().mockReturnValue(false),
        array: jest.fn().mockReturnValue([{ field: 'privacy', message: 'Invalid privacy setting' }])
      });

      await userController.updateUserSettings(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});