const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');

class UserController {
  async getAllUsers(req, res, next) {
    try {
      // Get current user ID from authenticated request
      const currentUserId = req.user.userId;
      
      let users = [];
      
      // Try database first - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          users = await UsersModel.findAll({
            where: {
              id: { [Op.ne]: currentUserId }, // Exclude current user
              isActive: true
            },
            attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'role', 'status', 'lastSeen', 'createdAt'],
            order: [['createdAt', 'DESC']]
          });
        } catch (dbError) {
          console.error('Database fetch error:', dbError);
          // Fall through to in-memory
        }
      }

      // If database not available or empty, use in-memory
      if ((!users || users.length === 0) && req.app.locals.users) {
        users = req.app.locals.users
          .filter(user => user.id !== currentUserId && (user.isActive !== false))
          .map(user => ({
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role || 'user',
            status: user.status || 'offline',
            lastSeen: user.lastSeen,
            createdAt: user.createdAt
          }));
      }

      // Format response
      const formattedUsers = users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
        role: user.role || 'user',
        status: user.status || 'offline',
        lastSeen: user.lastSeen,
        isOnline: user.status === 'online',
        createdAt: user.createdAt
      }));

      // Log for debugging
      console.log(`Retrieved ${formattedUsers.length} users for current user: ${currentUserId}`);

      res.json({
        success: true,
        data: {
          users: formattedUsers,
          count: formattedUsers.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Get all users controller error:', error);
      return next(error);
    }
  }

  async getProfile(req, res, next) {
    try {
      const userId = req.user.userId;
      
      let user = null;
      
      // Try database first - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(userId, {
            attributes: { exclude: ['password'] }
          });
        } catch (dbError) {
          console.error('Database fetch error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        const foundUser = req.app.locals.users.find(u => u.id === userId);
        if (foundUser) {
          user = { ...foundUser };
          delete user.password;
        }
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            avatar: user.avatar,
            bio: user.bio,
            phone: user.phone,
            dateOfBirth: user.dateOfBirth,
            role: user.role || 'user',
            isVerified: user.isVerified || false,
            isActive: user.isActive !== false,
            status: user.status || 'offline',
            lastSeen: user.lastSeen,
            settings: user.settings || {},
            createdAt: user.createdAt,
            updatedAt: user.updatedAt
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Get profile controller error:', error);
      return next(error);
    }
  }

  async updateProfile(req, res, next) {
    try {
      const userId = req.user.userId;
      const updateData = req.body;

      // Validate update data
      if (updateData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updateData.email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
          timestamp: new Date().toISOString()
        });
      }

      if (updateData.username && !/^[a-zA-Z0-9_]{3,30}$/.test(updateData.username)) {
        return res.status(400).json({
          success: false,
          message: 'Username can only contain letters, numbers, and underscores (3-30 characters)',
          timestamp: new Date().toISOString()
        });
      }

      if (updateData.bio && updateData.bio.length > 500) {
        return res.status(400).json({
          success: false,
          message: 'Bio cannot exceed 500 characters',
          timestamp: new Date().toISOString()
        });
      }

      let updatedUser = null;
      
      // Try database update - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          const [affectedRows] = await UsersModel.update(updateData, {
            where: { id: userId },
            returning: true,
            individualHooks: true
          });
          
          if (affectedRows > 0) {
            updatedUser = await UsersModel.findByPk(userId, {
              attributes: { exclude: ['password'] }
            });
          }
        } catch (dbError) {
          console.error('Database update error:', dbError);
          // Check for duplicate error
          if (dbError.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({
              success: false,
              message: 'Email or username already exists',
              timestamp: new Date().toISOString()
            });
          }
          return next(dbError);
        }
      }

      // If database not available, update in-memory
      if (!updatedUser && req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex] = {
            ...req.app.locals.users[userIndex],
            ...updateData,
            updatedAt: new Date().toISOString()
          };
          updatedUser = { ...req.app.locals.users[userIndex] };
          delete updatedUser.password;
        }
      }

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: {
          user: {
            id: updatedUser.id,
            username: updatedUser.username,
            email: updatedUser.email,
            firstName: updatedUser.firstName,
            lastName: updatedUser.lastName,
            avatar: updatedUser.avatar,
            bio: updatedUser.bio,
            phone: updatedUser.phone,
            dateOfBirth: updatedUser.dateOfBirth,
            role: updatedUser.role,
            isVerified: updatedUser.isVerified,
            status: updatedUser.status,
            lastSeen: updatedUser.lastSeen,
            settings: updatedUser.settings,
            createdAt: updatedUser.createdAt,
            updatedAt: updatedUser.updatedAt
          }
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Update profile controller error:', error);
      
      // Handle duplicate email/username errors
      if (error.message.includes('duplicate') || error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'Email or username already exists',
          timestamp: new Date().toISOString()
        });
      }
      
      return next(error);
    }
  }

  async updateAvatar(req, res, next) {
    try {
      const userId = req.user.userId;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded',
          timestamp: new Date().toISOString()
        });
      }

      // Validate file type
      const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed',
          timestamp: new Date().toISOString()
        });
      }

      // Validate file size (max 5MB)
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (req.file.size > maxSize) {
        return res.status(400).json({
          success: false,
          message: 'File size exceeds 5MB limit',
          timestamp: new Date().toISOString()
        });
      }

      // In a real app, you would upload to Cloudinary/S3 and get URL
      // For now, we'll simulate it
      const avatarUrl = `/uploads/avatars/${req.file.filename}`;

      let updatedUser = null;
      
      // Try database update - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          const [affectedRows] = await UsersModel.update(
            { avatar: avatarUrl },
            { where: { id: userId } }
          );
          
          if (affectedRows > 0) {
            updatedUser = await UsersModel.findByPk(userId, {
              attributes: ['id', 'username', 'avatar']
            });
          }
        } catch (dbError) {
          console.error('Database update error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, update in-memory
      if (!updatedUser && req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex].avatar = avatarUrl;
          req.app.locals.users[userIndex].updatedAt = new Date().toISOString();
          updatedUser = {
            id: req.app.locals.users[userIndex].id,
            username: req.app.locals.users[userIndex].username,
            avatar: req.app.locals.users[userIndex].avatar
          };
        }
      }

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        message: 'Avatar updated successfully',
        data: {
          user: updatedUser
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Update avatar controller error:', error);
      return next(error);
    }
  }

  async removeAvatar(req, res, next) {
    try {
      const userId = req.user.userId;

      // Default avatar URL
      const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(req.user.username)}&background=random&color=fff`;

      let updatedUser = null;
      
      // Try database update - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          const [affectedRows] = await UsersModel.update(
            { avatar: defaultAvatar },
            { where: { id: userId } }
          );
          
          if (affectedRows > 0) {
            updatedUser = await UsersModel.findByPk(userId, {
              attributes: ['id', 'username', 'avatar']
            });
          }
        } catch (dbError) {
          console.error('Database update error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, update in-memory
      if (!updatedUser && req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex].avatar = defaultAvatar;
          req.app.locals.users[userIndex].updatedAt = new Date().toISOString();
          updatedUser = {
            id: req.app.locals.users[userIndex].id,
            username: req.app.locals.users[userIndex].username,
            avatar: req.app.locals.users[userIndex].avatar
          };
        }
      }

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        message: 'Avatar removed successfully',
        data: {
          user: updatedUser
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Remove avatar controller error:', error);
      return next(error);
    }
  }

  async changePassword(req, res, next) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword, confirmPassword } = req.body;

      // Validate required fields
      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password, new password, and confirmation are required',
          timestamp: new Date().toISOString()
        });
      }

      // Validate new password strength
      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 8 characters long',
          timestamp: new Date().toISOString()
        });
      }

      // Ensure new passwords match
      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'New passwords do not match',
          timestamp: new Date().toISOString()
        });
      }

      // Ensure new password is different from current password
      if (currentPassword === newPassword) {
        return res.status(400).json({
          success: false,
          message: 'New password must be different from current password',
          timestamp: new Date().toISOString()
        });
      }

      let user = null;
      
      // Get user first to verify current password - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(userId);
        } catch (dbError) {
          console.error('Database fetch error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        user = req.app.locals.users.find(u => u.id === userId);
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      // Verify current password
      let validCurrentPassword = false;
      if (user.validatePassword) {
        validCurrentPassword = await user.validatePassword(currentPassword);
      } else {
        validCurrentPassword = await bcrypt.compare(currentPassword, user.password);
      }

      if (!validCurrentPassword) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect',
          timestamp: new Date().toISOString()
        });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          await UsersModel.update(
            { password: hashedPassword },
            { where: { id: userId } }
          );
        } catch (dbError) {
          console.error('Database update error:', dbError);
          return next(dbError);
        }
      } else if (req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex].password = hashedPassword;
          req.app.locals.users[userIndex].updatedAt = new Date().toISOString();
        }
      }

      // Log password change for security auditing
      console.log(`Password changed for user: ${userId}`);

      res.json({
        success: true,
        message: 'Password changed successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Change password controller error:', error);
      
      // Handle specific error cases
      if (error.message.includes('Current password is incorrect')) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect',
          timestamp: new Date().toISOString()
        });
      }
      
      return next(error);
    }
  }

  async searchUsers(req, res, next) {
    try {
      const userId = req.user.userId;
      const { query, limit = 20 } = req.query;

      if (!query || query.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Search query must be at least 2 characters',
          timestamp: new Date().toISOString()
        });
      }

      let users = [];
      
      // Try database search - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          users = await UsersModel.findAll({
            where: {
              [Op.or]: [
                { username: { [Op.iLike]: `%${query}%` } },
                { firstName: { [Op.iLike]: `%${query}%` } },
                { lastName: { [Op.iLike]: `%${query}%` } },
                { email: { [Op.iLike]: `%${query}%` } },
              ],
              id: { [Op.ne]: userId }, // Exclude current user
              isActive: true
            },
            limit: parseInt(limit),
            attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'email', 'status', 'lastSeen', 'createdAt'],
          });
        } catch (dbError) {
          console.error('Database search error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, search in-memory
      if ((!users || users.length === 0) && req.app.locals.users) {
        users = req.app.locals.users
          .filter(user => 
            user.id !== userId && 
            (user.isActive !== false) && (
              user.username.toLowerCase().includes(query.toLowerCase()) ||
              (user.firstName && user.firstName.toLowerCase().includes(query.toLowerCase())) ||
              (user.lastName && user.lastName.toLowerCase().includes(query.toLowerCase())) ||
              user.email.toLowerCase().includes(query.toLowerCase())
            )
          )
          .slice(0, parseInt(limit))
          .map(user => ({
            id: user.id,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            avatar: user.avatar,
            email: user.email,
            status: user.status || 'offline',
            lastSeen: user.lastSeen,
            createdAt: user.createdAt
          }));
      }

      // Format response
      const formattedUsers = users.map(user => ({
        id: user.id,
        username: user.username,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
        avatar: user.avatar,
        email: user.email,
        status: user.status || 'offline',
        lastSeen: user.lastSeen,
        isOnline: user.status === 'online',
        createdAt: user.createdAt
      }));

      res.json({
        success: true,
        data: {
          users: formattedUsers || [],
          count: formattedUsers ? formattedUsers.length : 0,
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Search users controller error:', error);
      return next(error);
    }
  }

  async getUserStatus(req, res, next) {
    try {
      const userId = req.params.userId || req.user.userId;

      let user = null;
      
      // Try database first - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(userId, {
            attributes: ['id', 'status', 'lastSeen']
          });
        } catch (dbError) {
          console.error('Database fetch error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        const foundUser = req.app.locals.users.find(u => u.id === userId);
        if (foundUser) {
          user = {
            id: foundUser.id,
            status: foundUser.status || 'offline',
            lastSeen: foundUser.lastSeen
          };
        }
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: {
          userId: user.id,
          status: user.status || 'offline',
          lastSeen: user.lastSeen,
          isOnline: user.status === 'online'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Get user status controller error:', error);
      return next(error);
    }
  }

  async updateStatus(req, res, next) {
    try {
      const userId = req.user.userId;
      const { status } = req.body;

      if (!status || typeof status !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Status is required and must be a string',
          timestamp: new Date().toISOString()
        });
      }

      // Validate status is one of allowed values
      const allowedStatuses = ['online', 'offline', 'away', 'busy', 'invisible'];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Status must be one of: ${allowedStatuses.join(', ')}`,
          timestamp: new Date().toISOString()
        });
      }

      const updateData = {
        status: status,
        lastSeen: new Date()
      };

      let updatedUser = null;
      
      // Try database update - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          const [affectedRows] = await UsersModel.update(updateData, {
            where: { id: userId }
          });
          
          if (affectedRows > 0) {
            updatedUser = await UsersModel.findByPk(userId, {
              attributes: ['id', 'status', 'lastSeen']
            });
          }
        } catch (dbError) {
          console.error('Database update error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, update in-memory
      if (!updatedUser && req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex].status = status;
          req.app.locals.users[userIndex].lastSeen = new Date();
          updatedUser = {
            id: req.app.locals.users[userIndex].id,
            status: req.app.locals.users[userIndex].status,
            lastSeen: req.app.locals.users[userIndex].lastSeen
          };
        }
      }

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        message: 'Status updated successfully',
        data: {
          userId: updatedUser.id,
          status: updatedUser.status,
          lastSeen: updatedUser.lastSeen,
          isOnline: updatedUser.status === 'online'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Update status controller error:', error);
      return next(error);
    }
  }

  async getSettings(req, res, next) {
    try {
      const userId = req.user.userId;

      let user = null;
      
      // Try database first - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(userId, {
            attributes: ['id', 'settings']
          });
        } catch (dbError) {
          console.error('Database fetch error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        const foundUser = req.app.locals.users.find(u => u.id === userId);
        if (foundUser) {
          user = {
            id: foundUser.id,
            settings: foundUser.settings || {}
          };
        }
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      // Default settings if none exist
      const defaultSettings = {
        notifications: {
          messages: true,
          friendRequests: true,
          mentions: true,
          calls: true,
        },
        privacy: {
          showOnline: true,
          showLastSeen: true,
          allowFriendRequests: true,
          allowMessages: 'friends',
        },
        theme: 'light',
        language: 'en',
      };

      const settings = user.settings || defaultSettings;

      res.json({
        success: true,
        data: {
          settings
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Get settings controller error:', error);
      return next(error);
    }
  }

  async updateSettings(req, res, next) {
    try {
      const userId = req.user.userId;
      const { settings } = req.body;

      if (!settings || typeof settings !== 'object') {
        return res.status(400).json({
          success: false,
          message: 'Settings object is required',
          timestamp: new Date().toISOString()
        });
      }

      // Validate settings structure
      if (settings.theme && !['light', 'dark', 'auto'].includes(settings.theme)) {
        return res.status(400).json({
          success: false,
          message: 'Theme must be light, dark, or auto',
          timestamp: new Date().toISOString()
        });
      }

      if (settings.language && !['en', 'es', 'fr', 'de', 'it'].includes(settings.language)) {
        return res.status(400).json({
          success: false,
          message: 'Language must be en, es, fr, de, or it',
          timestamp: new Date().toISOString()
        });
      }

      let updatedUser = null;
      
      // Try database update - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          const [affectedRows] = await UsersModel.update(
            { settings: settings },
            { where: { id: userId } }
          );
          
          if (affectedRows > 0) {
            updatedUser = await UsersModel.findByPk(userId, {
              attributes: ['id', 'settings']
            });
          }
        } catch (dbError) {
          console.error('Database update error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, update in-memory
      if (!updatedUser && req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex].settings = settings;
          req.app.locals.users[userIndex].updatedAt = new Date().toISOString();
          updatedUser = {
            id: req.app.locals.users[userIndex].id,
            settings: req.app.locals.users[userIndex].settings
          };
        }
      }

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        message: 'Settings updated successfully',
        data: {
          settings: updatedUser.settings
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Update settings controller error:', error);
      return next(error);
    }
  }

  async deactivateAccount(req, res, next) {
    try {
      const userId = req.user.userId;
      const { confirm } = req.body;

      if (!confirm) {
        return res.status(400).json({
          success: false,
          message: 'Please confirm account deactivation',
          timestamp: new Date().toISOString()
        });
      }

      // Additional confirmation validation
      if (confirm !== 'DELETE' && confirm !== 'YES' && confirm !== 'DEACTIVATE') {
        return res.status(400).json({
          success: false,
          message: 'Please type "DELETE", "YES", or "DEACTIVATE" to confirm account deactivation',
          timestamp: new Date().toISOString()
        });
      }

      // Try database deactivation - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          await UsersModel.update(
            { 
              isActive: false,
              status: 'offline'
            },
            { where: { id: userId } }
          );
        } catch (dbError) {
          console.error('Database deactivation error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, update in-memory
      if (req.app.locals.users) {
        const userIndex = req.app.locals.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          req.app.locals.users[userIndex].isActive = false;
          req.app.locals.users[userIndex].status = 'offline';
          req.app.locals.users[userIndex].updatedAt = new Date().toISOString();
        }
      }

      // Log account deactivation for security auditing
      console.log(`Account deactivated for user: ${userId}`);

      res.json({
        success: true,
        message: 'Account deactivated successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Deactivate account controller error:', error);
      return next(error);
    }
  }

  async getUserById(req, res, next) {
    try {
      const userId = req.params.userId;
      const currentUserId = req.user.userId;

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required',
          timestamp: new Date().toISOString()
        });
      }

      let user = null;
      
      // Try database first - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(userId, {
            attributes: ['id', 'username', 'email', 'avatar', 'firstName', 'lastName', 'bio', 'status', 'lastSeen', 'isActive', 'createdAt']
          });
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        const foundUser = req.app.locals.users.find(u => u.id === userId);
        if (foundUser) {
          user = {
            id: foundUser.id,
            username: foundUser.username,
            email: foundUser.email,
            avatar: foundUser.avatar,
            firstName: foundUser.firstName,
            lastName: foundUser.lastName,
            bio: foundUser.bio,
            status: foundUser.status || 'offline',
            lastSeen: foundUser.lastSeen,
            isActive: foundUser.isActive !== false,
            createdAt: foundUser.createdAt
          };
        }
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      // Check if user is active
      if (!user.isActive) {
        return res.status(404).json({
          success: false,
          message: 'User account is deactivated',
          timestamp: new Date().toISOString()
        });
      }

      // Check if viewing own profile
      const isSelf = userId === currentUserId;

      // In a real app, you would check friendship status here
      // For now, we'll return different data based on whether it's self or not
      if (isSelf || req.user.role === 'admin') {
        // Return full profile for self or admin
        res.json({
          success: true,
          data: {
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              avatar: user.avatar,
              firstName: user.firstName,
              lastName: user.lastName,
              bio: user.bio,
              status: user.status || 'offline',
              lastSeen: user.lastSeen,
              isOnline: user.status === 'online',
              createdAt: user.createdAt,
              isSelf: true
            }
          },
          timestamp: new Date().toISOString()
        });
      } else {
        // Return public profile for others
        const publicInfo = {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
          bio: user.bio,
          status: user.status || 'offline',
          lastSeen: user.lastSeen,
          isOnline: user.status === 'online',
          createdAt: user.createdAt,
          isSelf: false
        };

        res.json({
          success: true,
          data: {
            user: publicInfo,
            isFriend: false, // Placeholder - implement friend check
          },
          timestamp: new Date().toISOString()
        });
      }
      
    } catch (error) {
      console.error('Get user by ID controller error:', error);
      
      if (error.message.includes('not found') || error.message.includes('User not found')) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }
      
      return next(error);
    }
  }

  async getCurrentUserSimple(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Not authenticated',
          timestamp: new Date().toISOString()
        });
      }
      
      let user = null;
      
      // Try database first - FIXED: Use User (singular)
      if (req.app.locals.dbConnected && req.app.locals.models && (req.app.locals.models.User || req.app.locals.models.Users)) {
        try {
          const UsersModel = req.app.locals.models.User || req.app.locals.models.Users;
          user = await UsersModel.findByPk(req.user.userId, {
            attributes: ['id', 'email', 'username', 'avatar', 'firstName', 'lastName', 'createdAt']
          });
        } catch (dbError) {
          console.error('Database lookup error:', dbError);
          return next(dbError);
        }
      }

      // If database not available, check in-memory
      if (!user && req.app.locals.users) {
        const foundUser = req.app.locals.users.find(u => u.id === req.user.userId);
        if (foundUser) {
          user = {
            id: foundUser.id,
            email: foundUser.email,
            username: foundUser.username,
            avatar: foundUser.avatar,
            firstName: foundUser.firstName,
            lastName: foundUser.lastName,
            createdAt: foundUser.createdAt
          };
        }
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          timestamp: new Date().toISOString()
        });
      }

      return res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          firstName: user.firstName,
          lastName: user.lastName,
          displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username,
          createdAt: user.createdAt
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Get current user simple error:', error);
      return next(error);
    }
  }
}

module.exports = new UserController();