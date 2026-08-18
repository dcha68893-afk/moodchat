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
        allowNull: true,   // null when call started directly via participantIds (chat created lazily)
      },
      callerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      receiverId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      groupId: {
        type: DataTypes.INTEGER,
        allowNull: true,
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
      // ── NEW: tracks who answered / declined / read this call ──────────────
      answeredBy: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        field: 'answered_by',
        defaultValue: [],
        allowNull: false,
        comment: 'User IDs that answered this call',
      },
      declinedBy: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        field: 'declined_by',
        defaultValue: [],
        allowNull: false,
        comment: 'User IDs that declined / rejected this call',
      },
      readBy: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        field: 'read_by',
        defaultValue: [],
        allowNull: false,
        comment: 'User IDs that have read/acknowledged a missed call notification',
      },
      isGroupCall: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      // ─────────────────────────────────────────────────────────────────────
      errorReason: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      // ── Quality & Network Metrics ─────────────────────────────────────────
      qualityScore: {
        type: DataTypes.FLOAT,
        allowNull: true,
        comment: 'Average call quality score 0-5 (MOS-like)',
      },
      networkStats: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
        comment: 'RTT, packet loss, jitter, bitrate snapshots',
      },
      postCallRating: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'User-submitted post-call rating 1-5',
      },
      postCallFeedback: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Optional user feedback text after call',
      },
      recordingStatus: {
        type: DataTypes.ENUM('none', 'recording', 'stopped', 'uploaded', 'failed'),
        defaultValue: 'none',
        allowNull: false,
      },
      scheduledAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When this call is scheduled to start (null = instant call)',
      },
      scheduledTitle: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: 'Optional title for scheduled calls',
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
      modelName: 'Calls',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        { fields: ['chatId'] },
        { fields: ['callerId'] },
        { fields: ['receiverId'] },
        { fields: ['status'] },
        { fields: ['createdAt'] },
        { fields: ['receiverId', 'status'], name: 'calls_receiver_status_idx' },
        // H-06 FIX: _cleanupTimedOut() runs WHERE status IN (...) AND
        // createdAt < ? on every call — full table scan with only
        // single-column indexes. A composite index makes this O(log n)
        // regardless of table size. Second composite covers the history
        // query: WHERE participants @> [userId] AND endedAt IS NOT NULL
        // ORDER BY endedAt DESC — the GIN index makes the array contains
        // check fast; the (endedAt) index covers the sort.
        { fields: ['status', 'createdAt'], name: 'calls_status_created_idx' },
        { fields: ['status', 'endedAt'],   name: 'calls_status_ended_idx' },
        {
          fields: ['participants'],
          using:  'gin',
          name:   'calls_participants_gin_idx',
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
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

  // Static methods (PRESERVED)
  Calls.getActiveCalls = async function (chatId = null) {
    const where = {
      status: { [Op.in]: ['initiated', 'ringing', 'in-progress'] },
    };

    if (chatId) {
      where.chatId = chatId;
    }

    const include = [];
    
    if (this.sequelize.models.Chats) {
      include.push({
        model: this.sequelize.models.Chats,
        as: 'callChatDetails',
        attributes: ['id', 'name', 'type'],
      });
    }
    
    if (this.sequelize.models.Users) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'callInitiatorUser',
        attributes: ['id', 'username', 'avatar'],
      });
      
      include.push({
        model: this.sequelize.models.Users,
        as: 'callTargetUser',
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

    const include = [];
    
    if (this.sequelize.models.Chats) {
      include.push({
        model: this.sequelize.models.Chats,
        as: 'callChatDetails',
        attributes: ['id', 'name', 'type'],
      });
    }
    
    if (this.sequelize.models.Users) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'callInitiatorUser',
        attributes: ['id', 'username', 'avatar'],
      });
      
      include.push({
        model: this.sequelize.models.Users,
        as: 'callTargetUser',
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
        status: { [Op.in]: ['initiated', 'ringing', 'in-progress'] },
      },
    });
  };

  // FIXED: Associations with unique aliases
  // Use a module-level flag to prevent double-association on hot-reload
  let _associationsSetUp = false;
  Calls.associate = function (models) {
    if (_associationsSetUp) return;
    _associationsSetUp = true;

    if (models.Chats) {
      Calls.belongsTo(models.Chats, {
        foreignKey: 'chatId',
        as: 'callChatDetails',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Users) {
      Calls.belongsTo(models.Users, {
        foreignKey: 'callerId',
        as: 'callInitiatorUser',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });

      Calls.belongsTo(models.Users, {
        foreignKey: 'receiverId',
        as: 'callTargetUser',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }

    if (models.Groups) {
      Calls.belongsTo(models.Groups, {
        foreignKey: 'groupId',
        as: 'callGroupDetails',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  };

  // ── AUTO-MIGRATION: add ALL missing columns if they don't exist ───────────
  // Covers every column added after the initial table creation so the server
  // never crashes with "column X does not exist".
  // Runs once per process via a flag on the sequelize instance (idempotent).
  if (!sequelize._callsColumnsMigrated) {
    sequelize._callsColumnsMigrated = true;
    setImmediate(async () => {
      try {
        const qi = sequelize.getQueryInterface();
        const tableDesc = await qi.describeTable('Calls').catch(() => null);
        if (!tableDesc) return; // table doesn't exist yet — sync will create it

        // ── CRITICAL: ensure chatId allows NULL (was originally NOT NULL in some migrations)
        try {
          await sequelize.query(`ALTER TABLE "Calls" ALTER COLUMN "chatId" DROP NOT NULL;`);
        } catch(e) { /* already nullable — ignore */ }

        // Each entry: { name: DB column name, sql: column definition, aliases: [] }
        const colsToAdd = [
          // ── Array tracking fields (camelCase model → snake_case DB column) ──
          // FIX (CALLS-PARTICIPANTS-MISSING): `participants` (the base array of
          // all call participant user IDs — used by getUserCalls' history
          // query and by the calls_participants_gin index) was never in this
          // self-heal list, even though the derived participantsJoined/
          // participantsLeft arrays right below it were. On any database
          // where the original createcalls migration didn't already have this
          // column, 20260701000001-add-call-composite-indexes.js's
          // `CREATE INDEX ... ON "Calls" USING gin (participants)` failed
          // with "column participants does not exist" — a hard failure in
          // the strict production migrate path that blocked every migration
          // after it (including 2026999990017_create_offline_message_queue.js,
          // which is why offline-message redelivery was failing in
          // production). Reproduced against a real deploy.
          { name: 'participants',       sql: "INTEGER[] NOT NULL DEFAULT '{}'" },
          { name: 'answered_by',        sql: "INTEGER[] NOT NULL DEFAULT '{}'" },
          { name: 'declined_by',        sql: "INTEGER[] NOT NULL DEFAULT '{}'" },
          { name: 'read_by',            sql: "INTEGER[] NOT NULL DEFAULT '{}'" },
          { name: 'participantsJoined', sql: "INTEGER[] NOT NULL DEFAULT '{}'" },
          { name: 'participantsLeft',   sql: "INTEGER[] NOT NULL DEFAULT '{}'" },

          // ── WebRTC signalling fields ──────────────────────────────────────
          { name: 'sdpOffer',    sql: 'TEXT' },
          { name: 'sdpAnswer',   sql: 'TEXT' },
          { name: 'iceCandidates', sql: "JSONB NOT NULL DEFAULT '[]'" },

          // ── Recording / transcript links ───────────────────────────────────
          { name: 'recordingUrl',  sql: 'VARCHAR(255)' },
          { name: 'transcriptUrl', sql: 'VARCHAR(255)' },

          // ── Metadata JSONB blob ────────────────────────────────────────────
          { name: 'metadata', sql: "JSONB NOT NULL DEFAULT '{}'" },

          // ── Group-call flag ────────────────────────────────────────────────
          { name: 'isGroupCall', sql: 'BOOLEAN NOT NULL DEFAULT FALSE' },

          // ── Error reason ──────────────────────────────────────────────────
          { name: 'errorReason', sql: 'VARCHAR(200)' },

          // ── Quality & Network Metrics (added audit fix) ───────────────────
          { name: 'qualityScore',     sql: 'FLOAT' },
          { name: 'networkStats',     sql: "JSONB NOT NULL DEFAULT '{}'" },
          { name: 'postCallRating',   sql: 'INTEGER' },
          { name: 'postCallFeedback', sql: 'TEXT' },
          { name: 'recordingStatus',  sql: "VARCHAR(20) NOT NULL DEFAULT 'none'" },
          { name: 'scheduledAt',      sql: 'TIMESTAMPTZ' },
          { name: 'scheduledTitle',   sql: 'VARCHAR(200)' },
        ];

        for (const col of colsToAdd) {
          // Check both the exact name and common camelCase/snake_case variants
          const present = tableDesc[col.name]
            || tableDesc[col.name.toLowerCase()]
            || tableDesc[col.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')];

          if (!present) {
            try {
              await sequelize.query(
                `ALTER TABLE "Calls" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.sql};`
              );
              console.log(`[Call model] ✅ Added missing column: ${col.name}`);
            } catch (colErr) {
              // Non-fatal: column may have been added by a concurrent process
              console.warn(`[Call model] Could not add column ${col.name} (non-fatal):`, colErr.message);
            }
          }
        }
      } catch (err) {
        console.error('[Call model] Auto-migration error (non-fatal):', err.message);
      }
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  return Calls;
};