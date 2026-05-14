// --- MODEL: SharedMood.js ---
module.exports = (sequelize, DataTypes) => {
  const SharedMood = sequelize.define(
    'SharedMood',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      senderId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      moodId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: {
          len: {
            args: [0, 1000],
            msg: 'Message must be less than 1000 characters',
          },
        },
      },
      isViewed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      viewedAt: {
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
      tableName: 'shared_moods',
      modelName: 'SharedMood',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['senderId'],
          name: 'idx_shared_moods_sender',
        },
        {
          fields: ['receiverId'],
          name: 'idx_shared_moods_receiver',
        },
        {
          fields: ['moodId'],
          name: 'idx_shared_moods_mood',
        },
        {
          fields: ['createdAt'],
          name: 'idx_shared_moods_created',
        },
        {
          fields: ['isViewed'],
          name: 'idx_shared_moods_viewed',
        },
        {
          fields: ['senderId', 'receiverId'],
          name: 'idx_shared_moods_sender_receiver',
        },
        {
          fields: ['receiverId', 'isViewed'],
          name: 'idx_shared_moods_receiver_viewed',
        },
      ],
      hooks: {
        beforeCreate: (sharedMood) => {
          if (!sharedMood.createdAt) {
            sharedMood.createdAt = new Date();
          }
        },
        beforeUpdate: (sharedMood) => {
          if (sharedMood.changed('isViewed') && sharedMood.isViewed && !sharedMood.viewedAt) {
            sharedMood.viewedAt = new Date();
          }
        },
      },
    }
  );

  // Instance methods (PRESERVED)
  SharedMood.prototype.markAsViewed = async function () {
    this.isViewed = true;
    this.viewedAt = new Date();
    return await this.save();
  };

  SharedMood.prototype.markAsUnviewed = async function () {
    this.isViewed = false;
    this.viewedAt = null;
    return await this.save();
  };

  SharedMood.prototype.updateMessage = async function (newMessage) {
    this.message = newMessage;
    return await this.save();
  };

  SharedMood.prototype.getShareAge = function () {
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

  SharedMood.prototype.toJSON = function () {
    const values = Object.assign({}, this.get());
    values.shareAge = this.getShareAge();
    return values;
  };

  // Static methods (PRESERVED)
  SharedMood.getReceivedMoods = async function (receiverId, options = {}) {
    const where = { receiverId };

    if (options.viewed !== undefined) {
      where.isViewed = options.viewed;
    }

    if (options.senderId) {
      where.senderId = options.senderId;
    }

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'sharedMoodSender',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
      {
        model: this.sequelize.models.Mood,
        as: 'sharedMood',
        attributes: ['id', 'mood', 'intensity', 'notes', 'createdAt', 'userId'],
        include: options.includeMoodUser ? [
          {
            model: this.sequelize.models.Users,
            as: 'moodOwner',
            attributes: ['id', 'username', 'avatar'],
          },
        ] : undefined,
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

  SharedMood.getSentMoods = async function (senderId, options = {}) {
    const where = { senderId };

    if (options.receiverId) {
      where.receiverId = options.receiverId;
    }

    const include = [
      {
        model: this.sequelize.models.Users,
        as: 'sharedMoodReceiver',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
      {
        model: this.sequelize.models.Mood,
        as: 'sharedMood',
        attributes: ['id', 'mood', 'intensity', 'notes', 'createdAt'],
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

  SharedMood.getUnviewedCount = async function (receiverId) {
    return await this.count({
      where: {
        receiverId,
        isViewed: false,
      },
    });
  };

  SharedMood.markAllAsViewed = async function (receiverId) {
    const [affectedRows] = await this.update(
      {
        isViewed: true,
        viewedAt: new Date(),
      },
      {
        where: {
          receiverId,
          isViewed: false,
        },
      }
    );

    return affectedRows;
  };

  SharedMood.shareMood = async function (senderId, receiverId, moodId, message = null) {
    const existingShare = await this.findOne({
      where: {
        senderId,
        receiverId,
        moodId,
      },
    });

    if (existingShare) {
      existingShare.message = message;
      existingShare.isViewed = false;
      existingShare.viewedAt = null;
      await existingShare.save();
      return existingShare;
    }

    return await this.create({
      senderId,
      receiverId,
      moodId,
      message,
      isViewed: false,
      createdAt: new Date(),
    });
  };

  SharedMood.bulkShareMood = async function (senderId, receiverIds, moodId, message = null) {
    const shares = [];

    for (const receiverId of receiverIds) {
      const share = await this.shareMood(senderId, receiverId, moodId, message);
      shares.push(share);
    }

    return shares;
  };

  SharedMood.getSharedMood = async function (senderId, receiverId, moodId) {
    return await this.findOne({
      where: {
        senderId,
        receiverId,
        moodId,
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'sharedMoodSender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Users,
          as: 'sharedMoodReceiver',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Mood,
          as: 'sharedMood',
          attributes: ['id', 'mood', 'intensity', 'notes', 'createdAt'],
        },
      ],
    });
  };

  SharedMood.getMoodShares = async function (moodId) {
    return await this.findAll({
      where: { moodId },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'sharedMoodSender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Users,
          as: 'sharedMoodReceiver',
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  };

  SharedMood.getRecentShares = async function (userId, limit = 10) {
    const sentShares = await this.findAll({
      where: { senderId: userId },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'sharedMoodReceiver',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Mood,
          as: 'sharedMood',
          attributes: ['id', 'mood', 'intensity'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.floor(limit / 2),
    });

    const receivedShares = await this.findAll({
      where: { receiverId: userId },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'sharedMoodSender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Mood,
          as: 'sharedMood',
          attributes: ['id', 'mood', 'intensity'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.ceil(limit / 2),
    });

    return [...sentShares, ...receivedShares].sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    ).slice(0, limit);
  };

  SharedMood.deleteShare = async function (senderId, receiverId, moodId) {
    const result = await this.destroy({
      where: {
        senderId,
        receiverId,
        moodId,
      },
    });

    return result > 0;
  };

  SharedMood.cleanupOrphanedShares = async function () {
    const query = `
      DELETE FROM shared_moods sm
      WHERE NOT EXISTS (
        SELECT 1 FROM Users u WHERE u.id = sm.senderId
      )
      OR NOT EXISTS (
        SELECT 1 FROM Users u WHERE u.id = sm.receiverId
      )
      OR NOT EXISTS (
        SELECT 1 FROM moods m WHERE m.id = sm.moodId
      )
    `;

    const [result] = await this.sequelize.query(query);
    return result.rowCount || 0;
  };

  SharedMood.getShareStats = async function (userId) {
    const sentCount = await this.count({
      where: { senderId: userId },
    });

    const receivedCount = await this.count({
      where: { receiverId: userId },
    });

    const unviewedCount = await this.count({
      where: {
        receiverId: userId,
        isViewed: false,
      },
    });

    const recentShares = await this.count({
      where: {
        [this.sequelize.Op.or]: [
          { senderId: userId },
          { receiverId: userId },
        ],
        createdAt: {
          [this.sequelize.Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      },
    });

    return {
      sentCount,
      receivedCount,
      unviewedCount,
      recentShares,
      totalShares: sentCount + receivedCount,
    };
  };

  // FIXED: Associations with unique aliases
  SharedMood.associate = function (models) {
    // CRITICAL: Prevent duplicate associations (alias conflict fix)
    if (this.associations && Object.keys(this.associations).length > 0) {
        // Skip if associations already defined to prevent alias conflicts
        return;
    }
        
    if (models.Users) {
      SharedMood.belongsTo(models.Users, {
        foreignKey: 'senderId',
        as: 'sharedMoodSender',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });

      SharedMood.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'sharedMoodReceiver',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Mood) {
      SharedMood.belongsTo(models.Mood, {
        foreignKey: 'moodId',
        as: 'sharedMood',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return SharedMood;
};