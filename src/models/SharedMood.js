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
        references: {
          model: 'Users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      moodId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Moods',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
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

  // ===== ASSOCIATIONS =====
  SharedMood.associate = function (models) {
    if (models.Users) {
      SharedMood.belongsTo(models.Users, {
        foreignKey: 'senderId',
        as: 'sender',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });

      SharedMood.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'receiver',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Mood) {
      SharedMood.belongsTo(models.Mood, {
        foreignKey: 'moodId',
        as: 'mood',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  // ===== INSTANCE METHODS =====
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
    
    // Add calculated fields
    values.shareAge = this.getShareAge();
    
    return values;
  };

  // ===== STATIC METHODS =====
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
        as: 'sender',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
      {
        model: this.sequelize.models.Mood,
        as: 'mood',
        attributes: ['id', 'mood', 'intensity', 'notes', 'createdAt', 'userId'],
        include: options.includeMoodUser ? [
          {
            model: this.sequelize.models.Users,
            as: 'moodUser',
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
        as: 'receiver',
        attributes: ['id', 'username', 'avatar', 'status'],
      },
      {
        model: this.sequelize.models.Mood,
        as: 'mood',
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
    // Check if mood is already shared with this receiver
    const existingShare = await this.findOne({
      where: {
        senderId,
        receiverId,
        moodId,
      },
    });

    if (existingShare) {
      // Update existing share
      existingShare.message = message;
      existingShare.isViewed = false;
      existingShare.viewedAt = null;
      await existingShare.save();
      return existingShare;
    }

    // Create new share
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
          as: 'sender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Users,
          as: 'receiver',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Mood,
          as: 'mood',
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
          as: 'sender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Users,
          as: 'receiver',
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
          as: 'receiver',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Mood,
          as: 'mood',
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
          as: 'sender',
          attributes: ['id', 'username', 'avatar'],
        },
        {
          model: this.sequelize.models.Mood,
          as: 'mood',
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
    // Find shares where sender, receiver, or mood no longer exists
    const query = `
      DELETE FROM shared_moods sm
      WHERE NOT EXISTS (
        SELECT 1 FROM Users u WHERE u.id = sm.sender_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM Users u WHERE u.id = sm.receiver_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM Moods m WHERE m.id = sm.mood_id
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
          [this.sequelize.Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
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

  return SharedMood;
};