const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const Group = sequelize.define(
  'Group',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    chatId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: {
        model: 'chats',
        key: 'id',
      },
    },
    ownerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    admins: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      defaultValue: [],
      allowNull: false,
    },
    moderators: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      defaultValue: [],
      allowNull: false,
    },
    inviteCode: {
      type: DataTypes.STRING(50),
      allowNull: true,
      unique: true,
    },
    isPublic: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    memberCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
      validate: {
        min: 0,
      },
    },
    maxMembers: {
      type: DataTypes.INTEGER,
      defaultValue: 100,
      allowNull: false,
      validate: {
        min: 2,
        max: 1000,
      },
    },
    rules: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    topics: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
    },
    groupType: {
      type: DataTypes.ENUM('social', 'work', 'family', 'hobby', 'education', 'other'),
      defaultValue: 'social',
      allowNull: false,
    },
    location: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
    },
  },
  {
    tableName: 'groups',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['chat_id'],
      },
      {
        fields: ['owner_id'],
      },
      {
        fields: ['invite_code'],
      },
      {
        fields: ['is_public'],
      },
      {
        fields: ['group_type'],
      },
    ],
    hooks: {
      beforeCreate: async group => {
        if (!group.inviteCode) {
          group.inviteCode = require('crypto').randomBytes(8).toString('hex');
        }
      },
    },
  }
);

// Instance methods
Group.prototype.addAdmin = async function (userId) {
  if (!this.admins.includes(userId)) {
    this.admins = [...this.admins, userId];
    await this.save();

    // Update participant role
    const ChatParticipant = sequelize.models.ChatParticipant;
    await ChatParticipant.update(
      { role: 'admin' },
      {
        where: {
          chatId: this.chatId,
          userId: userId,
        },
      }
    );
  }
  return this;
};

Group.prototype.removeAdmin = async function (userId) {
  if (userId === this.ownerId) {
    throw new Error('Cannot remove owner from admins');
  }

  this.admins = this.admins.filter(id => id !== userId);
  await this.save();

  // Update participant role to member
  const ChatParticipant = sequelize.models.ChatParticipant;
  await ChatParticipant.update(
    { role: 'member' },
    {
      where: {
        chatId: this.chatId,
        userId: userId,
      },
    }
  );

  return this;
};

Group.prototype.addModerator = async function (userId) {
  if (!this.moderators.includes(userId)) {
    this.moderators = [...this.moderators, userId];
    await this.save();

    // Update participant role
    const ChatParticipant = sequelize.models.ChatParticipant;
    await ChatParticipant.update(
      { role: 'moderator' },
      {
        where: {
          chatId: this.chatId,
          userId: userId,
        },
      }
    );
  }
  return this;
};

Group.prototype.removeModerator = async function (userId) {
  this.moderators = this.moderators.filter(id => id !== userId);
  await this.save();

  // Update participant role to member
  const ChatParticipant = sequelize.models.ChatParticipant;
  await ChatParticipant.update(
    { role: 'member' },
    {
      where: {
        chatId: this.chatId,
        userId: userId,
      },
    }
  );

  return this;
};

Group.prototype.isAdmin = function (userId) {
  return this.admins.includes(userId) || userId === this.ownerId;
};

Group.prototype.isModerator = function (userId) {
  return this.moderators.includes(userId) || this.isAdmin(userId);
};

Group.prototype.canManage = function (userId) {
  return this.isAdmin(userId);
};

Group.prototype.canModerate = function (userId) {
  return this.isModerator(userId);
};

Group.prototype.generateNewInviteCode = async function () {
  this.inviteCode = require('crypto').randomBytes(8).toString('hex');
  return await this.save();
};

// Static methods
Group.findByInviteCode = async function (inviteCode) {
  return await this.findOne({
    where: { inviteCode },
    include: [
      {
        model: sequelize.models.Chat,
        include: [
          {
            model: sequelize.models.ChatParticipant,
            as: 'participants',
            include: [
              {
                model: sequelize.models.User,
                attributes: ['id', 'username', 'avatar'],
              },
            ],
          },
        ],
      },
    ],
  });
};

Group.search = async function (query, options = {}) {
  const where = {
    isPublic: true,
    [Op.or]: [
      { name: { [Op.iLike]: `%${query}%` } },
      { description: { [Op.iLike]: `%${query}%` } },
      { topics: { [Op.contains]: [query] } },
      { tags: { [Op.contains]: [query] } },
    ],
  };

  return await this.findAll({
    where: where,
    include: [
      {
        model: sequelize.models.Chat,
        attributes: ['id', 'name', 'avatar', 'memberCount'],
      },
    ],
    limit: options.limit || 20,
    offset: options.offset || 0,
    order: [['memberCount', 'DESC']],
  });
};

module.exports = Group;
