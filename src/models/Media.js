const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

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
    filename: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    originalName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    url: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    thumbnailUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    type: {
      type: DataTypes.ENUM('image', 'video', 'audio', 'file', 'document'),
      allowNull: false,
    },
    mimeType: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 0,
      },
    },
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Duration in seconds for audio/video',
    },
    dimensions: {
      type: DataTypes.JSONB,
      allowNull: true,
      validate: {
        isValidDimensions(value) {
          if (value && (!value.width || !value.height)) {
            throw new Error('Dimensions must have width and height');
          }
        },
      },
    },
    caption: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    altText: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    isCompressed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    compressionQuality: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 0,
        max: 100,
      },
    },
    storageProvider: {
      type: DataTypes.ENUM('local', 's3', 'cloudinary', 'firebase'),
      defaultValue: 'local',
      allowNull: false,
    },
    storagePath: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    isPublic: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    accessToken: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },
  },
  {
    tableName: 'media',
    timestamps: true,
    underscored: true,
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
        fields: ['access_token'],
      },
      {
        fields: ['storage_provider'],
      },
    ],
    hooks: {
      beforeCreate: async media => {
        if (!media.accessToken && media.isPublic) {
          media.accessToken = require('crypto').randomBytes(16).toString('hex');
        }
      },
    },
  }
);

// Instance methods
Media.prototype.getPublicUrl = function () {
  if (!this.isPublic) {
    throw new Error('Media is not public');
  }

  if (this.accessToken) {
    return `${this.url}?token=${this.accessToken}`;
  }

  return this.url;
};

Media.prototype.generateThumbnail = async function () {
  // This would be implemented with an image processing library
  // For now, return a placeholder
  if (this.type === 'image') {
    this.thumbnailUrl = `${this.url}?thumbnail=true`;
    return await this.save();
  }
  return this;
};

Media.prototype.compress = async function (quality = 80) {
  if (this.type !== 'image' && this.type !== 'video') {
    return this;
  }

  // This would be implemented with a compression library
  // For now, just mark as compressed
  this.isCompressed = true;
  this.compressionQuality = quality;
  return await this.save();
};

// Static methods
Media.getUserMedia = async function (userId, options = {}) {
  const where = {
    userId: userId,
  };

  if (options.type) {
    where.type = options.type;
  }

  if (options.startDate) {
    where.createdAt = { [Op.gte]: options.startDate };
  }

  if (options.endDate) {
    where.createdAt = { [Op.lte]: options.endDate };
  }

  return await this.findAll({
    where: where,
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Media.getChatMedia = async function (chatId, options = {}) {
  const Message = sequelize.models.Message;

  return await this.findAll({
    where: {
      messageId: {
        [Op.in]: sequelize.literal(`(
          SELECT id FROM messages 
          WHERE chat_id = ${chatId} 
          AND is_deleted = false
        )`),
      },
      ...options.where,
    },
    include: [
      {
        model: Message,
        attributes: ['id', 'chatId', 'createdAt'],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Media.findByAccessToken = async function (accessToken) {
  return await this.findOne({
    where: {
      accessToken: accessToken,
      isPublic: true,
    },
  });
};

Media.cleanupOrphaned = async function (days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Find media not linked to any message and older than cutoff
  return await this.destroy({
    where: {
      messageId: null,
      createdAt: { [Op.lt]: cutoff },
    },
  });
};

module.exports = Media;
