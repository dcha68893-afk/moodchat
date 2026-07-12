const _slog = (...a) => { if (process.env.DEBUG_SERVER) _slog(...a); };
// models/index.js - COMPLETE AUTO-MIGRATION WITH TABLE CREATION
// Version: 3.0.0 - Creates missing tables and columns automatically
const { Sequelize, Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ===== DATABASE CONFIGURATION =====
const env = process.env.NODE_ENV || 'development';

const getDbConfig = () => {
  if (process.env.DATABASE_URL) {
    _slog(`[Database] Using DATABASE_URL for ${env} environment`);
    return {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      // FIX-EMAXCONNSESSION: this is now the ONLY Sequelize pool in the
      // process (config/database.js reuses this same instance instead of
      // opening a second one — see that file for the full explanation).
      // The Supabase/Postgres pooler runs in PgBouncer "session" mode with
      // pool_size 15, so the app's own pool max must stay comfortably below
      // that — 20/min:5 was already over budget on its own before the
      // second pool was even added. Defaults dropped to max:8/min:0; still
      // overridable via DB_POOL_MAX/DB_POOL_MIN if the pooler's limit changes.
      pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 8,
        min: parseInt(process.env.DB_POOL_MIN) || 0,
        acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
        idle: parseInt(process.env.DB_POOL_IDLE) || 10000
      },
      dialectOptions: (process.env.DB_SSL === 'true' || process.env.RENDER || process.env.RENDER_SERVICE_ID) ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      } : {},
    };
  }
  
  _slog(`[Database] Using individual config for ${env} environment`);
  // FIX-DB-NO-SILENT-FALLBACK: previously defaulted to a meaningless
  // hardcoded database name ('denismoo') if DB_NAME was unset. That meant
  // a missing/misconfigured env var on Render would silently try to
  // connect to a database that doesn't exist, instead of failing with a
  // clear, actionable error. Fail loudly here — this only triggers when
  // BOTH DATABASE_URL and DB_NAME are absent, which should never happen
  // in a correctly configured deployment.
  if (!process.env.DB_NAME) {
    throw new Error(
      '[Database] No database configured: neither DATABASE_URL nor DB_NAME ' +
      'environment variables are set. Set DATABASE_URL (preferred) or ' +
      'DB_NAME + DB_HOST + DB_USER + DB_PASSWORD in your environment.'
    );
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    dialect: process.env.DB_DIALECT || 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    // FIX-EMAXCONNSESSION: see matching comment above in the DATABASE_URL
    // branch — kept in sync so both code paths respect the pooler's 15
    // session-mode client limit.
    pool: {
      max: parseInt(process.env.DB_POOL_MAX) || 8,
      min: parseInt(process.env.DB_POOL_MIN) || 0,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
      idle: parseInt(process.env.DB_POOL_IDLE) || 10000
    },
    dialectOptions: (process.env.DB_SSL === 'true' || process.env.RENDER || process.env.RENDER_SERVICE_ID) ? {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    } : {},
  };
};

const dbConfig = getDbConfig();

// ===== SEQUELIZE INITIALIZATION =====
const sequelize = dbConfig.url
  ? new Sequelize(dbConfig.url, {
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      dialectOptions: dbConfig.dialectOptions,
      define: {
        timestamps: true,
        underscored: false,
        freezeTableName: true,
        paranoid: false,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    })
  : new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      dialectOptions: dbConfig.dialectOptions,
      define: {
        timestamps: true,
        underscored: false,
        freezeTableName: true,
        paranoid: false,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    });

// ===== DATABASE CONNECTION TEST =====
global.__dbReadyPromise = new Promise(r => { global.__dbReadyResolve = r; });
// If DB init completes in <1s, resolve immediately
setTimeout(() => { if (global.__dbReadyResolve && !global.__dbReady) {} }, 60000);
sequelize.authenticate()
  .then(() => {
    _slog(`[Database] ✅ Connection to ${dbConfig.database || 'database'} (${env}) established successfully`);
  })
  .catch(err => {
    console.error(`[Database] ❌ Unable to connect to database (${env}):`, err.message);
  });

// ===== STRICT MODEL LOADING =====
_slog('[Database] 🛡️ Initializing STRICT model loader...');

const db = {
  sequelize,
  Sequelize,
  Op,
  models: {},
  failedModels: {},
  skippedFiles: {},
  associationErrors: {},
  wss: null
};

// CRITICAL: Whitelist of all expected model files - ORDERED BY DEPENDENCIES
const MODEL_WHITELIST = [
  // ── Core user models ────────────────────────────────────────────────────────
  'Users', 'Token', 'Profile', 'Settings',
  // ── Chat & messaging ────────────────────────────────────────────────────────
  'Chats', 'ChatParticipant',
  'Messages', 'Message', 'MessageReport', 'StarredMessage', 'ScheduledMessage', 'PinnedMessage', 'LiveLocationSession',
  // ── Social & presence ───────────────────────────────────────────────────────
  'GroupMembers', 'TypingIndicator', 'UserStatus', 'ReadReceipt',
  'SharedMood', 'Notification', 'Friend',
  // ── Calls ───────────────────────────────────────────────────────────────────
  'Calls', 'Call',
  // ── Groups ──────────────────────────────────────────────────────────────────
  'Groups', 'Group',
  // ── Media & content ─────────────────────────────────────────────────────────
  'Media', 'Mood', 'Notes', 'File', 'Features', 'Category', 'Template',
  // ── Status / Story ──────────────────────────────────────────────────────────
  'Status', 'StatusView', 'StatusReaction', 'StatusReply', 'StatusComment', 'StatusLike',
  // ── Push notifications ───────────────────────────────────────────────────────
  'PushSubscription',
  // ── Games ───────────────────────────────────────────────────────────────────
  'GameProgress', 'GameChallenge',
  // ── Moderation ──────────────────────────────────────────────────────────────
  'ModerationLog', 'AuditLog',
  // ── Marketplace ─────────────────────────────────────────────────────────────
  'Tool', 'Order', 'Review', 'Cart', 'Coupon', 'Wishlist',
  'Wallet', 'WalletTransaction', 'Refund', 'Payout', 'SellerProfile',
  // ── Account security ────────────────────────────────────────────────────────
  'PasswordHistory',
  // ── Group OS ────────────────────────────────────────────────────────────────
  'GroupTask', 'GroupTaskAssignment',
  'GroupEvent', 'GroupAttendance',
  'GroupPoll', 'GroupPollOption', 'GroupPollVote',
  'GroupNote', 'GroupThread',
  'GroupFile', 'GroupFinance',
  'GroupAISummary', 'GroupActivityLog', 'GroupAnalytics',
];

// CRITICAL: Patterns that indicate NON-MODEL files
const NON_MODEL_PATTERNS = [
  'authRoutes', 'authController', 'userController', 'chatController', 'friendController',
  'groupController', 'messageController', 'notificationController',
  'authMiddleware', 'errorMiddleware', 'validationMiddleware',
  'index', 'utils', 'helpers', 'validators', 'schemas',
  'routes', 'controllers', 'middleware', 'services',
  'auth.route', 'user.route', 'chat.route', 'friend.route', 'group.route',
  'message.route', 'notification.route', 'status.route',
  'router.get', 'router.post', 'router.put', 'router.delete', 'router.use',
  'app.get', 'app.post', 'app.put', 'app.delete', 'app.use',
  'express.Router()', 'express.Router(',
  'gameDailyReminder', // cron job — not a Sequelize model; lives in src/jobs/
];

// ===== MODEL FILE VALIDATION =====
_slog('[Database] Scanning for REAL Sequelize models only...');

const modelFiles = fs.readdirSync(__dirname)
  .filter(file => {
    const filePath = path.join(__dirname, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      _slog(`[Database] 📁 Skipping directory: ${file}`);
      db.skippedFiles[file] = 'Directory (not a model file)';
      return false;
    }
    
    if (!file.endsWith('.js')) {
      _slog(`[Database] 📄 Skipping non-JS file: ${file}`);
      db.skippedFiles[file] = 'Not a JavaScript file';
      return false;
    }
    
    if (file === 'index.js') {
      _slog(`[Database] 🔧 Skipping model index file: ${file}`);
      db.skippedFiles[file] = 'Model index file';
      return false;
    }
    
    const fileName = file.toLowerCase().replace('.js', '');
    
    const isWhitelisted = MODEL_WHITELIST.some(modelName => 
      modelName.toLowerCase() === fileName
    );
    
    if (isWhitelisted) {
      _slog(`[Database] ✅ Whitelisted model detected: ${file}`);
      return true;
    }
    
    const isNonModel = NON_MODEL_PATTERNS.some(pattern => 
      fileName.includes(pattern.toLowerCase())
    );
    
    if (isNonModel) {
      _slog(`[Database] 🛡️ Strict Guard: Skipping ${file} - matches non-model pattern`);
      db.skippedFiles[file] = 'Matches non-model pattern (router/controller)';
      return false;
    }
    
    _slog(`[Database] ⚠️ File not in whitelist but not blocked: ${file}. Will check content.`);
    return true;
  });

