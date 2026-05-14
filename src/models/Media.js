// --- MODEL: Media.js ---
const { Op } = require('sequelize');

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
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
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
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'media',
      modelName: 'Media',
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

  // Instance methods (PRESERVED)
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
      return false;
    }
    return false;
  };

  Media.prototype.softDelete = async function () {
    this.deletedAt = new Date();
    return await this.save();
  };

  // Static methods (PRESERVED)
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
          model: this.sequelize.models.Messages,
          as: 'mediaMessage',
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

  // FIXED: Associations with unique aliases
  Media.associate = function(models) {
    // CRITICAL: Prevent duplicate associations (alias conflict fix)
    if (this.associations && Object.keys(this.associations).length > 0) {
        // Skip if associations already defined to prevent alias conflicts
        return;
    }
        
    if (models.Users) {
      Media.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'mediaOwner',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Messages) {
      Media.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'mediaMessage',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Media;
};
