module.exports = (sequelize, DataTypes) => {
  const StatusReply = sequelize.define(
    'StatusReply',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      statusId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      senderId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      content: {
        type: DataTypes.TEXT,
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
      tableName: 'status_replies',
      modelName: 'StatusReply',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        { fields: ['statusId'], name: 'idx_status_replies_status' },
        { fields: ['senderId'], name: 'idx_status_replies_sender' },
        { fields: ['receiverId'], name: 'idx_status_replies_receiver' },
        { fields: ['messageId'], name: 'idx_status_replies_message' },
      ],
    }
  );

  StatusReply.associate = function(models) {
    if (StatusReply._associationsDefined) return;
    StatusReply._associationsDefined = true;

    if (models.Status) {
      StatusReply.belongsTo(models.Status, {
        foreignKey: 'statusId',
        as: 'status',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Users) {
      StatusReply.belongsTo(models.Users, {
        foreignKey: 'senderId',
        as: 'replySender',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });

      StatusReply.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'replyReceiver',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Messages) {
      StatusReply.belongsTo(models.Messages, {
        foreignKey: 'messageId',
        as: 'replyMessage',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  };

  return StatusReply;
};
