// --- MODEL: Status.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Status = sequelize.define(
    'Status',
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
          model: 'Users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: {
          len: {
            args: [0, 500],
            msg: 'Status content must be less than 500 characters',
          },
        },
      },
      type: {
        type: DataTypes.ENUM('text', 'image', 'video', 'audio', 'mood', 'location'),
        defaultValue: 'text',
        allowNull: false,
      },
      moodType: {
        type: DataTypes.ENUM(
          'happy',
          'sad',
          'angry',
          'excited',
          'calm',
          'anxious',
          'tired',
          'energetic',
          'focused',
          'relaxed',
          'nostalgic',
          'romantic',
          'lonely',
          'confused',
          'proud',
          'grateful',
          'hopeful',
          'bored',
          'sick',
          'neutral'
        ),
        allowNull: true,
      },
      mediaUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        validate: {
          isUrl: {
            msg: 'Media URL must be a valid URL',
          },
        },
      },
      location: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      latitude: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: {
            args: [-90],
            msg: 'Latitude must be between -90 and 90',
          },
          max: {
            args: [90],
            msg: 'Latitude must be between -90 and 90',
          },
        },
      },
      longitude: {
        type: DataTypes.FLOAT,
        allowNull: true,
        validate: {
          min: {
            args: [-180],
            msg: 'Longitude must be between -180 and 180',
          },
          max: {
            args: [180],
            msg: 'Longitude must be between -180 and 180',
          },
        },
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      isPublic: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      viewCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        validate: {
          min: {
            args: [0],
            msg: 'View count cannot be negative',
          },
        },
      },
      likeCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        validate: {
          min: {
            args: [0],
            msg: 'Like count cannot be negative',
          },
        },
      },
      commentCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        validate: {
          min: {
            args: [0],
            msg: 'Comment count cannot be negative',
          },
        },
      },
      shareCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        validate: {
          min: {
            args: [0],
            msg: 'Share count cannot be negative',
          },
        },
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
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
      tableName: 'statuses',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['userId'],
          name: 'idx_statuses_user',
        },
        {
          fields: ['type'],
          name: 'idx_statuses_type',
        },
        {
          fields: ['moodType'],
          name: 'idx_statuses_mood',
        },
        {
          fields: ['isActive'],
          name: 'idx_statuses_active',
        },
        {
          fields: ['isPublic'],
          name: 'idx_statuses_public',
        },
        {
          fields: ['createdAt'],
          name: 'idx_statuses_created',
        },
        {
          fields: ['expiresAt'],
          name: 'idx_statuses_expires',
        },
        {
          fields: ['userId', 'createdAt'],
          name: 'idx_statuses_user_created',
        },
        {
          fields: ['isActive', 'createdAt'],
          name: 'idx_statuses_active_created',
        },
        {
          fields: ['isPublic', 'createdAt'],
          name: 'idx_statuses_public_created',
        },
      ],
      hooks: {
        beforeCreate: (status) => {
          if (!status.createdAt) {
            status.createdAt = new Date();
          }
          if (status.type === 'mood' && !status.moodType) {
            throw new Error('Mood type is required for mood status');
          }
        },
        beforeUpdate: (status) => {
          if (status.changed('isActive') && !status.isActive) {
            status.expiresAt = new Date(); // Set expire time when deactivated
          }
        },
      },
    }
  );

  // ===== ASSOCIATIONS =====
  Status.associate = function (models) {
    if (models.Users) {
      Status.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'user',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.StatusLike) {
      Status.hasMany(models.StatusLike, {
        foreignKey: 'statusId',
        as: 'likes',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.StatusComment) {
      Status.hasMany(models.StatusComment, {
        foreignKey: 'statusId',
        as: 'comments',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.StatusView) {
      Status.hasMany(models.StatusView, {
        foreignKey: 'statusId',
        as: 'views',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  // ===== INSTANCE METHODS =====
  Status.prototype.incrementViewCount = async function () {
    this.viewCount += 1;
    return await this.save();
  };

  Status.prototype.incrementLikeCount = async function () {
    this.likeCount += 1;
    return await this.save();
  };

  Status.prototype.decrementLikeCount = async function () {
    if (this.likeCount > 0) {
      this.likeCount -= 1;
    }
    return await this.save();
  };

  Status.prototype.incrementCommentCount = async function () {
    this.commentCount += 1;
    return await this.save();
  };

  Status.prototype.decrementCommentCount = async function () {
    if (this.commentCount > 0) {
      this.commentCount -= 1;
    }
    return await this.save();
  };

  Status.prototype.incrementShareCount = async function () {
    this.shareCount += 1;
    return await this.save();
  };

  Status.prototype.deactivate = async function () {
    this.isActive = false;
    this.expiresAt = new Date();
    return await this.save();
  };

  Status.prototype.activate = async function () {
    this.isActive = true;
    this.expiresAt = null;
    return await this.save();
  };

  Status.prototype.setPrivate = async function () {
    this.isPublic = false;
    return await this.save();
  };

  Status.prototype.setPublic = async function () {
    this.isPublic = true;
    return await this.save();
  };

  Status.prototype.updateContent = async function (newContent) {
    this.content = newContent;
    return await this.save();
  };

  Status.prototype.updateMood = async function (moodType) {
    this.type = 'mood';
    this.moodType = moodType;
    return await this.save();
  };

  Status.prototype.updateLocation = async function (location, latitude = null, longitude = null) {
    this.location = location;
    this.latitude = latitude;
    this.longitude = longitude;
    return await this.save();
  };

  Status.prototype.addMetadata = async function (key, value) {
    if (!this.metadata) {
      this.metadata = {};
    }
    this.metadata[key] = value;
    return await this.save();
  };

  Status.prototype.removeMetadata = async function (key) {
    if (this.metadata && this.metadata[key]) {
      delete this.metadata[key];
      return await this.save();
    }
    return this;
  };

  Status.prototype.isExpired = function () {
    if (!this.expiresAt) return false;
    return new Date() > new Date(this.expiresAt);
  };

  Status.prototype.getTimeSinceCreated = function () {
    const now = new Date();
    const created = new Date(this.createdAt);
    const diffMs = now - created;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffDays > 0) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
    } else {
      return 'Just now';
    }
  };

  Status.prototype.toJSON = function () {
    const values = Object.assign({}, this.get());
    
    // Add calculated fields
    values.timeSinceCreated = this.getTimeSinceCreated();
    values.isExpired = this.isExpired();
    
    return values;
  };

  // ===== STATIC METHODS =====
  Status.getUserStatuses = async function (userId, options = {}) {
    const where = { userId };

    if (options.activeOnly !== false) {
      where.isActive = true;
    }

    if (options.type) {
      where.type = options.type;
    }

    if (options.moodType) {
      where.moodType = options.moodType;
    }

    const include = [];

    if (options.includeUser) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      });
    }

    if (options.includeLikes) {
      include.push({
        model: this.sequelize.models.StatusLike,
        as: 'likes',
        attributes: ['id', 'userId', 'createdAt'],
        limit: 5,
        include: [
          {
            model: this.sequelize.models.Users,
            as: 'user',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
      });
    }

    if (options.includeComments) {
      include.push({
        model: this.sequelize.models.StatusComment,
        as: 'comments',
        attributes: ['id', 'userId', 'content', 'createdAt'],
        limit: 5,
        order: [['createdAt', 'DESC']],
        include: [
          {
            model: this.sequelize.models.Users,
            as: 'user',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
      });
    }

    return await this.findAll({
      where,
      include: include.length > 0 ? include : undefined,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Status.getActiveStatuses = async function (options = {}) {
    const where = {
      isActive: true,
      isPublic: true,
    };

    if (options.userId) {
      where.userId = options.userId;
    }

    if (options.type) {
      where.type = options.type;
    }

    if (options.moodType) {
      where.moodType = options.moodType;
    }

    // Filter out expired statuses
    const Op = this.sequelize.Op;
    where[Op.or] = [
      { expiresAt: null },
      { expiresAt: { [Op.gt]: new Date() } },
    ];

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
    ];

    return await this.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 100,
      offset: options.offset || 0,
    });
  };

  Status.getFriendsStatuses = async function (userId, friendIds, options = {}) {
    const Op = this.sequelize.Op;
    const where = {
      userId: { [Op.in]: friendIds },
      isActive: true,
      [Op.or]: [
        { isPublic: true },
        { userId: userId }, // User can see their own private statuses
      ],
    };

    // Filter out expired statuses
    where[Op.or] = [
      ...(where[Op.or] || []),
      { expiresAt: null },
      { expiresAt: { [Op.gt]: new Date() } },
    ];

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
    ];

    if (options.includeStats) {
      include.push({
        model: this.sequelize.models.StatusLike,
        as: 'likes',
        attributes: ['id'],
        required: false,
      });
    }

    return await this.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 100,
      offset: options.offset || 0,
    });
  };

  Status.createStatus = async function (userId, statusData) {
    const status = await this.create({
      userId,
      ...statusData,
      isActive: true,
    });

    return status;
  };

  Status.updateStatus = async function (statusId, updates) {
    const [affectedRows] = await this.update(updates, {
      where: { id: statusId },
    });

    return affectedRows > 0;
  };

  Status.deactivateStatus = async function (statusId) {
    const [affectedRows] = await this.update(
      {
        isActive: false,
        expiresAt: new Date(),
      },
      {
        where: { id: statusId },
      }
    );

    return affectedRows > 0;
  };

  Status.deleteStatus = async function (statusId) {
    const result = await this.destroy({
      where: { id: statusId },
    });

    return result > 0;
  };

  Status.getStatusById = async function (statusId, options = {}) {
    const include = [];

    if (options.includeUser) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      });
    }

    if (options.includeLikes) {
      include.push({
        model: this.sequelize.models.StatusLike,
        as: 'likes',
        attributes: ['id', 'userId', 'createdAt'],
        include: [
          {
            model: this.sequelize.models.Users,
            as: 'user',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
      });
    }

    if (options.includeComments) {
      include.push({
        model: this.sequelize.models.StatusComment,
        as: 'comments',
        attributes: ['id', 'userId', 'content', 'createdAt'],
        include: [
          {
            model: this.sequelize.models.Users,
            as: 'user',
            attributes: ['id', 'username', 'avatar'],
          },
        ],
        order: [['createdAt', 'DESC']],
      });
    }

    return await this.findByPk(statusId, {
      include: include.length > 0 ? include : undefined,
    });
  };

  Status.searchStatuses = async function (query, options = {}) {
    const Op = this.sequelize.Op;
    const where = {
      isActive: true,
      isPublic: true,
      [Op.or]: [
        { content: { [Op.iLike]: `%${query}%` } },
        { location: { [Op.iLike]: `%${query}%` } },
      ],
    };

    // Filter out expired statuses
    where[Op.or] = [
      ...where[Op.or],
      { expiresAt: null },
      { expiresAt: { [Op.gt]: new Date() } },
    ];

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
    ];

    return await this.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Status.getTrendingStatuses = async function (options = {}) {
    const Op = this.sequelize.Op;
    const where = {
      isActive: true,
      isPublic: true,
      createdAt: {
        [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      },
    };

    // Filter out expired statuses
    where[Op.or] = [
      { expiresAt: null },
      { expiresAt: { [Op.gt]: new Date() } },
    ];

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
    ];

    return await this.findAll({
      where,
      include,
      order: [
        ['likeCount', 'DESC'],
        ['viewCount', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit: options.limit || 20,
      offset: options.offset || 0,
    });
  };

  Status.getMoodStatuses = async function (moodType, options = {}) {
    const Op = this.sequelize.Op;
    const where = {
      isActive: true,
      isPublic: true,
      type: 'mood',
      moodType: moodType,
    };

    // Filter out expired statuses
    where[Op.or] = [
      { expiresAt: null },
      { expiresAt: { [Op.gt]: new Date() } },
    ];

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
    ];

    return await this.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Status.cleanupExpiredStatuses = async function () {
    const Op = this.sequelize.Op;
    const result = await this.update(
      { isActive: false },
      {
        where: {
          expiresAt: { [Op.lte]: new Date() },
          isActive: true,
        },
      }
    );

    return result[0] || 0;
  };

  Status.getStatusStats = async function (userId = null) {
    const Op = this.sequelize.Op;
    const where = {};

    if (userId) {
      where.userId = userId;
    }

    const totalStatuses = await this.count({ where });

    const activeStatuses = await this.count({
      where: {
        ...where,
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
      },
    });

    const publicStatuses = await this.count({
      where: {
        ...where,
        isPublic: true,
        isActive: true,
      },
    });

    const moodStatuses = await this.count({
      where: {
        ...where,
        type: 'mood',
        isActive: true,
      },
    });

    const todayStatuses = await this.count({
      where: {
        ...where,
        createdAt: {
          [Op.gte]: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    });

    const totalLikes = await this.sum('likeCount', { where });
    const totalViews = await this.sum('viewCount', { where });
    const totalComments = await this.sum('commentCount', { where });

    return {
      totalStatuses,
      activeStatuses,
      publicStatuses,
      moodStatuses,
      todayStatuses,
      totalLikes: totalLikes || 0,
      totalViews: totalViews || 0,
      totalComments: totalComments || 0,
    };
  };

  return Status;
};