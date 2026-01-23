// --- MODEL: GroupMembers.js ---
module.exports = (sequelize, DataTypes) => {
  const GroupMembers = sequelize.define(
    'GroupMembers',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      groupId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Group',
          key: 'id',
        },
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id',
        },
      },
      role: {
        type: DataTypes.ENUM('owner', 'admin', 'moderator', 'member'),
        defaultValue: 'member',
        allowNull: false,
      },
      joinedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      leftAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      notificationsMuted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      customSettings: {
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
      }
    },
    {
      tableName: 'GroupMembers',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['groupId', 'userId'],
          unique: true,
        },
        {
          fields: ['groupId'],
        },
        {
          fields: ['userId'],
        },
        {
          fields: ['role'],
        },
      ],
    }
  );

  // Instance methods
  GroupMembers.prototype.promoteToAdmin = async function () {
    this.role = 'admin';
    return await this.save();
  };

  GroupMembers.prototype.demoteToMember = async function () {
    this.role = 'member';
    return await this.save();
  };

  GroupMembers.prototype.leaveGroup = async function () {
    this.leftAt = new Date();
    return await this.save();
  };

  // Static methods
  GroupMembers.getGroupAdmins = async function (groupId) {
    return await this.findAll({
      where: {
        groupId: groupId,
        role: ['owner', 'admin'],
      },
      include: [
        {
          model: this.sequelize.models.Users,
          attributes: ['id', 'username', 'avatar', 'email'],
        },
      ],
    });
  };

  GroupMembers.getUserGroups = async function (userId) {
    return await this.findAll({
      where: {
        userId: userId,
        leftAt: null,
      },
      include: [
        {
          model: this.sequelize.models.Groups,
          include: [
            {
              model: this.sequelize.models.Chats,
              attributes: ['id', 'name', 'avatar', 'type'],
            },
          ],
        },
      ],
    });
  };

  // Associations defined in models/index.js
  GroupMembers.associate = function(models) {
    // All associations are defined in models/index.js
  };

  return GroupMembers;
};