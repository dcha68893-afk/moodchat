// --- MODEL: Calls.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Calls = sequelize.define(
    'Calls',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        // REMOVED: references - Let associations handle relationships
      },
      callerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        // REMOVED: references - Let associations handle relationships
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        // REMOVED: references - Let associations handle relationships
      },
      groupId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        // REMOVED: references - Let associations handle relationships
      },
      type: {
        type: DataTypes.ENUM('audio', 'video'),
        defaultValue: 'audio',
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(
          'initiated',
          'ringing',
          'in-progress',
          'completed',
          'missed',
          'rejected',
          'cancelled',
          'failed'
        ),
        defaultValue: 'initiated',
        allowNull: false,
      },
      startedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      endedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      duration: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
        comment: 'Duration in seconds',
      },
      participants: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        defaultValue: [],
        allowNull: false,
      },
      participantsJoined: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        defaultValue: [],
        allowNull: false,
      },
      participantsLeft: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        defaultValue: [],
        allowNull: false,
      },
      sdpOffer: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      sdpAnswer: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      iceCandidates: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      recordingUrl: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      transcriptUrl: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      errorReason: {
        type: DataTypes.STRING(200),
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
      }
    },
    {
      tableName: 'Calls',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      // REMOVED ALL INDEXES - Let database keep existing indexes
      indexes: [], // Empty array prevents Sequelize from creating indexes
      // Removed the beforeCreate hook that was generating callId
    }
  );

  // Instance methods
  Calls.prototype.start = async function () {
    this.status = 'in-progress';
    this.startedAt = new Date();
    return await this.save();
  };

  Calls.prototype.end = async function () {
    this.status = 'completed';
    this.endedAt = new Date();

    if (this.startedAt) {
      this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
    }

    return await this.save();
  };

  Calls.prototype.fail = async function (reason) {
    this.status = 'failed';
    this.endedAt = new Date();
    this.errorReason = reason;

    if (this.startedAt) {
      this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
    }

    return await this.save();
  };

  Calls.prototype.addParticipant = async function (userId) {
    if (!this.participants.includes(userId)) {
      this.participants = [...this.participants, userId];
    }

    if (!this.participantsJoined.includes(userId)) {
      this.participantsJoined = [...this.participantsJoined, userId];
    }

    return await this.save();
  };

  Calls.prototype.removeParticipant = async function (userId) {
    if (!this.participantsLeft.includes(userId)) {
      this.participantsLeft = [...this.participantsLeft, userId];
    }

    return await this.save();
  };

  Calls.prototype.addIceCandidate = async function (candidate) {
    this.iceCandidates = [...this.iceCandidates, candidate];
    return await this.save();
  };

  // Static methods
  Calls.getActiveCalls = async function (chatId = null) {
    const where = {
      status: ['initiated', 'ringing', 'in-progress'],
    };

    if (chatId) {
      where.chatId = chatId;
    }

    // Check if models are available
    const include = [];
    
    if (this.sequelize.models.Chats) {
      include.push({
        model: this.sequelize.models.Chats,
        attributes: ['id', 'name', 'type'],
      });
    }
    
    if (this.sequelize.models.Users) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'caller',
        attributes: ['id', 'username', 'avatar'],
      });
    }

    return await this.findAll({
      where: where,
      include: include.length > 0 ? include : undefined,
    });
  };

  Calls.getUserCalls = async function (userId, options = {}) {
    const where = {
      [Op.or]: [
        { callerId: userId }, 
        { receiverId: userId }, 
        { participants: { [Op.contains]: [userId] } }
      ],
    };

    if (options.status) {
      where.status = options.status;
    }

    if (options.type) {
      where.type = options.type;
    }

    // Check if models are available
    const include = [];
    
    if (this.sequelize.models.Chats) {
      include.push({
        model: this.sequelize.models.Chats,
        attributes: ['id', 'name', 'type'],
      });
    }
    
    if (this.sequelize.models.Users) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'caller',
        attributes: ['id', 'username', 'avatar'],
      });
    }

    return await this.findAll({
      where: where,
      include: include.length > 0 ? include : undefined,
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Calls.findActiveCall = async function (chatId) {
    return await this.findOne({
      where: {
        chatId: chatId,
        status: ['initiated', 'ringing', 'in-progress'],
      },
    });
  };

  // Associations defined in models/index.js
  Calls.associate = function (models) {
    // Only define associations here - constraints are handled in models/index.js
    if (models.Chats) {
      Calls.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        constraints: false,  // CRITICAL: Prevents FK constraint recreation
      });
    }
    
    // Note: Other associations (callerId, receiverId, groupId) are optional
    // Let models/index.js handle them with constraints: false
  };

  return Calls;
};