const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      isPublic: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      inviteLink: {
        type: DataTypes.STRING(100),
        allowNull: true,
        unique: true,
      },
      inviteLinkExpires: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      maxMembers: {
        type: DataTypes.INTEGER,
        defaultValue: 100,
        allowNull: false,
      },
      rules: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      location: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      isVerified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      stats: {
        type: DataTypes.JSONB,
        defaultValue: {
          totalMessages: 0,
          totalMembers: 0,
          dailyActiveUsers: 0,
          weeklyActiveUsers: 0,
        },
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
          unique: true,
        },
        {
          fields: ['invite_link'],
        },
        {
          fields: ['is_public'],
        },
        {
          fields: ['tags'],
          using: 'gin',
        },
      ],
    }
  );

  // Instance methods
  Group.prototype.generateInviteLink = async function (expiresInHours = 24) {
    const crypto = require('crypto');
    this.inviteLink = crypto.randomBytes(16).toString('hex');
    this.inviteLinkExpires = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    return await this.save();
  };

  Group.prototype.revokeInviteLink = async function () {
    this.inviteLink = null;
    this.inviteLinkExpires = null;
    return await this.save();
  };

  Group.prototype.getMemberCount = async function () {
    const count = await this.sequelize.models.ChatParticipant.count({
      where: { chatId: this.chatId },
    });
    return count;
  };

  // Static methods
  Group.search = async function (query, options = {}) {
    const where = {
      isPublic: true,
      [Op.or]: [
        { name: { [Op.iLike]: `%${query}%` } },
        { description: { [Op.iLike]: `%${query}%` } },
        { tags: { [Op.contains]: [query] } },
      ],
    };

    return await this.findAll({
      where: where,
      include: [
        {
          model: this.sequelize.models.Chat,
          attributes: ['id', 'name', 'description', 'avatar'],
        },
      ],
      limit: options.limit || 20,
      offset: options.offset || 0,
      order: [['createdAt', 'DESC']],
    });
  };

  return Group;
};