// --- MODEL: MessageDeletion.js ---
// See migrations/2026999990020_create_message_deletions.js for the
// rationale. This is additive to, not a replacement for, the existing
// Messages.metadata.deletedFor mechanism already used by the single-message
// "delete for me" path in routes/messages.js.
module.exports = (sequelize, DataTypes) => {
  const MessageDeletion = sequelize.define(
    'MessageDeletion',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'message_deletions',
      modelName: 'MessageDeletion',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        { fields: ['messageId', 'userId'], unique: true },
        { fields: ['userId'] },
      ],
    }
  );

  MessageDeletion.associate = (models) => {
    if (models.Messages) {
      MessageDeletion.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'message',
        onDelete: 'CASCADE',
      });
    }
    if (models.Users) {
      MessageDeletion.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'user',
        onDelete: 'CASCADE',
      });
    }
  };

  return MessageDeletion;
};
