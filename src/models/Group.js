// --- MODEL: Groups.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Groups = sequelize.define(
    'Groups',
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
          model: 'Chats',
          key: 'id',
        },
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id',
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      avatar: {
        type: DataTypes.STRING,
        allowNull: true,
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
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      }
    },
    {
      tableName: 'Groups',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['chatId'],
          unique: true,
        },
        {
          fields: ['inviteLink'],
        },
        {
          fields: ['isPublic'],
        },
        {
          fields: ['tags'],
          using: 'gin',
        },
      ],
    }
  );

  // Instance methods
  Groups.prototype.generateInviteLink = async function (expiresInHours = 24) {
    const crypto = require('crypto');
    this.inviteLink = crypto.randomBytes(16).toString('hex');
    this.inviteLinkExpires = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    return await this.save();
  };

  Groups.prototype.revokeInviteLink = async function () {
    this.inviteLink = null;
    this.inviteLinkExpires = null;
    return await this.save();
  };

  Groups.prototype.getMemberCount = async function () {
    const count = await this.sequelize.models.ChatParticipant.count({
      where: { chatId: this.chatId },
    });
    return count;
  };

  // Static methods
  Groups.search = async function (query, options = {}) {
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
          model: this.sequelize.models.Chats,
          attributes: ['id', 'name', 'description', 'avatar'],
        },
      ],
      limit: options.limit || 20,
      offset: options.offset || 0,
      order: [['createdAt', 'DESC']],
    });
  };

  // Associations defined in models/index.js
  Groups.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return Groups;
};