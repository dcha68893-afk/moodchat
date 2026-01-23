// --- MODEL: ChatParticipant.js ---
module.exports = (sequelize, DataTypes) => {
  const ChatParticipant = sequelize.define(
    'ChatParticipant',
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
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Chats',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role: {
        type: DataTypes.ENUM('admin', 'member'),
        defaultValue: 'member',
        allowNull: false,
      },
      isMuted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      joinedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
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
      tableName: 'chat_participants',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          unique: true,
          fields: ['userId', 'chatId'],
          name: 'unique_user_chat',
        },
        {
          fields: ['userId'],
        },
        {
          fields: ['chatId'],
        },
        {
          fields: ['role'],
        },
        {
          fields: ['joinedAt'],
        },
      ],
      hooks: {
        beforeCreate: (participant) => {
          if (!participant.joinedAt) {
            participant.joinedAt = new Date();
          }
        },
      },
    }
  );

  // ===== ASSOCIATIONS =====
  ChatParticipant.associate = function (models) {
    if (models.Users) {
      ChatParticipant.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'user',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Chats) {
      ChatParticipant.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'chat',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  // ===== INSTANCE METHODS =====
  ChatParticipant.prototype.promoteToAdmin = async function () {
    this.role = 'admin';
    return await this.save();
  };

  ChatParticipant.prototype.demoteToMember = async function () {
    this.role = 'member';
    return await this.save();
  };

  ChatParticipant.prototype.mute = async function () {
    this.isMuted = true;
    return await this.save();
  };

  ChatParticipant.prototype.unmute = async function () {
    this.isMuted = false;
    return await this.save();
  };

  ChatParticipant.prototype.getTimeInChat = function () {
    const now = new Date();
    const joined = new Date(this.joinedAt);
    const diffMs = now - joined;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    return {
      days: diffDays,
      hours: diffHours,
      minutes: diffMinutes,
      totalMinutes: Math.floor(diffMs / (1000 * 60)),
    };
  };

  // ===== STATIC METHODS =====
  ChatParticipant.getChatParticipants = async function (chatId, options = {}) {
    const where = { chatId };

    if (options.role) {
      where.role = options.role;
    }

    if (options.isMuted !== undefined) {
      where.isMuted = options.isMuted;
    }

    const include = [];

    if (options.includeUser) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'user',
        attributes: ['id', 'username', 'avatar', 'status', 'lastSeen'],
      });
    }

    return await this.findAll({
      where,
      include: include.length > 0 ? include : undefined,
      order: [['joinedAt', 'ASC']],
      limit: options.limit || 100,
      offset: options.offset || 0,
    });
  };

  ChatParticipant.getUserChats = async function (userId, options = {}) {
    const where = { userId };

    if (options.role) {
      where.role = options.role;
    }

    const include = [];

    if (options.includeChat) {
      include.push({
        model: this.sequelize.models.Chats,
        as: 'chat',
        attributes: ['id', 'name', 'type', 'avatar', 'lastMessageAt'],
      });
    }

    return await this.findAll({
      where,
      include: include.length > 0 ? include : undefined,
      order: [['joinedAt', 'DESC']],
      limit: options.limit || 100,
      offset: options.offset || 0,
    });
  };

  ChatParticipant.getChatAdmins = async function (chatId) {
    return await this.findAll({
      where: {
        chatId,
        role: 'admin',
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'user',
          attributes: ['id', 'username', 'avatar', 'email'],
        },
      ],
      order: [['joinedAt', 'ASC']],
    });
  };

  ChatParticipant.isUserInChat = async function (userId, chatId) {
    const participant = await this.findOne({
      where: {
        userId,
        chatId,
      },
    });

    return !!participant;
  };

  ChatParticipant.getParticipantCount = async function (chatId) {
    return await this.count({
      where: { chatId },
    });
  };

  ChatParticipant.addParticipant = async function (userId, chatId, role = 'member', isMuted = false) {
    const [participant, created] = await this.findOrCreate({
      where: {
        userId,
        chatId,
      },
      defaults: {
        userId,
        chatId,
        role,
        isMuted,
        joinedAt: new Date(),
      },
    });

    if (!created) {
      // Participant already exists, update their status
      participant.role = role;
      participant.isMuted = isMuted;
      await participant.save();
    }

    return participant;
  };

  ChatParticipant.removeParticipant = async function (userId, chatId) {
    const result = await this.destroy({
      where: {
        userId,
        chatId,
      },
    });

    return result > 0;
  };

  ChatParticipant.updateParticipantRole = async function (userId, chatId, newRole) {
    const [affectedRows] = await this.update(
      { role: newRole },
      {
        where: {
          userId,
          chatId,
        },
      }
    );

    return affectedRows > 0;
  };

  ChatParticipant.muteParticipant = async function (userId, chatId, muteStatus = true) {
    const [affectedRows] = await this.update(
      { isMuted: muteStatus },
      {
        where: {
          userId,
          chatId,
        },
      }
    );

    return affectedRows > 0;
  };

  ChatParticipant.bulkAddParticipants = async function (participantsData) {
    const participants = [];

    for (const data of participantsData) {
      const [participant] = await this.findOrCreate({
        where: {
          userId: data.userId,
          chatId: data.chatId,
        },
        defaults: {
          ...data,
          joinedAt: new Date(),
        },
      });

      if (!participant.isNewRecord) {
        // Update existing participant
        await participant.update(data);
      }

      participants.push(participant);
    }

    return participants;
  };

  ChatParticipant.cleanupOrphanedParticipants = async function () {
    // Find participants where either user or chat no longer exists
    const query = `
      DELETE FROM chat_participants cp
      WHERE NOT EXISTS (
        SELECT 1 FROM Users u WHERE u.id = cp.user_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM Chats c WHERE c.id = cp.chat_id
      )
    `;

    const [result] = await this.sequelize.query(query);

    return result.rowCount || 0;
  };

  return ChatParticipant;
};