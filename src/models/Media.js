const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Media = sequelize.define(
    'Media',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'messages',
          key: 'id',
        },
      },
      url: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      type: {
        type: DataTypes.ENUM('image', 'video', 'audio', 'file', 'sticker'),
        allowNull: false,
      },
      filename: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      originalFilename: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      mimeType: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      size: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Size in bytes',
      },
      duration: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Duration in seconds for audio/video',
      },
      width: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Width in pixels for images/videos',
      },
      height: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Height in pixels for images/videos',
      },
      thumbnailUrl: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      encryptionKey: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      isCompressed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      compressionRatio: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      storageProvider: {
        type: DataTypes.ENUM('local', 's3', 'cloudinary', 'firebase'),
        defaultValue: 'local',
        allowNull: false,
      },
      storagePath: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      accessLevel: {
        type: DataTypes.ENUM('public', 'private', 'friends'),
        defaultValue: 'private',
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'media',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['user_id'],
        },
        {
          fields: ['message_id'],
        },
        {
          fields: ['type'],
        },
        {
          fields: ['created_at'],
        },
        {
          fields: ['storage_provider'],
        },
      ],
    }
  );

  // Instance methods
  Media.prototype.getPublicUrl = function () {
    if (this.accessLevel === 'public') {
      return this.url;
    }
    return null;
  };

  Media.prototype.canAccess = function (userId, userRole = 'user') {
    if (userRole === 'admin') return true;
    if (this.userId === userId) return true;
    if (this.accessLevel === 'public') return true;
    if (this.accessLevel === 'friends') {
      // Check if users are friends (you'll need to implement this)
      return false; // Placeholder
    }
    return false;
  };

  Media.prototype.softDelete = async function () {
    this.deletedAt = new Date();
    return await this.save();
  };

  // Static methods
  Media.getUserMedia = async function (userId, options = {}) {
    const where = {
      userId: userId,
      deletedAt: null,
    };

    if (options.type) {
      where.type = options.type;
    }

    return await this.findAll({
      where: where,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Media.getChatMedia = async function (chatId, options = {}) {
    return await this.findAll({
      include: [
        {
          model: this.sequelize.models.Message,
          where: {
            chatId: chatId,
            isDeleted: false,
          },
          attributes: [],
          required: true,
        },
      ],
      where: {
        deletedAt: null,
        type: options.type || { [Op.in]: ['image', 'video', 'audio', 'file'] },
      },
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Media.getStorageStats = async function () {
    const stats = await this.findAll({
      attributes: [
        'type',
        [this.sequelize.fn('COUNT', '*'), 'count'],
        [this.sequelize.fn('SUM', this.sequelize.col('size')), 'totalSize'],
      ],
      where: {
        deletedAt: null,
      },
      group: ['type'],
    });

    const total = await this.findOne({
      attributes: [
        [this.sequelize.fn('COUNT', '*'), 'totalCount'],
        [this.sequelize.fn('SUM', this.sequelize.col('size')), 'totalSize'],
      ],
      where: {
        deletedAt: null,
      },
    });

    return {
      byType: stats,
      total: total || { totalCount: 0, totalSize: 0 },
    };
  };

  // Associations defined in models/index.js
  Media.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return Media;
};