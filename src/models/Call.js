const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
// Remove: const sequelize = require('./index');

module.exports = (sequelize, DataTypes) => {
  const Call = sequelize.define(
    'Call',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      callId: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      chatId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'chats',
          key: 'id',
        },
      },
      initiatorId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
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
    },
    {
      tableName: 'calls',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ['call_id'],
        },
        {
          fields: ['chat_id'],
        },
        {
          fields: ['initiator_id'],
        },
        {
          fields: ['status'],
        },
        {
          fields: ['started_at'],
        },
        {
          fields: ['created_at'],
        },
      ],
      hooks: {
        beforeCreate: async call => {
          if (!call.callId) {
            const crypto = require('crypto');
            call.callId = crypto.randomUUID();
          }
        },
      },
    }
  );

  // Instance methods
  Call.prototype.start = async function () {
    this.status = 'in-progress';
    this.startedAt = new Date();
    return await this.save();
  };

  Call.prototype.end = async function () {
    this.status = 'completed';
    this.endedAt = new Date();

    if (this.startedAt) {
      this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
    }

    return await this.save();
  };

  Call.prototype.fail = async function (reason) {
    this.status = 'failed';
    this.endedAt = new Date();
    this.errorReason = reason;

    if (this.startedAt) {
      this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
    }

    return await this.save();
  };

  Call.prototype.addParticipant = async function (userId) {
    if (!this.participants.includes(userId)) {
      this.participants = [...this.participants, userId];
    }

    if (!this.participantsJoined.includes(userId)) {
      this.participantsJoined = [...this.participantsJoined, userId];
    }

    return await this.save();
  };

  Call.prototype.removeParticipant = async function (userId) {
    if (!this.participantsLeft.includes(userId)) {
      this.participantsLeft = [...this.participantsLeft, userId];
    }

    return await this.save();
  };

  Call.prototype.addIceCandidate = async function (candidate) {
    this.iceCandidates = [...this.iceCandidates, candidate];
    return await this.save();
  };

  // Static methods - IMPORTANT: These need to be defined AFTER associations are set up
  // We'll remove the static methods that reference other models here
  // and define them later in the index.js file or after associations

  Call.getActiveCalls = async function (chatId = null) {
    const where = {
      status: ['initiated', 'ringing', 'in-progress'],
    };

    if (chatId) {
      where.chatId = chatId;
    }

    return await this.findAll({
      where: where,
      include: [
        {
          model: this.sequelize.models.Chat,
          attributes: ['id', 'name', 'type'],
        },
        {
          model: this.sequelize.models.User,
          as: 'initiator',
          attributes: ['id', 'username', 'avatar'],
        },
      ],
    });
  };

  Call.getUserCalls = async function (userId, options = {}) {
    const where = {
      [Op.or]: [{ initiatorId: userId }, { participants: { [Op.contains]: [userId] } }],
    };

    if (options.status) {
      where.status = options.status;
    }

    if (options.type) {
      where.type = options.type;
    }

    return await this.findAll({
      where: where,
      include: [
        {
          model: this.sequelize.models.Chat,
          attributes: ['id', 'name', 'type'],
        },
        {
          model: this.sequelize.models.User,
          as: 'initiator',
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Call.findActiveCall = async function (chatId) {
    return await this.findOne({
      where: {
        chatId: chatId,
        status: ['initiated', 'ringing', 'in-progress'],
      },
    });
  };

  return Call;
};