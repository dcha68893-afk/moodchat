
const { Op } = require('sequelize');
const { User, Profile, Friend, Chat, Message, Status } = require('../models');
const logger = require('../utils/logger');

class UserService {
  constructor() {
    console.log('🔧 [UserService] Initialized');
  }

  /**
   * Create a new user
   * Uses User model hooks for password hashing
   */
  async createUser(userData) {
    try {
      console.log("🔧 [UserService] Creating user with:", {
        username: userData.username,
        email: userData.email,
        hasFirstName: !!userData.firstName,
        hasLastName: !!userData.lastName
      });

      // Validate required fields
      if (!userData.username || !userData.email || !userData.password) {
        throw new Error('Username, email, and password are required');
      }

      // Validate password is not empty
      if (!userData.password || userData.password.trim() === '') {
        throw new Error('Password cannot be empty');
      }

      // Check if user already exists
      const existingUser = await this.findByUsernameOrEmail(
        userData.username.trim(),
        userData.email.toLowerCase().trim()
      );

      if (existingUser) {
        const errorMsg = existingUser.email === userData.email.toLowerCase().trim()
          ? 'Email already registered'
          : 'Username already taken';
        console.log("❌ [UserService] User exists:", errorMsg);
        throw new Error(errorMsg);
      }

      // Create user using User model (password will be hashed by hooks)
      const user = await User.create({
        username: userData.username.trim(),
        email: userData.email.toLowerCase().trim(),
        password: userData.password,
        firstName: userData.firstName || null,
        lastName: userData.lastName || null,
        isActive: true,
        isVerified: process.env.NODE_ENV === 'development', // Auto-verify in dev
        role: userData.role || 'user',
        status: 'offline',
        settings: {
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
          theme: 'dark',
          language: 'en',
        }
      });

      console.log("✅ [UserService] User created with ID:", user.id);

      // Try to create profile if profile data provided
      if (userData.profile) {
        try {
          await Profile.create({
            userId: user.id,
            ...userData.profile,
          });
          console.log("✅ [UserService] Profile created");
        } catch (profileError) {
          console.log("⚠️ [UserService] Profile not created:", profileError.message);
          // Continue without profile - it's optional
        }
      }

      return user.toJSON();
    } catch (error) {
      console.error('❌ [UserService] Create user error:', error.message);
      console.error('Error stack:', error.stack);

      if (error.name === 'SequelizeValidationError') {
        const messages = error.errors ? error.errors.map(err => err.message).join(', ') : error.message;
        throw new Error(`Validation error: ${messages}`);
      }

      if (error.name === 'SequelizeUniqueConstraintError') {
        throw new Error('Username or email already exists');
      }

      if (error.name === 'SequelizeDatabaseError') {
        throw new Error('Database error occurred');
      }

      throw error;
    }
  }

