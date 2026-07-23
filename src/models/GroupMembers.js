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
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
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
      // ── P1 FIXES: Proper mute / ban columns ──────────────────────────────
      mutedUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'NULL = not muted; past date = mute expired; future = active mute',
      },
      isBanned: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      banReason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // ── P2 FIXES: Per-group nickname, custom title, warnings ──────────────
      nickname: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Per-group display nickname (Discord-style)',
      },
      customTitle: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Custom admin title (Telegram-style)',
      },
      warnings: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        comment: 'Number of moderation warnings received',
      },
      notificationsMuted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      isFavorite: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      isBlocked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
        comment: 'User has blocked this group: hidden from active lists, notifications suppressed.',
      },
      customSettings: {
        type: DataTypes.JSONB,
        defaultValue: {
          bannedAt: null,
          banReason: null,
          banExpiry: null,
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
      tableName: 'GroupMembers',
      modelName: 'GroupMembers',
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

  // Instance methods (PRESERVED)
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

  // Static methods (PRESERVED)
  GroupMembers.getGroupAdmins = async function (groupId) {
    return await this.findAll({
      where: {
        groupId: groupId,
        role: ['owner', 'admin'],
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'groupMemberUser',
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
          as: 'userGroup',
          include: [
            {
              model: this.sequelize.models.Chats,
              as: 'groupChat',
              attributes: ['id', 'name', 'avatar', 'type'],
            },
          ],
        },
      ],
    });
  };

  // FIXED: Associations with unique aliases
  GroupMembers.associate = function(models) {
    // CRITICAL: Prevent duplicate associations (alias conflict fix)
    if (this.associations && Object.keys(this.associations).length > 0) {
        // Skip if associations already defined to prevent alias conflicts
        return;
    }
        
    if (models.Groups) {
      GroupMembers.belongsTo(models.Groups, {
        foreignKey: 'groupId',
        as: 'userGroup',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Users) {
      GroupMembers.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'groupMemberUser',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return GroupMembers;
};