_slog(`[Database] Found ${modelFiles.length} potential model files after filtering`);

// ===== LOAD MODELS =====
modelFiles.forEach(file => {
  const modelName = file.replace('.js', '');
  const filePath = path.join(__dirname, file);
  
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    const isSequelizeModel = 
      fileContent.includes('sequelize.define') || 
      fileContent.includes('Sequelize.Model') ||
      (fileContent.includes('module.exports') && 
       (fileContent.includes('(sequelize, DataTypes)') || 
        fileContent.includes('function(sequelize, DataTypes)'))) ||
      (fileContent.includes('class') && fileContent.includes('extends Model')) ||
      fileContent.includes('DataTypes.') ||
      fileContent.includes('Sequelize.DataTypes');
    
    const isRouterOrController = 
      fileContent.includes('express.Router()') ||
      fileContent.includes('express.Router(') ||
      fileContent.includes('app.get(') ||
      fileContent.includes('app.post(') ||
      fileContent.includes('app.use(') ||
      fileContent.includes('router.get(') ||
      fileContent.includes('router.post(') ||
      fileContent.includes('router.use(') ||
      fileContent.includes('require(\'express\')') ||
      (fileContent.includes('Router') && fileContent.includes('require'));
    
    if (isRouterOrController) {
      _slog(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Detected as router/controller`);
      db.failedModels[modelName] = {
        file: file,
        error: 'File is a router/controller, not a Sequelize model',
        timestamp: new Date().toISOString(),
        detection: 'Router/controller pattern detected'
      };
      return;
    }
    
    if (!isSequelizeModel) {
      _slog(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Not a Sequelize model structure`);
      db.failedModels[modelName] = {
        file: file,
        error: 'File does not export a valid Sequelize model structure',
        timestamp: new Date().toISOString(),
        detection: 'Missing Sequelize model patterns'
      };
      return;
    }
    
    _slog(`[Database] Loading model: ${modelName} from ${file}`);
    
    const modelModule = require(filePath);
    
    let modelInstance;
    if (typeof modelModule === 'function') {
      modelInstance = modelModule(sequelize, Sequelize.DataTypes);
    } else if (modelModule && typeof modelModule.init === 'function') {
      modelInstance = modelModule;
      if (!modelInstance.sequelize) {
        modelInstance.init(modelInstance.rawAttributes || {}, {
          sequelize,
          modelName: modelInstance.name || modelName,
          tableName: modelInstance.tableName || modelInstance.name || modelName,
        });
      }
    } else if (modelModule && typeof modelModule === 'object' && modelModule.rawAttributes) {
      modelInstance = modelModule;
    } else {
      throw new Error(`Invalid model structure in ${file} - not a function or initialized model`);
    }
    
    if (!modelInstance || (!modelInstance.name && !modelName)) {
      throw new Error(`Model instance has no name property`);
    }
    
    const actualModelName = modelInstance.name || modelName;
    
    if (db.models[actualModelName]) {
      console.warn(`[Database] ⚠️ Duplicate model name detected: ${actualModelName}. Skipping duplicate.`);
      db.failedModels[modelName] = {
        file: file,
        error: `Duplicate model name: ${actualModelName} already loaded`,
        timestamp: new Date().toISOString(),
        detection: 'Duplicate model name'
      };
      return;
    }
    
    db.models[actualModelName] = modelInstance;
    
    _slog(`[Database] ✅ Loaded model: ${actualModelName}`);
    
  } catch (error) {
    console.error(`[Database] ❌ Failed to load model ${modelName}:`, error.message);
    
    db.failedModels[modelName] = {
      file: file,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      detection: 'Load error'
    };
  }
});

// ===== FUNCTION 1: CREATE MISSING TABLES =====
async function createMissingTables() {
  _slog('[Migration] 🔧 Checking for missing tables...');
  
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const existingTables = new Set(tables.map(t => t.toLowerCase()));
  
  // List of REQUIRED tables that must exist
  const requiredTables = [
    'Users', 'Token', 'Tokens', 'Friends', 'Friend', 'Chats', 'Chat',
    'Messages', 'Message', 'Groups', 'Group', 'GroupMembers', 'GroupMember',
    'Settings', 'Profile', 'Notifications', 'Notification', 'Media',
    'Calls', 'Call', 'UserStatus', 'TypingIndicator', 'ReadReceipt',
    'statuses', 'status_views', 'status_reactions', 'status_replies',
    // ── Marketplace ───────────────────────────────────────────────────────────
    'tools', 'marketplace_orders', 'marketplace_reviews', 'marketplace_carts',
    'wishlists', 'coupons', 'seller_profiles', 'payouts', 'refunds'
  ];
  
  const missingTables = [];
  const tableNameMapping = {}; // Maps base name to actual model name
  
  for (const tableName of requiredTables) {
    const lowerName = tableName.toLowerCase();
    if (!existingTables.has(lowerName)) {
      // Check if any model matches this table name
      let modelExists = false;
      for (const [modelName, model] of Object.entries(db.models)) {
        const modelTableName = (model.tableName || modelName).toLowerCase();
        if (modelTableName === lowerName || modelName.toLowerCase() === lowerName) {
          modelExists = true;
          tableNameMapping[tableName] = model;
          break;
        }
      }
      
      if (modelExists) {
        missingTables.push(tableName);
        _slog(`[Migration] ⚠️ Missing table: ${tableName} - will create via sync`);
      } else {
        _slog(`[Migration] ℹ️ No model found for: ${tableName} - skipping`);
      }
    }
  }
  
  if (missingTables.length > 0) {
    _slog(`[Migration] 🔨 Creating ${missingTables.length} missing tables via sync...`);
    
    try {
      // First sync without alter to create tables
      await sequelize.sync({ force: false, alter: false });
      _slog(`[Migration] ✅ Initial sync complete - tables created`);
      
      // Verify tables were created
      const newTables = await queryInterface.showAllTables();
      const newTableSet = new Set(newTables.map(t => t.toLowerCase()));
      
      const stillMissing = missingTables.filter(t => !newTableSet.has(t.toLowerCase()));
      if (stillMissing.length > 0) {
        _slog(`[Migration] ⚠️ Still missing after sync: ${stillMissing.join(', ')}`);
        _slog(`[Migration] 🔨 Attempting force sync for remaining tables...`);
        
        // Force sync for specific models
        for (const tableName of stillMissing) {
          const model = tableNameMapping[tableName];
          if (model) {
            try {
              await model.sync({ force: false });
              _slog(`[Migration] ✅ Created table for model: ${model.name}`);
            } catch (modelError) {
              _slog(`[Migration] ❌ Failed to create table for ${tableName}:`, modelError.message);
            }
          }
        }
      }
      
      _slog(`[Migration] ✅ Table creation complete`);
      return missingTables;
    } catch (syncError) {
      console.error(`[Migration] ❌ Sync failed:`, syncError.message);
      
      // Fallback: Try individual model sync
      _slog(`[Migration] 🔨 Attempting individual model sync...`);
      for (const tableName of missingTables) {
        const model = tableNameMapping[tableName];
        if (model) {
          try {
            await model.sync({ force: false });
            _slog(`[Migration] ✅ Created table for: ${tableName}`);
          } catch (modelError) {
            _slog(`[Migration] ❌ Failed to create ${tableName}:`, modelError.message);
          }
        }
      }
      return missingTables;
    }
  } else {
    _slog(`[Migration] ✅ All required tables exist`);
    return [];
  }
}

