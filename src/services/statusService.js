// statusService.js - Rewritten for Sequelize/PostgreSQL
// Previously used Mongoose - now aligned with UserStatus Sequelize model

const { Op } = require('sequelize');

const {
  STATUS_EXPIRY_MINUTES = 5,
  MAX_STATUS_LENGTH = 100,
  STATUS_TYPES = 'online,away,busy,offline,invisible',
} = process.env;

const VALID_STATUS_TYPES = STATUS_TYPES.split(',');

// Lazy-load models to avoid circular dependency issues
function getModels() {
  const db = require('../models');
  return {
    UserStatus: db.UserStatus,
    Users: db.Users || db.User,
  };
}

class StatusService {

  async updateStatus(userId, statusType, customStatus = null) {
    const { UserStatus, Users } = getModels();

    if (!userId || !statusType) {
      throw Object.assign(new Error('User ID and status type are required'), { statusCode: 400 });
    }
    if (!VALID_STATUS_TYPES.includes(statusType)) {
      throw Object.assign(
        new Error(`Status type must be one of: ${VALID_STATUS_TYPES.join(', ')}`),
        { statusCode: 400 }
      );
    }
    if (customStatus && customStatus.length > parseInt(MAX_STATUS_LENGTH)) {
      throw Object.assign(
        new Error(`Custom status cannot exceed ${MAX_STATUS_LENGTH} characters`),
        { statusCode: 400 }
      );
    }

    try {
      let userStatus = await UserStatus.findOne({ where: { userId } });

      if (!userStatus) {
        userStatus = await UserStatus.create({
          userId,
          status: statusType,
          customStatus: customStatus || null,
          lastSeen: new Date(),
        });
      } else {
        await userStatus.update({
          status: statusType,
          customStatus: customStatus || null,
          lastSeen: new Date(),
        });
      }

      await userStatus.reload({
        include: [{ model: Users, as: 'userStatusOwner', attributes: ['id', 'username', 'avatar'] }],
      });

      return this._formatStatusResponse(userStatus);
    } catch (error) {
      console.error('Error updating status:', error);
      throw Object.assign(new Error('Failed to update status'), { statusCode: 500 });
    }
  }

  async getUsersStatus(requesterId, userIds) {
    const { UserStatus, Users } = getModels();

    if (!requesterId || !userIds || !Array.isArray(userIds)) {
      throw Object.assign(new Error('Requester ID and user IDs array are required'), { statusCode: 400 });
    }
    if (userIds.length > 100) {
      throw Object.assign(new Error('Cannot fetch status for more than 100 users at once'), { statusCode: 400 });
    }

    try {
      const statuses = await UserStatus.findAll({
        where: { userId: { [Op.in]: userIds } },
        include: [{ model: Users, as: 'userStatusOwner', attributes: ['id', 'username', 'avatar'] }],
      });

      const statusMap = new Map();
      statuses.forEach(s => statusMap.set(String(s.userId), this._formatStatusResponse(s)));

      const result = [];
      for (const uid of userIds) {
        if (statusMap.has(String(uid))) {
          result.push(statusMap.get(String(uid)));
        } else {
          const user = await Users.findByPk(uid, { attributes: ['id', 'username', 'avatar'] });
          if (user) {
            result.push({
              userId: user.id,
              user: { id: user.id, username: user.username, avatar: user.avatar },
              status: 'offline',
              customStatus: null,
              lastSeen: null,
              isOnline: false,
            });
          }
        }
      }
      return result;
    } catch (error) {
      console.error('Error fetching users status:', error);
      throw Object.assign(new Error('Failed to fetch users status'), { statusCode: 500 });
    }
  }

  async getUserStatus(userId) {
    const { UserStatus, Users } = getModels();

    if (!userId) {
      throw Object.assign(new Error('User ID is required'), { statusCode: 400 });
    }

    try {
      const userStatus = await UserStatus.findOne({
        where: { userId },
        include: [{ model: Users, as: 'userStatusOwner', attributes: ['id', 'username', 'avatar'] }],
      });

      if (!userStatus) {
        const user = await Users.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });
        if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
        return {
          userId: user.id,
          user: { id: user.id, username: user.username, avatar: user.avatar },
          status: 'offline',
          customStatus: null,
          lastSeen: null,
          isOnline: false,
        };
      }

