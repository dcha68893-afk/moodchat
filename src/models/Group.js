// --- MODEL: Groups.js ---
const { Op } = require('sequelize');
const crypto = require('crypto');

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
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: false,
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
      tableName: 'Groups',                  // Standardized: lowercase table name
      modelName: 'Groups',                   // Explicit model name
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

  // Instance methods (PRESERVED)
  Groups.prototype.generateInviteLink = async function (expiresInHours = 24) {
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

  // Static methods (PRESERVED)
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
          as: 'groupChatDetails',             // FIXED: Unique alias
          attributes: ['id', 'name', 'description', 'avatar'],
        },
      ],
      limit: options.limit || 20,
      offset: options.offset || 0,
      order: [['createdAt', 'DESC']],
    });
  };

  // FIXED: Associations with unique aliases
  Groups.associate = function(models) {
    if (models.Chats) {
      Groups.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'groupChatDetails',               // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Users) {
      Groups.belongsTo(models.Users, {
        foreignKey: 'createdBy',
        as: 'groupCreatorUser',                // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.GroupMembers) {
      Groups.hasMany(models.GroupMembers, {
        foreignKey: 'groupId',
        as: 'groupMembersList',                 // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Groups;
};