// ===== FUNCTION 2: ADD MISSING COLUMNS =====
async function addMissingColumns() {
  _slog('[Migration] 🔧 Checking for missing columns...');
  
  const queryInterface = sequelize.getQueryInterface();
  const addedColumns = [];
  
  const requiredColumns = {
    'friends': [
      { name: 'requester_id', type: Sequelize.INTEGER, allowNull: true },
      { name: 'receiver_id', type: Sequelize.INTEGER, allowNull: true },
      { name: 'status', type: Sequelize.STRING(20), defaultValue: 'pending', allowNull: false },
      { name: 'accepted_at', type: Sequelize.DATE, allowNull: true },
      { name: 'blocked_at', type: Sequelize.DATE, allowNull: true },
      { name: 'notes', type: Sequelize.STRING(200), allowNull: true },
      { name: 'category', type: Sequelize.STRING(50), allowNull: true },
      { name: 'closeness_level', type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      { name: 'is_pinned', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'is_muted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false }
    ],
    'Users': [
      { name: 'theme', type: Sequelize.STRING(20), defaultValue: 'light', allowNull: false },
      { name: 'language', type: Sequelize.STRING(10), defaultValue: 'en', allowNull: false },
      { name: 'last_active', type: Sequelize.DATE, allowNull: true },
      { name: 'is_online', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'avatar', type: Sequelize.STRING(255), allowNull: true },
      { name: 'bio', type: Sequelize.TEXT, allowNull: true }
    ],
    'chats': [
      { name: 'name', type: Sequelize.STRING(100), allowNull: true },
      { name: 'type', type: Sequelize.STRING(20), defaultValue: 'direct', allowNull: false },
      { name: 'createdBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'description', type: Sequelize.TEXT, allowNull: true },
      { name: 'avatar', type: Sequelize.STRING(255), allowNull: true },
      { name: 'isActive', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'isArchived', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'archivedBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'archivedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'deletedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'deletedBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'lastMessageId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'lastMessageAt', type: Sequelize.DATE, allowNull: true },
      { name: 'settings', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ],
    'Groups': [
      { name: 'chatId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'name', type: Sequelize.STRING(100), allowNull: true },
      { name: 'createdBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'description', type: Sequelize.TEXT, allowNull: true },
      { name: 'avatar', type: Sequelize.STRING(255), allowNull: true },
      { name: 'isPublic', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'inviteLink', type: Sequelize.STRING(100), allowNull: true },
      { name: 'inviteLinkExpires', type: Sequelize.DATE, allowNull: true },
      { name: 'maxMembers', type: Sequelize.INTEGER, defaultValue: 100, allowNull: false },
      { name: 'rules', type: Sequelize.TEXT, allowNull: true },
      { name: 'tags', type: Sequelize.ARRAY(Sequelize.STRING), defaultValue: [], allowNull: false },
      { name: 'location', type: Sequelize.STRING(100), allowNull: true },
      { name: 'purpose', type: Sequelize.STRING(100), allowNull: true, defaultValue: 'general' },
      { name: 'isVerified', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'stats', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ],
    'Tokens': [
      { name: 'user_id', type: Sequelize.INTEGER, allowNull: false },
      { name: 'token', type: Sequelize.TEXT, allowNull: false },
      { name: 'token_type', type: Sequelize.STRING, defaultValue: 'refresh', allowNull: false },
      { name: 'expires_at', type: Sequelize.DATE, allowNull: false },
      { name: 'is_revoked', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'user_agent', type: Sequelize.STRING, allowNull: true },
      { name: 'ip_address', type: Sequelize.STRING(45), allowNull: true },
      { name: 'device_info', type: Sequelize.STRING, allowNull: true }
    ],
    'Messages': [
      { name: 'chatId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'senderId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'receiverId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'content', type: Sequelize.TEXT, allowNull: true },
      { name: 'type', type: Sequelize.STRING(20), defaultValue: 'text', allowNull: false },
      { name: 'replyToId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'replyToStatusId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'statusPreview', type: Sequelize.TEXT, allowNull: true },
      { name: 'isEdited', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'editedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'isDeleted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'deletedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'deletedBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'isRead', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'readAt', type: Sequelize.DATE, allowNull: true },
      { name: 'reactions', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'encryptionKey', type: Sequelize.STRING(100), allowNull: true },
      { name: 'sentAt', type: Sequelize.DATE, defaultValue: Sequelize.NOW, allowNull: false },
      { name: 'deliveredAt', type: Sequelize.DATE, allowNull: true }
    ],
    'statuses': [
      { name: 'privacy', type: Sequelize.STRING(32), defaultValue: 'friends', allowNull: false },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'expiresAt', type: Sequelize.DATE, allowNull: true }
    ],
    'status_views': [
      { name: 'statusId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'userId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'viewedAt', type: Sequelize.DATE, defaultValue: Sequelize.NOW, allowNull: false }
    ],
    'status_reactions': [
      { name: 'statusId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'userId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'emoji', type: Sequelize.STRING(32), allowNull: false }
    ],
    'status_replies': [
      { name: 'statusId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'senderId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'receiverId', type: Sequelize.INTEGER, allowNull: false },
      { name: 'messageId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'content', type: Sequelize.TEXT, allowNull: false }
    ],
    'settings': [
      { name: 'user_id', type: Sequelize.INTEGER, allowNull: false },
      { name: 'theme', type: Sequelize.STRING, defaultValue: 'light', allowNull: false },
      { name: 'accent_color', type: Sequelize.STRING, defaultValue: '#000000', allowNull: false },
      { name: 'notifications_enabled', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'language', type: Sequelize.STRING, defaultValue: 'en', allowNull: false },
      { name: 'font_size', type: Sequelize.STRING, defaultValue: 'medium', allowNull: false },
      { name: 'timezone', type: Sequelize.STRING, defaultValue: 'UTC', allowNull: false },
      { name: 'email_notifications', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'push_notifications', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'sound_enabled', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'vibration_enabled', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'data_saver', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'auto_download', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'privacy', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'chat_preferences', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ],
    // ── Marketplace: tools (listings) ─────────────────────────────────────────
    'tools': [
      { name: 'seller_id', type: Sequelize.UUID, allowNull: false },
      { name: 'title', type: Sequelize.STRING(255), allowNull: false },
      { name: 'description', type: Sequelize.TEXT, allowNull: true },
      { name: 'price', type: Sequelize.DECIMAL(10, 2), defaultValue: 0, allowNull: false },
      { name: 'category', type: Sequelize.STRING(100), defaultValue: 'other', allowNull: false },
      { name: 'type', type: Sequelize.STRING(50), defaultValue: 'physical', allowNull: false },
      { name: 'images', type: Sequelize.ARRAY(Sequelize.TEXT), defaultValue: [], allowNull: true },
      { name: 'tags', type: Sequelize.ARRAY(Sequelize.STRING), defaultValue: [], allowNull: true },
      { name: 'available', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'is_premium', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'is_spotlight', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'is_featured', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'is_boosted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'boost_expires_at', type: Sequelize.DATE, allowNull: true },
      { name: 'views', type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      { name: 'saved_by', type: Sequelize.ARRAY(Sequelize.UUID), defaultValue: [], allowNull: true },
      { name: 'purchased_by', type: Sequelize.ARRAY(Sequelize.UUID), defaultValue: [], allowNull: true },
      { name: 'rating', type: Sequelize.DECIMAL(3, 2), defaultValue: 0, allowNull: false },
      { name: 'rating_count', type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      { name: 'status', type: Sequelize.STRING(20), defaultValue: 'active', allowNull: false },
      { name: 'currency', type: Sequelize.STRING(10), defaultValue: 'KES', allowNull: true },
      { name: 'stock', type: Sequelize.INTEGER, allowNull: true },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: true }
    ],
    // ── Marketplace: orders ───────────────────────────────────────────────────
    'marketplace_orders': [
      { name: 'product_id', type: Sequelize.UUID, allowNull: false },
      { name: 'buyer_id', type: Sequelize.UUID, allowNull: false },
      { name: 'seller_id', type: Sequelize.UUID, allowNull: false },
      { name: 'status', type: Sequelize.STRING(20), defaultValue: 'pending', allowNull: false },
      { name: 'quantity', type: Sequelize.INTEGER, defaultValue: 1, allowNull: false },
      { name: 'total_price', type: Sequelize.DECIMAL(10, 2), allowNull: false },
      { name: 'currency', type: Sequelize.STRING(10), defaultValue: 'KES', allowNull: true },
      { name: 'payment_method', type: Sequelize.STRING(50), allowNull: true },
      { name: 'payment_ref', type: Sequelize.STRING(255), allowNull: true },
      { name: 'paid_at', type: Sequelize.DATE, allowNull: true },
      { name: 'shipped_at', type: Sequelize.DATE, allowNull: true },
      { name: 'delivered_at', type: Sequelize.DATE, allowNull: true },
      { name: 'delivery_address', type: Sequelize.JSONB, defaultValue: {}, allowNull: true },
      { name: 'tracking_number', type: Sequelize.STRING(255), allowNull: true },
      { name: 'notes', type: Sequelize.TEXT, allowNull: true },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: true }
    ],
    // ── Marketplace: reviews ──────────────────────────────────────────────────
    'marketplace_reviews': [
      { name: 'product_id', type: Sequelize.UUID, allowNull: false },
      { name: 'order_id', type: Sequelize.UUID, allowNull: true },
      { name: 'user_id', type: Sequelize.UUID, allowNull: false },
      { name: 'seller_id', type: Sequelize.UUID, allowNull: false },
      { name: 'rating', type: Sequelize.INTEGER, allowNull: false },
      { name: 'comment', type: Sequelize.TEXT, allowNull: true },
      { name: 'images', type: Sequelize.ARRAY(Sequelize.TEXT), defaultValue: [], allowNull: true },
      { name: 'is_verified_purchase', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'helpful_count', type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      { name: 'seller_reply', type: Sequelize.TEXT, allowNull: true },
      { name: 'seller_replied_at', type: Sequelize.DATE, allowNull: true }
    ],
    // FIX (Forensic Audit P1): marketplace_carts table — was missing entirely
    'marketplace_carts': [
      { name: 'user_id',         type: Sequelize.UUID,           allowNull: false },
      { name: 'items',           type: Sequelize.JSONB,          allowNull: false, defaultValue: [] },
      { name: 'currency',        type: Sequelize.STRING(10),     allowNull: false, defaultValue: 'KES' },
      { name: 'coupon_code',     type: Sequelize.STRING(100),    allowNull: true },
      { name: 'discount_amount', type: Sequelize.DECIMAL(10,2),  allowNull: false, defaultValue: 0 },
      { name: 'expires_at',      type: Sequelize.DATE,           allowNull: true },
      { name: 'metadata',        type: Sequelize.JSONB,          allowNull: true, defaultValue: {} }
    ]
  };
  
  try {
    const tables = await queryInterface.showAllTables();
    _slog(`[Migration] Found ${tables.length} existing tables`);
    
    for (const [tableName, columns] of Object.entries(requiredColumns)) {
      if (!tables.includes(tableName)) {
        _slog(`[Migration] ⚠️ Table ${tableName} not found, skipping column check (will be created by table creation)`);
        continue;
      }
      
      try {
        const tableColumns = await queryInterface.describeTable(tableName);
        const existingColumnNames = Object.keys(tableColumns);
        
        for (const column of columns) {
          if (!existingColumnNames.includes(column.name)) {
            _slog(`[Migration] ➕ Adding column ${column.name} to table ${tableName}`);
            
            try {
              await queryInterface.addColumn(tableName, column.name, {
                type: column.type,
                allowNull: column.allowNull,
                defaultValue: column.defaultValue
              });
              addedColumns.push(`${tableName}.${column.name}`);
              _slog(`[Migration] ✅ Added column ${column.name} to ${tableName}`);
            } catch (addError) {
              _slog(`[Migration] ⚠️ Could not add column ${column.name}: ${addError.message}`);
            }
          }
        }
        
        if (tableName === 'Groups' && existingColumnNames.includes('name')) {
          await sequelize.query(`
            UPDATE "Groups" SET "name" = 'Group ' || "id" 
            WHERE "name" IS NULL OR "name" = ''
          `);
          _slog(`[Migration] ✅ Updated Groups table with default names`);
        }
        
      } catch (tableError) {
        _slog(`[Migration] ⚠️ Error checking table ${tableName}: ${tableError.message}`);
      }
    }
    
    if (tables.includes('friends')) {
      try {
        await sequelize.query(`
          CREATE INDEX IF NOT EXISTS idx_friends_requester ON friends(requester_id);
          CREATE INDEX IF NOT EXISTS idx_friends_receiver ON friends(receiver_id);
          CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);
        `);
        _slog(`[Migration] ✅ Added indexes to friends table`);
      } catch (indexError) {
        _slog(`[Migration] ⚠️ Could not add indexes: ${indexError.message}`);
      }

      // PERFORMANCE FIX: Add critical missing indexes for the most common queries
      // (chatId, isDeleted) covers the GET /messages query which runs on every chat open
      // chat_participants(userId) covers getUserChats which runs on every page load
      // GroupMembers(groupId) covers member count queries
      try {
        await sequelize.query(`
          CREATE INDEX IF NOT EXISTS idx_messages_chat_deleted  ON "Messages"("chatId", "isDeleted");
          CREATE INDEX IF NOT EXISTS idx_messages_chat_created  ON "Messages"("chatId", "createdAt" DESC);
          CREATE INDEX IF NOT EXISTS idx_chat_participants_user  ON chat_participants("userId");
          CREATE INDEX IF NOT EXISTS idx_chat_participants_chat  ON chat_participants("chatId");
          CREATE INDEX IF NOT EXISTS idx_group_members_group     ON "GroupMembers"("groupId");
          CREATE INDEX IF NOT EXISTS idx_group_members_user      ON "GroupMembers"("userId");
          CREATE INDEX IF NOT EXISTS idx_status_creator          ON "Statuses"("userId", "expiresAt");
          CREATE INDEX IF NOT EXISTS idx_status_views_status     ON "StatusViews"("statusId");
          CREATE INDEX IF NOT EXISTS idx_notifications_user      ON "Notifications"("userId", "isRead");
        `);
        _slog(`[Migration] ✅ Added critical performance indexes`);
      } catch (indexError) {
        _slog(`[Migration] ⚠️ Could not add performance indexes: ${indexError.message}`);
      }
    }
    
    if (tables.includes('Tokens')) {
      try {
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_user_id_idx ON "Tokens" ("user_id");`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_token_idx ON "Tokens" ("token");`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_expires_at_idx ON "Tokens" ("expires_at");`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_user_revoked_idx ON "Tokens" ("user_id", "is_revoked");`);
        _slog(`[Migration] ✅ Added indexes to Tokens table`);
      } catch (indexError) {
        _slog(`[Migration] ⚠️ Could not add token indexes: ${indexError.message}`);
      }
    }
    
    if (addedColumns.length > 0) {
      _slog(`[Migration] ✅ Added ${addedColumns.length} missing columns:`, addedColumns);
    } else {
      _slog(`[Migration] ✅ No missing columns found - database is up to date`);
    }
    
  } catch (error) {
    console.error(`[Migration] ❌ Error during migration:`, error.message);
  }
  
  return addedColumns;
}

// ===== FUNCTION 3: FIX COLUMN NAMES =====
async function fixColumnNames() {
  _slog('[Migration] 🔧 Fixing column names for compatibility...');
  
  const queryInterface = sequelize.getQueryInterface();
  const fixedColumns = [];
  
  try {
    const tables = await queryInterface.showAllTables();
    
    if (tables.includes('friends')) {
      const columns = await queryInterface.describeTable('friends');
      
      if (columns.created_at && !columns.createdAt) {
        await queryInterface.renameColumn('friends', 'created_at', 'createdAt');
        fixedColumns.push('friends.created_at → createdAt');
        _slog('[Migration] ✅ Renamed friends.created_at to createdAt');
      }
      
      if (columns.updated_at && !columns.updatedAt) {
        await queryInterface.renameColumn('friends', 'updated_at', 'updatedAt');
        fixedColumns.push('friends.updated_at → updatedAt');
        _slog('[Migration] ✅ Renamed friends.updated_at to updatedAt');
      }
    }
    
    if (fixedColumns.length > 0) {
      _slog(`[Migration] ✅ Fixed ${fixedColumns.length} column names:`, fixedColumns);
    } else {
      _slog('[Migration] ✅ No column name fixes needed');
    }
    
  } catch (error) {
    _slog('[Migration] ⚠️ Error fixing column names:', error.message);
  }
}

// ===== FUNCTION 4: ENSURE TOKENS TABLE EXISTS (CRITICAL FOR AUTH) =====
async function ensureTokensTable() {
  _slog('[Migration] 🔐 Ensuring Tokens table exists for authentication...');
  
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  
  // Check for Tokens table (case insensitive)
  const hasTokensTable = tables.some(t => t.toLowerCase() === 'tokens');
  
  if (!hasTokensTable) {
    _slog('[Migration] 🔨 Creating Tokens table...');
    
    try {
      // Check if Token model exists
      const TokenModel = db.models.Token || db.models.Tokens;
      
      if (TokenModel) {
        await TokenModel.sync({ force: false });
        _slog('[Migration] ✅ Tokens table created via Token model sync');
      } else {
        // Create table manually if model doesn't exist
        await sequelize.query(`
          CREATE TABLE IF NOT EXISTS "Tokens" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "user_id" INTEGER NOT NULL,
            "token" TEXT NOT NULL,
            "token_type" VARCHAR(255) NOT NULL DEFAULT 'refresh',
            "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
            "is_revoked" BOOLEAN NOT NULL DEFAULT FALSE,
            "user_agent" VARCHAR(255),
            "ip_address" VARCHAR(45),
            "device_info" VARCHAR(255),
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
        `);
        _slog('[Migration] ✅ Tokens table created manually');
      }
      
      // Verify creation
      const newTables = await queryInterface.showAllTables();
      const verified = newTables.some(t => t.toLowerCase() === 'tokens');
      
      if (verified) {
        _slog('[Migration] ✅ Tokens table verified');
      } else {
        _slog('[Migration] ⚠️ Tokens table creation could not be verified');
      }
      
      return true;
    } catch (error) {
      console.error('[Migration] ❌ Failed to create Tokens table:', error.message);
      return false;
    }
  } else {
    _slog('[Migration] ✅ Tokens table already exists');
    return true;
  }
}

// ===== SAFE ASSOCIATION SETUP =====
_slog('[Database] Setting up associations (constraints: false)...');

const associatedModels = new Set();

Object.keys(db.models).forEach(modelName => {
  const model = db.models[modelName];
  if (model && typeof model.associate === 'function') {
    try {
      if (associatedModels.has(modelName)) {
        _slog(`[Database] ⏭️ Skipping already associated model: ${modelName}`);
        return;
      }
      
      model.associate(db.models);
      associatedModels.add(modelName);
      _slog(`[Database] ✅ Associated model: ${modelName}`);
    } catch (error) {
      if (error.message && error.message.includes('used the alias')) {
        _slog(`[Database] ⚠️ Alias conflict in ${modelName}: ${error.message.split(' in')[0]}`);
        db.associationErrors[modelName] = {
          error: error.message,
          timestamp: new Date().toISOString(),
          type: 'alias_conflict'
        };
      } else {
        console.error(`[Database] ❌ Error associating model ${modelName}:`, error.message);
        db.associationErrors[modelName] = {
          error: error.message,
          timestamp: new Date().toISOString(),
          type: 'association_error'
        };
      }
    }
  }
});

_slog('[Database] ✅ Associations setup complete');

// ===== MAIN MIGRATION FUNCTION =====

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-MIGRATION: Phase 3-4 tables — runs automatically on every startup.
// Uses CREATE TABLE IF NOT EXISTS so it is always safe to re-run.
// ═══════════════════════════════════════════════════════════════════════════════
async function ensurePhase34Tables() {
  _slog('[Migration] 🔧 Ensuring Phase 3-4 tables...');
  const Q = Sequelize.QueryTypes.RAW;
  const ddl = [
    // Safety numbers — key verification records
    `CREATE TABLE IF NOT EXISTS key_verifications (
       id SERIAL PRIMARY KEY, "verifierId" INTEGER NOT NULL,
       "verifiedId" INTEGER NOT NULL, fingerprint TEXT NOT NULL,
       "verifiedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE("verifierId","verifiedId"))`,
    // Sealed group membership commitments
    `CREATE TABLE IF NOT EXISTS group_commitments (
       id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL,
       commitment TEXT NOT NULL, "memberCount" INTEGER NOT NULL DEFAULT 0,
       "publishedBy" INTEGER NOT NULL,
       "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS idx_gc_group_ts ON group_commitments("groupId","createdAt" DESC)`,
    // Per-member delivery tokens (message unlinkability)
    `CREATE TABLE IF NOT EXISTS group_delivery_tokens (
       id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
       token TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
       "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE("groupId","userId"))`,
    // Encrypted invite blobs (server cannot read group info)
    `CREATE TABLE IF NOT EXISTS group_sealed_invites (
       id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL,
       token TEXT NOT NULL UNIQUE, "encryptedInvite" TEXT NOT NULL,
       "createdBy" INTEGER NOT NULL, "expiresAt" TIMESTAMPTZ,
       "useCount" INTEGER NOT NULL DEFAULT 0, "maxUses" INTEGER NOT NULL DEFAULT 1,
       "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    // Message abuse reports
    `CREATE TABLE IF NOT EXISTS message_reports (
       id SERIAL PRIMARY KEY, "reporterId" INTEGER NOT NULL, "messageId" INTEGER NOT NULL,
       "chatId" INTEGER, reason VARCHAR(50) NOT NULL DEFAULT 'other', details TEXT,
       status VARCHAR(20) NOT NULL DEFAULT 'pending',
       "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE("reporterId","messageId"))`,
    // Phase 2: two-step PIN on Users
    `ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "registrationPin" VARCHAR(255)`,
    // Phase 3: disappearing messages expiry on Messages
    `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ`,
    // Phase 1-4: rich message metadata (gif, poll, sticker, view-once, sealed)
    `ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`,
    // FIX-500 (/api/tools/marketplace/wishlist): tools.saved_by/purchased_by
    // were declared ARRAY(UUID) while Users.id is INTEGER (same class of bug
    // fixed for seller_id/buyer_id/user_id in
    // 20260626_fix_marketplace_fk_types.js — these two array columns were
    // missed). Tool.getSavedListings()'s `savedBy: { [Op.contains]: [userId] }`
    // query 500s with "invalid input syntax for type uuid" because userId is
    // an integer. A uuid[] column can never have accepted a real integer
    // userId, so there's no data to lose here — just the type to correct.
    // Wrapped in a DO block so it only runs if the column is still uuid[].
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name='tools' AND column_name='saved_by' AND udt_name='_uuid'
       ) THEN
         ALTER TABLE "tools" ALTER COLUMN "saved_by" TYPE INTEGER[] USING ARRAY[]::INTEGER[];
       END IF;
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name='tools' AND column_name='purchased_by' AND udt_name='_uuid'
       ) THEN
         ALTER TABLE "tools" ALTER COLUMN "purchased_by" TYPE INTEGER[] USING ARRAY[]::INTEGER[];
       END IF;
     END $$;`,
  ];
  for (const sql of ddl) {
    try { await sequelize.query(sql, { type: Q }); }
    catch(e) { console.warn('[Migration] Phase34 DDL warn:', e.message.split('\n')[0]); }
  }
  _slog('[Migration] ✅ Phase 3-4 tables ready');
}

async function runFullMigration() {
  _slog('\n[Migration] ===== STARTING FULL DATABASE MIGRATION =====');
  _slog(`[Migration] Environment: ${env}`);
  _slog(`[Migration] Database: ${dbConfig.database || 'DATABASE_URL'}\n`);
  
  let hasErrors = false;
  
  try {
    // STEP 1: Create missing tables (MOST IMPORTANT)
    _slog('[Migration] STEP 1: Creating missing tables...');
    const createdTables = await createMissingTables();
    _slog(`[Migration] Created ${createdTables.length} missing tables\n`);
    
    // STEP 2: Ensure Tokens table exists (CRITICAL for auth)
    _slog('[Migration] STEP 2: Ensuring Tokens table exists...');
    const tokensOk = await ensureTokensTable();
    await ensurePhase34Tables();
    if (!tokensOk) {
      _slog('[Migration] ⚠️ Tokens table creation had issues - auth may not work');
    }
    _slog('');
    
    // STEP 3: Add missing columns
    _slog('[Migration] STEP 3: Adding missing columns...');
    const addedColumns = await addMissingColumns();
    _slog(`[Migration] Added ${addedColumns.length} missing columns\n`);
    
    // STEP 4: Fix column names
    _slog('[Migration] STEP 4: Fixing column names...');
    await fixColumnNames();
    _slog('');
    
    // STEP 5: Final verification
    _slog('[Migration] STEP 5: Final verification...');
    const finalTables = await sequelize.getQueryInterface().showAllTables();
    _slog(`[Migration] Total tables after migration: ${finalTables.length}`);
    
    // Verify Tokens table specifically
    const hasTokensFinal = finalTables.some(t => t.toLowerCase() === 'tokens');
    if (hasTokensFinal) {
      _slog('[Migration] ✅ Tokens table is present - authentication will work');
    } else {
      console.error('[Migration] ❌ Tokens table is STILL missing - CRITICAL ERROR!');
      hasErrors = true;
    }

    // STEP 6: Ensure marketplace tables exist (non-destructive raw SQL)
    _slog('[Migration] STEP 6: Ensuring marketplace tables exist...');
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "tools" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "seller_id" UUID NOT NULL,
          "title" VARCHAR(255) NOT NULL,
          "description" TEXT,
          "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
          "category" VARCHAR(100) NOT NULL DEFAULT 'other',
          "type" VARCHAR(50) NOT NULL DEFAULT 'physical',
          "images" TEXT[] DEFAULT '{}',
          "tags" VARCHAR[] DEFAULT '{}',
          "available" BOOLEAN NOT NULL DEFAULT true,
          "is_premium" BOOLEAN NOT NULL DEFAULT false,
          "is_spotlight" BOOLEAN NOT NULL DEFAULT false,
          "is_featured" BOOLEAN NOT NULL DEFAULT false,
          "is_boosted" BOOLEAN NOT NULL DEFAULT false,
          "boost_expires_at" TIMESTAMPTZ,
          "views" INTEGER NOT NULL DEFAULT 0,
          "saved_by" UUID[] DEFAULT '{}',
          "purchased_by" UUID[] DEFAULT '{}',
          "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
          "rating_count" INTEGER NOT NULL DEFAULT 0,
          "status" VARCHAR(20) NOT NULL DEFAULT 'active',
          "currency" VARCHAR(10) DEFAULT 'KES',
          "stock" INTEGER,
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_tools_seller  ON "tools" ("seller_id");
        CREATE INDEX IF NOT EXISTS idx_tools_status  ON "tools" ("status");
        CREATE INDEX IF NOT EXISTS idx_tools_category ON "tools" ("category");

        CREATE TABLE IF NOT EXISTS "marketplace_orders" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "product_id" UUID NOT NULL,
          "buyer_id" UUID NOT NULL,
          "seller_id" UUID NOT NULL,
          "status" VARCHAR(20) NOT NULL DEFAULT 'pending'
            CHECK ("status" IN ('pending','paid','shipped','delivered','cancelled','refunded')),
          "quantity" INTEGER NOT NULL DEFAULT 1 CHECK ("quantity" >= 1),
          "total_price" DECIMAL(10,2) NOT NULL CHECK ("total_price" >= 0),
          "currency" VARCHAR(10) DEFAULT 'KES',
          "payment_method" VARCHAR(50),
          "payment_ref" VARCHAR(255),
          "paid_at" TIMESTAMPTZ,
          "shipped_at" TIMESTAMPTZ,
          "delivered_at" TIMESTAMPTZ,
          "delivery_address" JSONB DEFAULT '{}',
          "tracking_number" VARCHAR(255),
          "notes" TEXT,
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_orders_buyer   ON "marketplace_orders" ("buyer_id");
        CREATE INDEX IF NOT EXISTS idx_orders_seller  ON "marketplace_orders" ("seller_id");
        CREATE INDEX IF NOT EXISTS idx_orders_product ON "marketplace_orders" ("product_id");
        CREATE INDEX IF NOT EXISTS idx_orders_status  ON "marketplace_orders" ("status");

        CREATE TABLE IF NOT EXISTS "marketplace_reviews" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "product_id" UUID NOT NULL,
          "order_id" UUID,
          "user_id" UUID NOT NULL,
          "seller_id" UUID NOT NULL,
          "rating" INTEGER NOT NULL CHECK ("rating" BETWEEN 1 AND 5),
          "comment" TEXT,
          "images" TEXT[] DEFAULT '{}',
          "is_verified_purchase" BOOLEAN NOT NULL DEFAULT false,
          "helpful_count" INTEGER NOT NULL DEFAULT 0,
          "seller_reply" TEXT,
          "seller_replied_at" TIMESTAMPTZ,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT unique_review_per_user_product UNIQUE ("product_id", "user_id")
        );
        CREATE INDEX IF NOT EXISTS idx_reviews_product ON "marketplace_reviews" ("product_id");
        CREATE INDEX IF NOT EXISTS idx_reviews_user    ON "marketplace_reviews" ("user_id");
        CREATE INDEX IF NOT EXISTS idx_reviews_seller  ON "marketplace_reviews" ("seller_id");
      `);
      _slog('[Migration] ✅ Marketplace tables (tools, marketplace_orders, marketplace_reviews) ensured');

      // ── P1/P2 FIX: Add missing marketplace columns to tools table ────────
      await sequelize.query(`
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "approval_status" VARCHAR(20) NOT NULL DEFAULT 'pending_review';
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ;
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "is_flash_sale" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "flash_sale_price" DECIMAL(10,2);
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "flash_sale_end" TIMESTAMPTZ;
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "brand" VARCHAR(100);
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "condition" VARCHAR(20) DEFAULT 'new';
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "sku" VARCHAR(100);
        CREATE INDEX IF NOT EXISTS idx_tools_approval ON "tools" ("approval_status");
        CREATE INDEX IF NOT EXISTS idx_tools_flash_sale ON "tools" ("is_flash_sale", "available");
        CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_user_unique ON "marketplace_carts" ("user_id");
      `).catch(e => _slog('[Migration] ⚠️ tools column patch (non-fatal):', e.message));

      // ── Dedicated wishlists table (replaces savedBy UUID array on Tool) ───
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "wishlists" (
          "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "user_id"         UUID NOT NULL,
          "product_id"      UUID NOT NULL,
          "price_at_add"    DECIMAL(12,2),
          "notify_on_drop"  BOOLEAN DEFAULT true,
          "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_wishlist_user_product UNIQUE ("user_id","product_id")
        );
        CREATE INDEX IF NOT EXISTS idx_wishlists_user    ON "wishlists" ("user_id");
        CREATE INDEX IF NOT EXISTS idx_wishlists_product ON "wishlists" ("product_id");

        -- seller_verified field on seller_profiles (for badge display)
        ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "verified" BOOLEAN DEFAULT false;
        ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ;
      `).catch(e => _slog('[Migration] ⚠️ wishlists/seller_verified (non-fatal):', e.message));

      // ── P2 FIX: Full-text search index on tools ───────────────────────────
      await sequelize.query(`
        ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;
        CREATE INDEX IF NOT EXISTS idx_tools_search_vector ON "tools" USING GIN("search_vector");
        UPDATE "tools" SET "search_vector" = to_tsvector('english', coalesce("title",'') || ' ' || coalesce("description",''))
        WHERE "search_vector" IS NULL;
      `).catch(e => _slog('[Migration] ⚠️ search_vector (non-fatal):', e.message));

      // ── P1 FIX: Wallet tables ─────────────────────────────────────────────
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "wallets" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "user_id" UUID NOT NULL UNIQUE,
          "balance" DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
          "currency" VARCHAR(10) NOT NULL DEFAULT 'KES',
          "is_frozen" BOOLEAN NOT NULL DEFAULT false,
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wallets_user ON "wallets" ("user_id");

        CREATE TABLE IF NOT EXISTS "wallet_transactions" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "wallet_id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "type" VARCHAR(10) NOT NULL CHECK ("type" IN ('credit','debit')),
          "amount" DECIMAL(15,2) NOT NULL CHECK ("amount" > 0),
          "currency" VARCHAR(10) DEFAULT 'KES',
          "balance_after" DECIMAL(15,2),
          "order_id" UUID,
          "reference" VARCHAR(255),
          "description" TEXT,
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON "wallet_transactions" ("wallet_id");
        CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON "wallet_transactions" ("user_id");
      `).catch(e => _slog('[Migration] ⚠️ wallets (non-fatal):', e.message));

      // ── P1 FIX: Refund table ──────────────────────────────────────────────
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "refunds" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "order_id" UUID NOT NULL,
          "buyer_id" UUID NOT NULL,
          "seller_id" UUID NOT NULL,
          "amount" DECIMAL(10,2) NOT NULL,
          "currency" VARCHAR(10) DEFAULT 'KES',
          "reason" TEXT,
          "status" VARCHAR(20) NOT NULL DEFAULT 'pending'
            CHECK ("status" IN ('pending','approved','rejected','processed')),
          "rejection_reason" TEXT,
          "approved_by" UUID,
          "approved_at" TIMESTAMPTZ,
          "rejected_at" TIMESTAMPTZ,
          "processed_at" TIMESTAMPTZ,
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_order_unique ON "refunds" ("order_id");
        CREATE INDEX IF NOT EXISTS idx_refunds_buyer ON "refunds" ("buyer_id");
        CREATE INDEX IF NOT EXISTS idx_refunds_status ON "refunds" ("status");
      `).catch(e => _slog('[Migration] ⚠️ refunds (non-fatal):', e.message));

      // ── P1 FIX: Payout / settlement table ────────────────────────────────
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "payouts" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "seller_id" UUID NOT NULL,
          "amount" DECIMAL(10,2) NOT NULL CHECK ("amount" > 0),
          "currency" VARCHAR(10) DEFAULT 'KES',
          "method" VARCHAR(30) DEFAULT 'mpesa',
          "phone" VARCHAR(30),
          "bank_account" VARCHAR(100),
          "status" VARCHAR(20) NOT NULL DEFAULT 'pending'
            CHECK ("status" IN ('pending','processing','paid','failed','cancelled')),
          "reference" VARCHAR(255),
          "requested_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "paid_at" TIMESTAMPTZ,
          "disbursed_by" UUID,
          "notes" TEXT,
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payouts_seller ON "payouts" ("seller_id");
        CREATE INDEX IF NOT EXISTS idx_payouts_status ON "payouts" ("status");
      `).catch(e => _slog('[Migration] ⚠️ payouts (non-fatal):', e.message));

      // ── P2 FIX: Seller profile / KYC table ───────────────────────────────
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "seller_profiles" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "user_id" UUID NOT NULL UNIQUE,
          "business_name" VARCHAR(255) NOT NULL,
          "id_number" VARCHAR(50),
          "id_type" VARCHAR(30) DEFAULT 'national_id',
          "phone" VARCHAR(30),
          "bank_name" VARCHAR(100),
          "bank_account" VARCHAR(100),
          "bank_branch" VARCHAR(100),
          "kyc_status" VARCHAR(20) NOT NULL DEFAULT 'pending_review'
            CHECK ("kyc_status" IN ('pending_review','approved','rejected','incomplete')),
          "verified" BOOLEAN NOT NULL DEFAULT false,
          "verified_at" TIMESTAMPTZ,
          "verified_by" UUID,
          "rejection_reason" TEXT,
          "rejected_at" TIMESTAMPTZ,
          "submitted_at" TIMESTAMPTZ DEFAULT NOW(),
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_seller_profiles_user ON "seller_profiles" ("user_id");
        CREATE INDEX IF NOT EXISTS idx_seller_profiles_kyc ON "seller_profiles" ("kyc_status");
      `).catch(e => _slog('[Migration] ⚠️ seller_profiles (non-fatal):', e.message));

      // ── P2 FIX: Coupons table (model existed but no DDL) ─────────────────
      // FIX (forensic audit 2026-06-21): CREATE TABLE IF NOT EXISTS silently
      // skips when the table already exists from a prior deploy — it does NOT
      // add new columns to that pre-existing table. That left old "coupons"
      // tables missing "is_active", causing the CREATE INDEX below to fail
      // with "column is_active does not exist" on every boot. Added explicit
      // ALTER ADD COLUMN IF NOT EXISTS guards (same pattern already used for
      // "tools" above) so both fresh and pre-existing tables converge.
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "coupons" (
          "id" SERIAL PRIMARY KEY,
          "code" VARCHAR(32) NOT NULL UNIQUE,
          "type" VARCHAR(20) NOT NULL DEFAULT 'percent'
            CHECK ("type" IN ('percent','fixed','free_shipping','cashback')),
          "value" DECIMAL(10,2) NOT NULL DEFAULT 0,
          "min_order_amt" DECIMAL(10,2) DEFAULT 0,
          "max_discount" DECIMAL(10,2),
          "usage_limit" INTEGER DEFAULT 9999,
          "usage_count" INTEGER DEFAULT 0,
          "per_user_limit" INTEGER DEFAULT 1,
          "starts_at" TIMESTAMPTZ,
          "expires_at" TIMESTAMPTZ,
          "is_active" BOOLEAN NOT NULL DEFAULT true,
          "is_public" BOOLEAN NOT NULL DEFAULT true,
          "user_id" UUID,
          "seller_id" UUID,
          "category_slug" VARCHAR(64),
          "description" VARCHAR(255),
          "metadata" JSONB DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "is_public" BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "min_order_amt" DECIMAL(10,2) DEFAULT 0;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "max_discount" DECIMAL(10,2);
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "usage_limit" INTEGER DEFAULT 9999;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "usage_count" INTEGER DEFAULT 0;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "per_user_limit" INTEGER DEFAULT 1;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMPTZ;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "user_id" UUID;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "seller_id" UUID;
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "category_slug" VARCHAR(64);
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "description" VARCHAR(255);
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}';
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();
        ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();
        CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code ON "coupons" ("code");
        CREATE INDEX IF NOT EXISTS idx_coupons_active ON "coupons" ("is_active", "expires_at");
      `).catch(e => _slog('[Migration] ⚠️ coupons (non-fatal):', e.message));

      // ── P2 FIX: Audit log table ───────────────────────────────────────────
      // Same pre-existing-table issue: old "audit_logs" tables were missing
      // "createdAt", breaking the index below. ALTER guards added.
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "audit_logs" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "user_id" UUID,
          "action" VARCHAR(100) NOT NULL,
          "resource_type" VARCHAR(50),
          "resource_id" VARCHAR(255),
          "details" JSONB DEFAULT '{}',
          "ip_address" VARCHAR(50),
          "user_agent" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "user_id" UUID;
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "resource_type" VARCHAR(50);
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "resource_id" VARCHAR(255);
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "details" JSONB DEFAULT '{}';
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "ip_address" VARCHAR(50);
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "user_agent" TEXT;
        ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON "audit_logs" ("user_id");
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON "audit_logs" ("action");
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON "audit_logs" ("createdAt" DESC);
      `).catch(e => _slog('[Migration] ⚠️ audit_logs (non-fatal):', e.message));

      _slog('[Migration] ✅ All P1/P2 marketplace tables and columns ensured');
    } catch (mpErr) {
      console.error('[Migration] ⚠️ Marketplace table creation error (non-fatal):', mpErr.message);
    }
    
    _slog('\n[Migration] ===== MIGRATION COMPLETE =====\n');
    
  } catch (error) {
    console.error('[Migration] ❌ Migration error:', error.message);
    hasErrors = true;
  }
  
  return !hasErrors;
}

// ===== RUN MIGRATION ON STARTUP =====
// FIX (missing tables after deploy, e.g. "relation GameProgress does not
// exist"): during a Render deploy, the OLD instance's DB connections can
// briefly overlap with the NEW instance's while the old one finishes
// shutting down — for a few seconds right at boot, both are alive and
// competing for the pooler's session-mode connection budget. If this
// startup migration/sync happened to run during that overlap, it failed
// with EMAXCONNSESSION, and the one immediate fallback retry (no delay)
// almost always hit the exact same contention and failed too — so any
// table that hadn't been created yet (this app creates tables lazily on
// first successful sync, not via versioned migrations) just stayed missing
// until the next deploy happened to get lucky. Retrying a few times with
// real delay lets the old instance's connections actually free up first.
async function _runStartupMigrationWithRetry() {
  const MAX_ATTEMPTS = 4;
  const DELAY_MS = 6000; // old-instance connections are typically gone well within this

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const migrationSuccess = await runFullMigration();
      if (!migrationSuccess) {
        console.error('[Database] ⚠️ Migration completed with errors - some features may be limited');
      }
      _slog('[Database] Syncing models for consistency...');
      await sequelize.sync({ force: false, alter: false });
      _slog(`[Database] ✅ Final sync complete (attempt ${attempt}/${MAX_ATTEMPTS})`);
      return;
    } catch (error) {
      const isConnBusy = /EMAXCONNSESSION|max clients reached|too many clients/i.test(error.message || '');
      console.error(`[Database] ❌ Migration/sync error on attempt ${attempt}/${MAX_ATTEMPTS}:`, error.message);
      if (!isConnBusy || attempt === MAX_ATTEMPTS) {
        // Not a connection-exhaustion error, or we're out of attempts — give up
        // (this matches the previous behavior for genuine, non-transient errors).
        if (attempt === MAX_ATTEMPTS) {
          console.error('[Database] ❌ Giving up after retries — some tables/columns may still be missing until the next successful sync.');
        }
        return;
      }
      _slog(`[Database] 🔧 Connection pool busy (likely deploy overlap) — retrying in ${DELAY_MS / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
}

(async function runMigrationAndContinue() {
  _slog('[Database] Starting database initialization...');
  await _runStartupMigrationWithRetry();
})();

// ===== CORE MODEL VALIDATION =====
_slog('\n[Database] ===== CORE MODEL VALIDATION =====');

const hasUserModel = !!(db.models.Users);
const hasFriendModel = !!(db.models.Friend);
const hasChatModel = !!(db.models.Chats);
const hasMessageModel = !!(db.models.Messages);
const hasChatParticipantModel = !!(db.models.ChatParticipant);
const hasTokenModel = !!(db.models.Token || db.models.Tokens);
// ── Marketplace model flags ──────────────────────────────────────────────────
const hasToolModel    = !!(db.models.Tool);
const hasOrderModel   = !!(db.models.Order);
const hasReviewModel  = !!(db.models.Review);

if (!hasUserModel) {
  console.error('[Database] ❌ CRITICAL: User model not found!');
  console.error('[Database] Available models:', Object.keys(db.models));
} else {
  _slog('[Database] ✅ User model loaded successfully');
}

if (!hasTokenModel) {
  console.warn('[Database] ⚠️ Token model not found - will be created by migration');
} else {
  _slog('[Database] ✅ Token model loaded successfully');
}

if (!hasFriendModel) {
  console.warn('[Database] ⚠️ Friend model not found - friend features may be limited');
} else {
  _slog('[Database] ✅ Friend model loaded successfully');
}

if (!hasChatModel) {
  console.warn('[Database] ⚠️ Chats model not found - chat features may be limited');
} else {
  _slog('[Database] ✅ Chats model loaded successfully');
}

if (!hasMessageModel) {
  console.warn('[Database] ⚠️ Messages model not found - messaging features may be limited');
} else {
  _slog('[Database] ✅ Messages model loaded successfully');
}

// ── Marketplace model validation ─────────────────────────────────────────────
if (!hasToolModel) {
  console.warn('[Database] ⚠️ Tool model not found - marketplace listings unavailable');
} else {
  _slog('[Database] ✅ Tool model loaded (marketplace listings)');
}

if (!hasOrderModel) {
  console.warn('[Database] ⚠️ Order model not found - marketplace orders unavailable');
} else {
  _slog('[Database] ✅ Order model loaded (marketplace orders)');
}

if (!hasReviewModel) {
  console.warn('[Database] ⚠️ Review model not found - marketplace reviews unavailable');
} else {
  _slog('[Database] ✅ Review model loaded (marketplace reviews)');
}

_slog(`[Database] Total models loaded: ${Object.keys(db.models).length}`);

// ===== UTILITY FUNCTIONS =====
db.showCurrentTables = async function() {
  try {
    _slog('[Database] ===== CURRENT DATABASE TABLES =====');
    
    const queryResult = await sequelize.query(
      `SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.table_name) as column_count,
        (SELECT pg_size_pretty(pg_total_relation_size(quote_ident(table_name)))) as table_size
      FROM information_schema.tables t 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;`,
      { type: sequelize.QueryTypes.SELECT }
    );
    
    _slog(`[Database] Total tables: ${queryResult.length}`);
    queryResult.forEach((table, index) => {
      _slog(`  ${index + 1}. ${table.table_name} (${table.column_count} columns, ${table.table_size})`);
    });
    
    _slog('[Database] ============================');
  } catch (error) {
    console.error('[Database] Error listing tables:', error.message);
  }
};

db.testConnection = async function() {
  try {
    await sequelize.authenticate();
    _slog('[Database] Connection test: ✅ SUCCESS');
    return true;
  } catch (error) {
    console.error('[Database] Connection test: ❌ FAILED', error.message);
    return false;
  }
};

db.getLoadedModels = function() {
  return Object.keys(db.models).map(name => ({
    name,
    tableName: db.models[name].tableName || name,
    status: 'LOADED',
    columns: db.models[name].rawAttributes ? Object.keys(db.models[name].rawAttributes).length : 0
  }));
};

db.getFailedModels = function() {
  return Object.keys(db.failedModels).map(name => ({
    name,
    file: db.failedModels[name].file,
    error: db.failedModels[name].error,
    timestamp: db.failedModels[name].timestamp,
    status: 'FAILED',
    detection: db.failedModels[name].detection || 'Unknown'
  }));
};

db.getOperationalStatus = function() {
  return {
    mode: !hasUserModel ? 'HALTED' : (!hasFriendModel ? 'PARTIAL' : 'FULL'),
    coreOperational: hasUserModel,
    loadedCount: Object.keys(db.models).length,
    failedCount: Object.keys(db.failedModels).length,
    skippedCount: Object.keys(db.skippedFiles).length,
    failedModels: Object.keys(db.failedModels),
    hasUserModel: hasUserModel,
    hasTokenModel: hasTokenModel,
    hasFriendModel: hasFriendModel,
    hasChatModel: hasChatModel,
    hasMessageModel: hasMessageModel,
    hasChatParticipantModel: hasChatParticipantModel,
    timestamp: new Date().toISOString()
  };
};

db.getModel = function(modelName) {
  if (db.models[modelName]) return db.models[modelName];
  const singular = modelName.replace(/s$/, '');
  const plural = modelName + 's';
  if (db.models[singular]) return db.models[singular];
  if (db.models[plural]) return db.models[plural];
  if (db.models[modelName.toLowerCase()]) return db.models[modelName.toLowerCase()];
  console.warn(`[Database] Model not found: ${modelName}`);
  return null;
};

// ===== WEBSOCKET INITIALIZATION =====
db.initializeWebSocket = function(server) {
  if (!server) {
    console.error('[WebSocket] ❌ Server instance required');
    return null;
  }
  
  try {
    _slog('[WebSocket] 🔌 Initializing WebSocket server...');
    
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (socket) => {
      _slog('[WebSocket] ✅ New client connected');
      
      socket.on('message', (msg) => {
        try {
          _slog('[WebSocket] 📨 Received:', msg.toString());
          const data = JSON.parse(msg.toString());
        } catch (error) {
          console.error('[WebSocket] ❌ Error processing message:', error.message);
        }
      });
      
      socket.on('close', () => {
        _slog('[WebSocket] 👋 Client disconnected');
      });
      
      socket.on('error', (error) => {
        console.error('[WebSocket] ❌ Socket error:', error.message);
      });
      
      socket.send(JSON.stringify({
        type: 'connection',
        message: 'Connected to WebSocket server',
        timestamp: new Date().toISOString()
      }));
    });
    
    db.wss = wss;
    _slog('[WebSocket] ✅ WebSocket server initialized successfully');
    return wss;
    
  } catch (error) {
    console.error('[WebSocket] ❌ WebSocket initialization failed:', error.message);
    return null;
  }
};

// ===== STARTUP REPORT =====
_slog('\n[Database] ===== STARTUP REPORT =====');
_slog(`[Database] Environment: ${env}`);
_slog(`[Database] Database: ${dbConfig.database || 'DATABASE_URL'}`);
_slog(`[Database] Mode: ${db.getOperationalStatus().mode}`);
_slog('');

_slog(`[Database] ✅ SUCCESSFULLY LOADED (${Object.keys(db.models).length}):`);
db.getLoadedModels().forEach((model, index) => {
  _slog(`  ${index + 1}. ${model.name} (table: ${model.tableName})`);
});

_slog('');

if (Object.keys(db.failedModels).length > 0) {
  _slog(`[Database] ❌ FAILED TO LOAD (${Object.keys(db.failedModels).length}):`);
  db.getFailedModels().forEach((failed, index) => {
    _slog(`  ${index + 1}. ${failed.name} (${failed.file})`);
    _slog(`     Error: ${failed.error}`);
  });
}

_slog('');

if (Object.keys(db.skippedFiles).length > 0) {
  _slog(`[Database] ⏭️  SKIPPED FILES (${Object.keys(db.skippedFiles).length}):`);
  Object.entries(db.skippedFiles).forEach(([fileName, reason], index) => {
    _slog(`  ${index + 1}. ${fileName} - ${reason}`);
  });
}

_slog('\n[Database] ===== OPERATIONAL STATUS =====');
const status = db.getOperationalStatus();
if (status.mode === 'HALTED') {
  _slog('[Database] ❌ SYSTEM HALTED: User model missing');
} else if (status.mode === 'PARTIAL') {
  _slog('[Database] ⚠️ PARTIAL MODE: Some features unavailable');
} else {
  _slog('[Database] ✅ FULL OPERATION: All core models loaded');
}

_slog('\n[Migration] ===== MIGRATION FEATURES =====');
_slog('[Migration] ✅ Auto-create missing tables on startup');
_slog('[Migration] ✅ Auto-add missing columns on startup');
_slog('[Migration] ✅ Auto-fix column name inconsistencies');
_slog('[Migration] ✅ Tokens table verification and creation');
_slog('[Migration] ✅ Database sync with force:false, alter:false');
_slog('[Migration] ✅ Non-destructive migrations only\n');

_slog('[Database] =================================\n');

if (status.coreOperational) {
  _slog('[Database] 🚀 Database ready');
    global.__dbReady = true;
    if (global.__dbReadyResolve) { global.__dbReadyResolve(); }
  _slog('[Database] ✅ No destructive operations');
  _slog('[Database] ✅ Associations loaded');
  _slog('[Database] ✅ Auto-migration enabled');
}

// ===== EXPORT =====
module.exports = {
  ...db,
  sequelize,
  Sequelize,
  Op,
  models: db.models,
  initializeWebSocket: db.initializeWebSocket,
  getModel: db.getModel,
  
  get User() { return db.models.User || db.models.Users || null; },
  get Token() { return db.models.Token || db.models.Tokens || null; },
  get Friend() { return db.models.Friend || db.models.Friends || null; },
  get Chat() { return db.models.Chat || db.models.Chats || null; },
  get Message() { return db.models.Message || db.models.Messages || null; },
  get ChatParticipant() { return db.models.ChatParticipant || null; },
  get Group() { return db.models.Group || db.models.Groups || null; },
  get GroupMember() { return db.models.GroupMember || db.models.GroupMembers || null; },
  get Profile() { return db.models.Profile || null; },
  get Settings() { return db.models.Settings || null; },
  get Features() { return db.models.Features || null; },
  get Notification() { return db.models.Notification || null; },
  get Media() { return db.models.Media || null; },
  get Mood() { return db.models.Mood || null; },
  get Status() { return db.models.Status || null; },
  get StatusView() { return db.models.StatusView || null; },
  get StatusReaction() { return db.models.StatusReaction || null; },
  get StatusReply() { return db.models.StatusReply || null; },
  get Call() { return db.models.Call || db.models.Calls || null; },
  get Category() { return db.models.Category || null; },
  get Template() { return db.models.Template || null; },
  get Notes() { return db.models.Notes || null; },
  get File() { return db.models.File || null; },
  get ReadReceipt() { return db.models.ReadReceipt || null; },
  get SharedMood() { return db.models.SharedMood || null; },
  get TypingIndicator() { return db.models.TypingIndicator || null; },
  getUserStatus() { return db.models.UserStatus || null; },
  // ── Marketplace models ────────────────────────────────────────────────────
  get Tool()          { return db.models.Tool          || null; },
  get Order()         { return db.models.Order         || null; },
  get Review()        { return db.models.Review        || null; },
  get Wishlist()      { return db.models.Wishlist      || null; },
  get Coupon()        { return db.models.Coupon        || null; },
  get Refund()        { return db.models.Refund        || null; },
  get SellerProfile() { return db.models.SellerProfile || null; },
  get AuditLog()      { return db.models.AuditLog      || null; },
  get Payout()        { return db.models.Payout        || null; },
  // ── Marketplace operational status ───────────────────────────────────────
  getMarketplaceStatus() {
    return {
      toolModel:          !!(db.models.Tool),
      orderModel:         !!(db.models.Order),
      reviewModel:        !!(db.models.Review),
      wishlistModel:      !!(db.models.Wishlist),
      couponModel:        !!(db.models.Coupon),
      refundModel:        !!(db.models.Refund),
      sellerProfileModel: !!(db.models.SellerProfile),
      auditLogModel:      !!(db.models.AuditLog),
      payoutModel:        !!(db.models.Payout),
      operational: !!(db.models.Tool && db.models.Order && db.models.Review),
    };
  }
};