  /**
   * Get user by ID with optional related data
   */
  async getUserById(userId, options = {}) {
    try {
      console.log("🔧 [UserService] Getting user by ID:", userId);

      const include = [];

      // Include profile if requested
      if (options.includeProfile) {
        include.push({ model: Profile, as: 'profile' });
      }

      // Include friends if requested
      if (options.includeFriends) {
        include.push({
          model: User,
          as: 'friends',
          through: { attributes: ['status', 'createdAt'] },
          attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'status', 'lastSeen']
        });
      }

      // Include friend requests if requested
      if (options.includeFriendRequests) {
        include.push({
          model: User,
          as: 'friendRequests',
          through: {
            where: { status: 'pending' },
            attributes: ['id', 'createdAt']
          },
          attributes: ['id', 'username', 'firstName', 'lastName', 'avatar']
        });
      }

      const user = await User.findByPk(userId, {
        attributes: { exclude: ['password'] },
        include: include.length > 0 ? include : undefined
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Add additional computed fields
      const userData = user.toJSON();

      if (options.includeStats) {
        userData.stats = await this.getUserStats(userId);
      }

      if (options.includeOnlineStatus) {
        userData.online = this.isUserOnline(userData.lastSeen);
      }

      console.log("✅ [UserService] Retrieved user:", user.id);
      return userData;
    } catch (error) {
      console.error('❌ [UserService] Get user error:', error.message);
      throw error;
    }
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email, options = {}) {
    try {
      console.log("🔧 [UserService] Getting user by email:", email);

      const user = await User.findOne({
        where: { email: email.toLowerCase().trim() },
        attributes: options.includePassword ? undefined : { exclude: ['password'] }
      });

      if (!user) {
        throw new Error('User not found');
      }

      const userData = options.includePassword ? user : user.toJSON();

      if (options.includeOnlineStatus) {
        userData.online = this.isUserOnline(user.lastSeen);
      }

      console.log("✅ [UserService] Retrieved user by email:", user.id);
      return userData;
    } catch (error) {
      console.error('❌ [UserService] Get user by email error:', error.message);
      throw error;
    }
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username, currentUserId = null) {
    try {
      console.log("🔧 [UserService] Getting user by username:", username);

      const user = await User.findOne({
        where: { username: username.trim() },
        attributes: { exclude: ['password'] }
      });

      if (!user) {
        throw new Error('User not found');
      }

      const userData = user.toJSON();

      // Add friendship status if current user is provided
      if (currentUserId) {
        userData.friendship = await this.getFriendshipStatus(currentUserId, user.id);
      }

      // Add public stats
      userData.stats = {
        statuses: await Status.count({ where: { userId: user.id } }),
        friends: await this.getFriendCount(user.id)
      };

      console.log("✅ [UserService] Retrieved user by username:", user.id);
      return userData;
    } catch (error) {
      console.error('❌ [UserService] Get user by username error:', error.message);
      throw error;
    }
  }

  /**
   * Find user by username or email
   */
  async findByUsernameOrEmail(username, email) {
    try {
      console.log("🔧 [UserService] Finding user by username or email:", { username, email });

      if (!username && !email) {
        return null;
      }

      const conditions = [];

      if (username && username.trim()) {
        conditions.push({ username: username.trim() });
      }

      if (email && email.trim()) {
        conditions.push({ email: email.toLowerCase().trim() });
      }

      if (conditions.length === 0) {
        return null;
      }

      const user = await User.findOne({
        where: {
          [Op.or]: conditions
        }
      });

      if (user) {
        console.log("✅ [UserService] Found user:", user.id);
      } else {
        console.log("🔍 [UserService] User not found");
      }

      return user;
    } catch (error) {
      console.error('❌ [UserService] Find by username or email error:', error.message);
      throw error;
    }
  }

  /**
   * Update user profile
   */
  async updateUser(userId, updateData) {
    try {
      console.log("🔧 [UserService] Updating user:", userId);

      // Get existing user
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Validate update data
      const allowedFields = [
        'firstName', 'lastName', 'avatar', 'bio', 'phone',
        'dateOfBirth', 'status', 'settings'
      ];

      // Filter only allowed fields
      const filteredData = {};
      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          filteredData[field] = updateData[field];
        }
      }

      // Validate username if provided
      if (updateData.username && updateData.username !== user.username) {
        const existingUser = await User.findOne({
          where: { username: updateData.username.trim() }
        });

        if (existingUser && existingUser.id !== userId) {
          throw new Error('Username already taken');
        }

        if (updateData.username.length < 3 || updateData.username.length > 30) {
          throw new Error('Username must be 3-30 characters');
        }

        const usernameRegex = /^[a-zA-Z0-9_]+$/;
        if (!usernameRegex.test(updateData.username)) {
          throw new Error('Username can only contain letters, numbers, and underscores');
        }

        filteredData.username = updateData.username.trim();
      }

      // Update user
      await user.update(filteredData);

      console.log("✅ [UserService] User updated:", userId);

      // Return updated user without password
      return await this.getUserById(userId, {
        includeProfile: true,
        includeStats: true
      });
    } catch (error) {
      console.error('❌ [UserService] Update user error:', error.message);

      if (error.name === 'SequelizeValidationError') {
        const messages = error.errors ? error.errors.map(err => err.message).join(', ') : error.message;
        throw new Error(`Validation error: ${messages}`);
      }

      throw error;
    }
  }

  /**
   * Delete user (soft delete by setting isActive to false)
   */
  async deleteUser(userId) {
    try {
      console.log("🔧 [UserService] Deleting user:", userId);

      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Soft delete by deactivating the user
      await user.update({
        isActive: false,
        status: 'offline',
        lastSeen: new Date()
      });

      console.log("✅ [UserService] User deactivated:", userId);
      return { success: true, message: 'User deactivated successfully' };
    } catch (error) {
      console.error('❌ [UserService] Delete user error:', error.message);
      throw error;
    }
  }

  /**
   * Update user settings
   */
  async updateUserSettings(userId, settings) {
    try {
      console.log("🔧 [UserService] Updating settings for user:", userId);

      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Merge new settings with existing settings
      const currentSettings = user.settings || {};
      const updatedSettings = {
        ...currentSettings,
        ...settings
      };

      await user.update({ settings: updatedSettings });

      console.log("✅ [UserService] Settings updated for user:", userId);
      return updatedSettings;
    } catch (error) {
      console.error('❌ [UserService] Update settings error:', error.message);
      throw error;
    }
  }

  /**
   * Search users by query
   */
  async searchUsers(query, currentUserId = null, limit = 20) {
    try {
      console.log("🔧 [UserService] Searching users with query:", query);

      if (!query || query.trim().length < 2) {
        return [];
      }

      const searchTerm = `%${query.trim()}%`;

      const users = await User.findAll({
        where: {
          [Op.or]: [
            { username: { [Op.iLike]: searchTerm } },
            { firstName: { [Op.iLike]: searchTerm } },
            { lastName: { [Op.iLike]: searchTerm } },
            { email: { [Op.iLike]: searchTerm } }
          ],
          isActive: true
        },
        attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio', 'status', 'lastSeen'],
        limit: limit
      });

      const results = await Promise.all(
        users.map(async (user) => {
          const userData = user.toJSON();

          // Add friendship status if current user is provided
          if (currentUserId && currentUserId !== user.id) {
            userData.friendship = await this.getFriendshipStatus(currentUserId, user.id);
          }

          // Add online status
          userData.online = this.isUserOnline(user.lastSeen);

          return userData;
        })
      );

      console.log("✅ [UserService] Found", results.length, "users");
      return results;
    } catch (error) {
      console.error('❌ [UserService] Search users error:', error.message);
      throw error;
    }
  }

  /**
   * Get user's friends
   */
  async getUserFriends(userId, options = {}) {
    try {
      console.log("🔧 [UserService] Getting friends for user:", userId);

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friends',
          through: {
            where: { status: 'accepted' },
            attributes: ['createdAt']
          },
          attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio', 'status', 'lastSeen']
        }]
      });

      if (!user) {
        throw new Error('User not found');
      }

      const friends = user.friends || [];

      // Add online status to each friend
      const friendsWithStatus = friends.map(friend => {
        const friendData = friend.toJSON();
        friendData.online = this.isUserOnline(friend.lastSeen);
        friendData.friendshipDate = friend.Friend ? friend.Friend.createdAt : null;
        return friendData;
      });

      console.log("✅ [UserService] Retrieved", friendsWithStatus.length, "friends");
      return friendsWithStatus;
    } catch (error) {
      console.error('❌ [UserService] Get friends error:', error.message);
      throw error;
    }
  }

  /**
   * Get friend requests (pending)
   */
  async getFriendRequests(userId) {
    try {
      console.log("🔧 [UserService] Getting friend requests for user:", userId);

      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friendRequests',
          through: {
            where: { status: 'pending' },
            attributes: ['id', 'createdAt']
          },
          attributes: ['id', 'username', 'firstName', 'lastName', 'avatar', 'bio']
        }]
      });

      if (!user) {
        throw new Error('User not found');
      }

      const requests = user.friendRequests || [];
      console.log("✅ [UserService] Retrieved", requests.length, "friend requests");
      return requests;
    } catch (error) {
      console.error('❌ [UserService] Get friend requests error:', error.message);
      throw error;
    }
  }

  /**
   * Get user statistics
   */
  async getUserStats(userId) {
    try {
      console.log("🔧 [UserService] Getting stats for user:", userId);

      const [
        friendCount,
        statusCount,
        chatCount,
        unreadMessages
      ] = await Promise.all([
        this.getFriendCount(userId),
        Status.count({ where: { userId } }),
        Chat.count({ where: { userId } }),
        Message.count({
          where: {
            receiverId: userId,
            read: false
          }
        })
      ]);

      const stats = {
        friends: friendCount,
        statuses: statusCount,
        chats: chatCount,
        unreadMessages: unreadMessages,
        online: this.isUserOnline(await this.getLastSeen(userId))
      };

      console.log("✅ [UserService] Retrieved stats for user:", userId);
      return stats;
    } catch (error) {
      console.error('❌ [UserService] Get stats error:', error.message);
      throw error;
    }
  }

  /**
   * Update user's last seen timestamp
   */
  async updateLastSeen(userId) {
    try {
      console.log("🔧 [UserService] Updating last seen for user:", userId);

      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      user.lastSeen = new Date();
      await user.save();

      console.log("✅ [UserService] Last seen updated:", userId);
      return user.lastSeen;
    } catch (error) {
      console.error('❌ [UserService] Update last seen error:', error.message);
      throw error;
    }
  }

  /**
   * Get user's online friends
   */
  async getOnlineFriends(userId) {
    try {
      console.log("🔧 [UserService] Getting online friends for user:", userId);

      const friends = await this.getUserFriends(userId);
      const onlineFriends = friends.filter(friend => this.isUserOnline(friend.lastSeen));

      console.log("✅ [UserService] Found", onlineFriends.length, "online friends");
      return onlineFriends;
    } catch (error) {
      console.error('❌ [UserService] Get online friends error:', error.message);
      throw error;
    }
  }

  /**
   * Get user's recent activity
   */
  async getUserActivity(userId, limit = 10) {
    try {
      console.log("🔧 [UserService] Getting activity for user:", userId);

      const recentStatuses = await Status.findAll({
        where: { userId },
        order: [['createdAt', 'DESC']],
        limit: limit,
        include: [{
          model: User,
          as: 'user',
          attributes: ['id', 'username', 'avatar']
        }]
      });

      const recentMessages = await Message.findAll({
        where: {
          [Op.or]: [
            { senderId: userId },
            { receiverId: userId }
          ]
        },
        order: [['createdAt', 'DESC']],
        limit: limit,
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar']
          },
          {
            model: User,
            as: 'receiver',
            attributes: ['id', 'username', 'avatar']
          }
        ]
      });

      const activity = [
        ...recentStatuses.map(status => ({
          type: 'status',
          data: status,
          timestamp: status.createdAt
        })),
        ...recentMessages.map(message => ({
          type: 'message',
          data: message,
          timestamp: message.createdAt
        }))
      ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit);

      console.log("✅ [UserService] Retrieved", activity.length, "activity items");
      return activity;
    } catch (error) {
      console.error('❌ [UserService] Get activity error:', error.message);
      throw error;
    }
  }

  // ===== HELPER METHODS =====

  /**
   * Get friend count
   */
  async getFriendCount(userId) {
    const count = await Friend.count({
      where: {
        [Op.or]: [
          { userId: userId, status: 'accepted' },
          { friendId: userId, status: 'accepted' }
        ]
      }
    });
    return count;
  }

  /**
   * Get friendship status between two users
   */
  async getFriendshipStatus(userId1, userId2) {
    if (userId1 === userId2) {
      return { status: 'self' };
    }

    const friendship = await Friend.findOne({
      where: {
        [Op.or]: [
          { userId: userId1, friendId: userId2 },
          { userId: userId2, friendId: userId1 }
        ]
      }
    });

    if (!friendship) {
      return { status: 'none' };
    }

    // Determine direction
    const isRequester = friendship.userId === userId1;

    return {
      status: friendship.status,
      isRequester: isRequester,
      createdAt: friendship.createdAt
    };
  }

  /**
   * Get user's last seen timestamp
   */
  async getLastSeen(userId) {
    const user = await User.findByPk(userId, {
      attributes: ['lastSeen']
    });
    return user ? user.lastSeen : null;
  }

  /**
   * Check if user is online (last seen within 5 minutes)
   */
  isUserOnline(lastSeen) {
    if (!lastSeen) return false;

    const now = new Date();
    const lastSeenDate = new Date(lastSeen);
    const minutesAgo = (now - lastSeenDate) / (1000 * 60);

    return minutesAgo < 5; // Online if last seen within 5 minutes
  }

  /**
   * Get user's full name
   */
  getUserFullName(user) {
    if (user.firstName && user.lastName) {
      return `${user.firstName} ${user.lastName}`;
    }
    return user.username;
  }

  /**
   * Validate user update data
   */
  validateUpdateData(data) {
    const errors = [];

    if (data.username && (data.username.length < 3 || data.username.length > 30)) {
      errors.push('Username must be 3-30 characters');
    }

    if (data.bio && data.bio.length > 500) {
      errors.push('Bio cannot exceed 500 characters');
    }

    if (data.phone && !/^\+?[1-9]\d{1,14}$/.test(data.phone)) {
      errors.push('Invalid phone number format');
    }

    return errors;
  }
}

module.exports = new UserService();