      return this._formatStatusResponse(userStatus);
    } catch (error) {
      if (error.statusCode) throw error;
      console.error('Error getting user status:', error);
      throw Object.assign(new Error('Failed to get user status'), { statusCode: 500 });
    }
  }

  async setOffline(userId) {
    const { UserStatus } = getModels();

    if (!userId) {
      throw Object.assign(new Error('User ID is required'), { statusCode: 400 });
    }

    try {
      let userStatus = await UserStatus.findOne({ where: { userId } });
      if (!userStatus) {
        userStatus = await UserStatus.create({
          userId, status: 'offline', lastSeen: new Date(), socketIds: [],
        });
      } else {
        await userStatus.setOffline();
      }
      return this._formatStatusResponse(userStatus);
    } catch (error) {
      console.error('Error setting offline:', error);
      throw Object.assign(new Error('Failed to set offline status'), { statusCode: 500 });
    }
  }

  async updateLastSeen(userId) {
    const { UserStatus } = getModels();

    if (!userId) {
      throw Object.assign(new Error('User ID is required'), { statusCode: 400 });
    }

    try {
      let userStatus = await UserStatus.findOne({ where: { userId } });
      if (!userStatus) return await this.updateStatus(userId, 'online');
      await userStatus.updateLastSeen();
      return this._formatStatusResponse(userStatus);
    } catch (error) {
      console.error('Error updating last seen:', error);
      throw Object.assign(new Error('Failed to update last seen'), { statusCode: 500 });
    }
  }

  async getAllOnlineUsers(limit = 100) {
    const { UserStatus, Users } = getModels();

    try {
      const onlineUsers = await UserStatus.findAll({
        where: { status: { [Op.in]: ['online', 'away', 'busy'] } },
        include: [{ model: Users, as: 'userStatusOwner', attributes: ['id', 'username', 'avatar'] }],
        order: [['lastSeen', 'DESC']],
        limit: parseInt(limit),
      });
      return onlineUsers.map(s => this._formatStatusResponse(s));
    } catch (error) {
      console.error('Error fetching online users:', error);
      throw Object.assign(new Error('Failed to fetch online users'), { statusCode: 500 });
    }
  }

  async addSocket(userId, socketId) {
    const { UserStatus } = getModels();
    try {
      let userStatus = await UserStatus.findOne({ where: { userId } });
      if (!userStatus) {
        userStatus = await UserStatus.create({
          userId, status: 'online', lastSeen: new Date(), socketIds: [socketId],
        });
      } else {
        await userStatus.addSocket(socketId);
        if (userStatus.status === 'offline') {
          await userStatus.setOnline(socketId);
        }
      }
      return this._formatStatusResponse(userStatus);
    } catch (error) {
      console.error('Error adding socket:', error);
      throw Object.assign(new Error('Failed to register socket'), { statusCode: 500 });
    }
  }

  async removeSocket(userId, socketId) {
    const { UserStatus } = getModels();
    try {
      const userStatus = await UserStatus.findOne({ where: { userId } });
      if (userStatus) await userStatus.removeSocket(socketId);
      return userStatus ? this._formatStatusResponse(userStatus) : null;
    } catch (error) {
      console.error('Error removing socket:', error);
      throw Object.assign(new Error('Failed to remove socket'), { statusCode: 500 });
    }
  }

  async setTyping(userId, chatId) {
    const { UserStatus } = getModels();
    try {
      const userStatus = await UserStatus.findOne({ where: { userId } });
      if (userStatus) await userStatus.startTyping(chatId);
      return userStatus ? this._formatStatusResponse(userStatus) : null;
    } catch (error) {
      console.error('Error setting typing:', error);
      throw Object.assign(new Error('Failed to set typing'), { statusCode: 500 });
    }
  }

  async clearTyping(userId) {
    const { UserStatus } = getModels();
    try {
      const userStatus = await UserStatus.findOne({ where: { userId } });
      if (userStatus) await userStatus.stopTyping();
      return userStatus ? this._formatStatusResponse(userStatus) : null;
    } catch (error) {
      console.error('Error clearing typing:', error);
      throw Object.assign(new Error('Failed to clear typing'), { statusCode: 500 });
    }
  }

  _formatStatusResponse(userStatus) {
    const plain = userStatus.toJSON ? userStatus.toJSON() : userStatus;
    const user = plain.userStatusOwner || null;
    const isOnline = ['online', 'away', 'busy'].includes(plain.status) &&
      plain.showOnlineStatus !== false;

    return {
      userId: plain.userId,
      user: user ? { id: user.id, username: user.username, avatar: user.avatar } : null,
      status: plain.status,
      customStatus: plain.customStatus || null,
      lastSeen: plain.lastSeen,
      isOnline,
      isTypingIn: plain.isTypingIn || null,
      activeDevice: plain.activeDevice || null,
    };
  }
}

module.exports = new StatusService();