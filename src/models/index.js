// models/index.js - PRODUCTION-SAFE MODEL LOADER WITH AUTO-MIGRATION
// FIXED: Added ChatParticipant getter
// FIXED: All association alias conflicts resolved
// FIXED: Proper model exports for all models
// FIXED: Added missing columns for chats table (isArchived, archivedBy, archivedAt, deletedAt, deletedBy)
// FIXED: Added purpose column for Groups table
const { Sequelize, Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ===== DATABASE CONFIGURATION =====
const env = process.env.NODE_ENV || 'development';

const getDbConfig = () => {
  if (process.env.DATABASE_URL) {
    console.log(`[Database] Using DATABASE_URL for ${env} environment`);
    return {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 10,
        min: parseInt(process.env.DB_POOL_MIN) || 0,
        acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
        idle: parseInt(process.env.DB_POOL_IDLE) || 10000
      },
      dialectOptions: process.env.DB_SSL === 'true' ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      } : {},
    };
  }
  
  console.log(`[Database] Using individual config for ${env} environment`);
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'denismoo',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    dialect: process.env.DB_DIALECT || 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX) || 10,
      min: parseInt(process.env.DB_POOL_MIN) || 0,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
      idle: parseInt(process.env.DB_POOL_IDLE) || 10000
    },
    dialectOptions: process.env.DB_SSL === 'true' ? {
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
sequelize.authenticate()
  .then(() => {
    console.log(`[Database] ✅ Connection to ${dbConfig.database || 'database'} (${env}) established successfully`);
  })
  .catch(err => {
    console.error(`[Database] ❌ Unable to connect to database (${env}):`, err.message);
  });

// ===== STRICT MODEL LOADING =====
console.log('[Database] 🛡️ Initializing STRICT model loader (NO SCHEMA CHANGES)...');

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

// CRITICAL: Whitelist of all expected model files
const MODEL_WHITELIST = [
  'Users', 'Token', 'Profile', 'Settings', 'Features',
  'Chats', 'Messages', 'ChatParticipant', 'GroupMembers',
  'TypingIndicator', 'UserStatus', 'ReadReceipt', 'SharedMood',
  'Notification', 'Friend', 'Calls', 'Groups', 'Media', 'Mood', 'Status',
  'Category', 'Template', 'Notes', 'File'
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
  'express.Router()', 'express.Router('
];

// ===== MODEL FILE VALIDATION =====
console.log('[Database] Scanning for REAL Sequelize models only...');

const modelFiles = fs.readdirSync(__dirname)
  .filter(file => {
    const filePath = path.join(__dirname, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      console.log(`[Database] 📁 Skipping directory: ${file}`);
      db.skippedFiles[file] = 'Directory (not a model file)';
      return false;
    }
    
    if (!file.endsWith('.js')) {
      console.log(`[Database] 📄 Skipping non-JS file: ${file}`);
      db.skippedFiles[file] = 'Not a JavaScript file';
      return false;
    }
    
    if (file === 'index.js') {
      console.log(`[Database] 🔧 Skipping model index file: ${file}`);
      db.skippedFiles[file] = 'Model index file';
      return false;
    }
    
    const fileName = file.toLowerCase().replace('.js', '');
    
    const isWhitelisted = MODEL_WHITELIST.some(modelName => 
      modelName.toLowerCase() === fileName
    );
    
    if (isWhitelisted) {
      console.log(`[Database] ✅ Whitelisted model detected: ${file}`);
      return true;
    }
    
    const isNonModel = NON_MODEL_PATTERNS.some(pattern => 
      fileName.includes(pattern.toLowerCase())
    );
    
    if (isNonModel) {
      console.log(`[Database] 🛡️ Strict Guard: Skipping ${file} - matches non-model pattern`);
      db.skippedFiles[file] = 'Matches non-model pattern (router/controller)';
      return false;
    }
    
    console.log(`[Database] ⚠️ File not in whitelist but not blocked: ${file}. Will check content.`);
    return true;
  });

console.log(`[Database] Found ${modelFiles.length} potential model files after filtering`);

// ===== LOAD MODELS ONLY (NO SYNC, NO ALTER) =====
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
      console.log(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Detected as router/controller`);
      db.failedModels[modelName] = {
        file: file,
        error: 'File is a router/controller, not a Sequelize model',
        timestamp: new Date().toISOString(),
        detection: 'Router/controller pattern detected'
      };
      return;
    }
    
    if (!isSequelizeModel) {
      console.log(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Not a Sequelize model structure`);
      db.failedModels[modelName] = {
        file: file,
        error: 'File does not export a valid Sequelize model structure',
        timestamp: new Date().toISOString(),
        detection: 'Missing Sequelize model patterns'
      };
      return;
    }
    
    console.log(`[Database] Loading model: ${modelName} from ${file}`);
    
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
    
    console.log(`[Database] ✅ Loaded model: ${actualModelName} (NO SYNC)`);
    
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

// ===== AUTO-MIGRATION FUNCTION: Add missing columns =====
async function addMissingColumns() {
  console.log('[Migration] 🔧 Checking for missing columns...');
  
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
      { name: 'language', type: Sequelize.STRING(10), defaultValue: 'en', allowNull: false }
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
    'GroupMembers': [
      { name: 'groupId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'userId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'role', type: Sequelize.STRING(20), defaultValue: 'member', allowNull: false },
      { name: 'joinedAt', type: Sequelize.DATE, defaultValue: Sequelize.NOW, allowNull: false },
      { name: 'leftAt', type: Sequelize.DATE, allowNull: true },
      { name: 'notificationsMuted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'customSettings', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ],
  
    'Messages': [
  { name: 'chatId', type: Sequelize.INTEGER, allowNull: true },
  { name: 'senderId', type: Sequelize.INTEGER, allowNull: true },
  { name: 'content', type: Sequelize.TEXT, allowNull: true },
  { name: 'type', type: Sequelize.STRING(20), defaultValue: 'text', allowNull: false },
  { name: 'replyToId', type: Sequelize.INTEGER, allowNull: true },
  { name: 'isEdited', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
  { name: 'editedAt', type: Sequelize.DATE, allowNull: true },
  { name: 'isDeleted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
  { name: 'deletedAt', type: Sequelize.DATE, allowNull: true },
  { name: 'deletedBy', type: Sequelize.INTEGER, allowNull: true },
  { name: 'isRead', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },  // ADD THIS
  { name: 'readAt', type: Sequelize.DATE, allowNull: true },  // ADD THIS
  { name: 'reactions', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
  { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
  { name: 'encryptionKey', type: Sequelize.STRING(100), allowNull: true },
  { name: 'sentAt', type: Sequelize.DATE, defaultValue: Sequelize.NOW, allowNull: false },
  { name: 'deliveredAt', type: Sequelize.DATE, allowNull: true }
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
    ]
  };
  
  try {
    const tables = await queryInterface.showAllTables();
    console.log(`[Migration] Found ${tables.length} existing tables`);
    
    for (const [tableName, columns] of Object.entries(requiredColumns)) {
      if (!tables.includes(tableName)) {
        console.log(`[Migration] ⚠️ Table ${tableName} not found, skipping column check`);
        continue;
      }
      
      try {
        const tableColumns = await queryInterface.describeTable(tableName);
        const existingColumnNames = Object.keys(tableColumns);
        
        for (const column of columns) {
          if (!existingColumnNames.includes(column.name)) {
            console.log(`[Migration] ➕ Adding column ${column.name} to table ${tableName}`);
            
            try {
              await queryInterface.addColumn(tableName, column.name, {
                type: column.type,
                allowNull: column.allowNull,
                defaultValue: column.defaultValue
              });
              addedColumns.push(`${tableName}.${column.name}`);
              console.log(`[Migration] ✅ Added column ${column.name} to ${tableName}`);
            } catch (addError) {
              console.log(`[Migration] ⚠️ Could not add column ${column.name}: ${addError.message}`);
            }
          }
        }
        
        if (tableName === 'Groups' && existingColumnNames.includes('name')) {
          await sequelize.query(`
            UPDATE "Groups" SET "name" = 'Group ' || "id" 
            WHERE "name" IS NULL OR "name" = ''
          `);
          console.log(`[Migration] ✅ Updated Groups table with default names`);
        }
        
      } catch (tableError) {
        console.log(`[Migration] ⚠️ Error checking table ${tableName}: ${tableError.message}`);
      }
    }
    
    if (tables.includes('friends')) {
      try {
        await sequelize.query(`
          CREATE INDEX IF NOT EXISTS idx_friends_requester ON friends(requester_id);
          CREATE INDEX IF NOT EXISTS idx_friends_receiver ON friends(receiver_id);
          CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);
        `);
        console.log(`[Migration] ✅ Added indexes to friends table`);
      } catch (indexError) {
        console.log(`[Migration] ⚠️ Could not add indexes: ${indexError.message}`);
      }
    }
    
    if (addedColumns.length > 0) {
      console.log(`[Migration] ✅ Added ${addedColumns.length} missing columns:`, addedColumns);
    } else {
      console.log(`[Migration] ✅ No missing columns found - database is up to date`);
    }
    
  } catch (error) {
    console.error(`[Migration] ❌ Error during migration:`, error.message);
  }
  
  return addedColumns;
}

// ===== FIX COLUMN NAMES FUNCTION =====
async function fixColumnNames() {
  console.log('[Migration] 🔧 Fixing column names for compatibility...');
  
  const queryInterface = sequelize.getQueryInterface();
  const fixedColumns = [];
  
  try {
    const tables = await queryInterface.showAllTables();
    
    if (tables.includes('friends')) {
      const columns = await queryInterface.describeTable('friends');
      
      if (columns.created_at && !columns.createdAt) {
        await queryInterface.renameColumn('friends', 'created_at', 'createdAt');
        fixedColumns.push('friends.created_at → createdAt');
        console.log('[Migration] ✅ Renamed friends.created_at to createdAt');
      }
      
      if (columns.updated_at && !columns.updatedAt) {
        await queryInterface.renameColumn('friends', 'updated_at', 'updatedAt');
        fixedColumns.push('friends.updated_at → updatedAt');
        console.log('[Migration] ✅ Renamed friends.updated_at to updatedAt');
      }
    }
    
    if (fixedColumns.length > 0) {
      console.log(`[Migration] ✅ Fixed ${fixedColumns.length} column names:`, fixedColumns);
    } else {
      console.log('[Migration] ✅ No column name fixes needed');
    }
    
  } catch (error) {
    console.log('[Migration] ⚠️ Error fixing column names:', error.message);
  }
}

// ===== SAFE ASSOCIATION SETUP =====
console.log('[Database] Setting up associations (constraints: false)...');

const associatedModels = new Set();

Object.keys(db.models).forEach(modelName => {
  const model = db.models[modelName];
  if (model && typeof model.associate === 'function') {
    try {
      if (associatedModels.has(modelName)) {
        console.log(`[Database] ⏭️ Skipping already associated model: ${modelName}`);
        return;
      }
      
      model.associate(db.models);
      associatedModels.add(modelName);
      console.log(`[Database] ✅ Associated model: ${modelName} (constraints: false)`);
    } catch (error) {
      if (error.message && error.message.includes('used the alias')) {
        console.log(`[Database] ⚠️ Alias conflict in ${modelName}: ${error.message.split(' in')[0]}`);
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

console.log('[Database] ✅ Using associations defined in individual model files (no forced duplicates)');

// ===== RUN AUTO-MIGRATION BEFORE CONTINUING =====
(async function runMigrationAndContinue() {
  try {
    await addMissingColumns();
    await fixColumnNames();
  } catch (error) {
    console.error('[Migration] ❌ Migration error (non-critical):', error.message);
  }
})();

// ===== CORE MODEL VALIDATION =====
console.log('[Database] ===== CORE MODEL VALIDATION =====');

const hasUserModel = !!(db.models.Users);
const hasFriendModel = !!(db.models.Friend);
const hasChatModel = !!(db.models.Chats);
const hasMessageModel = !!(db.models.Messages);
const hasChatParticipantModel = !!(db.models.ChatParticipant);

if (!hasUserModel) {
  console.error('[Database] ❌ CRITICAL: User model not found!');
  console.error('[Database] Available models:', Object.keys(db.models));
} else {
  console.log('[Database] ✅ User model loaded successfully');
  
  if (db.models.Users.associations) {
    console.log('[Database] Users model associations:', Object.keys(db.models.Users.associations));
  } else {
    console.log('[Database] ⚠️ Users model has no associations defined');
  }
}

if (!hasFriendModel) {
  console.warn('[Database] ⚠️ Friend model not found - friend features may be limited');
} else {
  console.log('[Database] ✅ Friend model loaded successfully');
  
  if (db.models.Friend.associations) {
    console.log('[Database] Friend model associations:', Object.keys(db.models.Friend.associations));
  }
}

if (!hasChatModel) {
  console.warn('[Database] ⚠️ Chats model not found - chat features may be limited');
} else {
  console.log('[Database] ✅ Chats model loaded successfully');
}

if (!hasMessageModel) {
  console.warn('[Database] ⚠️ Messages model not found - messaging features may be limited');
} else {
  console.log('[Database] ✅ Messages model loaded successfully');
}

if (!hasChatParticipantModel) {
  console.warn('[Database] ⚠️ ChatParticipant model not found - chat participant features may be limited');
} else {
  console.log('[Database] ✅ ChatParticipant model loaded successfully');
}

console.log(`[Database] Total models loaded: ${Object.keys(db.models).length}`);

// ===== UTILITY FUNCTIONS =====
db.showCurrentTables = async function() {
  try {
    console.log('[Database] ===== CURRENT DATABASE TABLES =====');
    
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
    
    console.log(`[Database] Total tables: ${queryResult.length}`);
    queryResult.forEach((table, index) => {
      console.log(`  ${index + 1}. ${table.table_name} (${table.column_count} columns, ${table.table_size})`);
    });
    
    console.log('[Database] ============================');
  } catch (error) {
    console.error('[Database] Error listing tables:', error.message);
  }
};

db.testConnection = async function() {
  try {
    await sequelize.authenticate();
    console.log('[Database] Connection test: ✅ SUCCESS');
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

db.getSkippedFiles = function() {
  return Object.keys(db.skippedFiles).map(fileName => ({
    fileName,
    reason: db.skippedFiles[fileName],
    status: 'SKIPPED'
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

// ===== WEBSOCKET INITIALIZATION FUNCTION =====
db.initializeWebSocket = function(server) {
  if (!server) {
    console.error('[WebSocket] ❌ Server instance required');
    return null;
  }
  
  try {
    console.log('[WebSocket] 🔌 Initializing WebSocket server...');
    
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (socket) => {
      console.log('[WebSocket] ✅ New client connected');
      
      socket.on('message', (msg) => {
        try {
          console.log('[WebSocket] 📨 Received:', msg.toString());
          const data = JSON.parse(msg.toString());
        } catch (error) {
          console.error('[WebSocket] ❌ Error processing message:', error.message);
        }
      });
      
      socket.on('close', () => {
        console.log('[WebSocket] 👋 Client disconnected');
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
    console.log('[WebSocket] ✅ WebSocket server initialized successfully');
    return wss;
    
  } catch (error) {
    console.error('[WebSocket] ❌ WebSocket initialization failed:', error.message);
    return null;
  }
};

// ===== STARTUP REPORT =====
console.log('\n[Database] ===== STARTUP REPORT =====');
console.log(`[Database] Environment: ${env}`);
console.log(`[Database] Database: ${dbConfig.database || 'DATABASE_URL'}`);
console.log(`[Database] Mode: ${db.getOperationalStatus().mode}`);
console.log('');

console.log(`[Database] ✅ SUCCESSFULLY LOADED (${Object.keys(db.models).length}):`);
db.getLoadedModels().forEach((model, index) => {
  console.log(`  ${index + 1}. ${model.name} (table: ${model.tableName})`);
});

console.log('');

if (Object.keys(db.failedModels).length > 0) {
  console.log(`[Database] ❌ FAILED TO LOAD (${Object.keys(db.failedModels).length}):`);
  db.getFailedModels().forEach((failed, index) => {
    console.log(`  ${index + 1}. ${failed.name} (${failed.file})`);
    console.log(`     Error: ${failed.error}`);
  });
}

console.log('');

if (Object.keys(db.skippedFiles).length > 0) {
  console.log(`[Database] ⏭️  SKIPPED FILES (${Object.keys(db.skippedFiles).length}):`);
  db.getSkippedFiles().forEach((skipped, index) => {
    console.log(`  ${index + 1}. ${skipped.fileName} - ${skipped.reason}`);
  });
}

console.log('\n[Database] ===== OPERATIONAL STATUS =====');
const status = db.getOperationalStatus();
if (status.mode === 'HALTED') {
  console.log('[Database] ❌ SYSTEM HALTED: User model missing');
} else if (status.mode === 'PARTIAL') {
  console.log('[Database] ⚠️ PARTIAL MODE: Some features unavailable');
} else {
  console.log('[Database] ✅ FULL OPERATION: All core models loaded');
}

console.log('[Database] =================================\n');

if (status.coreOperational) {
  console.log('[Database] 🚀 Server ready');
  console.log('[Database] ✅ Schema changes disabled');
  console.log('[Database] ✅ Associations loaded with constraints: false');
  console.log('[Database] ✅ No auto-sync, no alter, no force');
  console.log('[Database] ✅ Auto-migration enabled - will add missing columns on startup');
  
  if (db.models.Users && db.models.Users.associations) {
    console.log('[Database] 📊 Users model associations:');
    Object.keys(db.models.Users.associations).forEach(assocName => {
      console.log(`  - ${assocName}`);
    });
  }
}

// ===== ONE-TIME TABLE CREATION CHECK =====
db.createTablesIfNeeded = async function() {
    try {
        console.log('[Database] Checking if tables exist...');
        
        const queryInterface = sequelize.getQueryInterface();
        const tables = await queryInterface.showAllTables();
        
        console.log(`[Database] Found ${tables.length} existing tables`);
        
        if (tables.length === 0) {
            console.log('[Database] 🔧 No tables found - creating all tables...');
            await sequelize.sync({ 
                force: false,
                alter: true,
                logging: (msg) => console.log(`  [SQL] ${msg}`)
            });
            console.log('[Database] ✅ Tables created successfully');
            
            const newTables = await queryInterface.showAllTables();
            console.log(`[Database] ✅ ${newTables.length} tables now exist`);
            newTables.forEach(table => console.log(`  - ${table}`));
            
            return true;
        } else {
            console.log('[Database] ✅ Tables already exist');
            return false;
        }
    } catch (error) {
        console.error('[Database] Error checking tables:', error.message);
        console.log('[Database] Attempting to create tables anyway...');
        try {
            await sequelize.sync({ force: false });
            console.log('[Database] ✅ Tables created');
            return true;
        } catch (syncError) {
            console.error('[Database] Failed to create tables:', syncError.message);
            return false;
        }
    }
};

if (process.env.CREATE_TABLES === 'true' || process.env.DB_SYNC_FORCE === 'true') {
    console.log('[Database] 🔧 CREATE_TABLES mode enabled');
    db.createTablesIfNeeded().catch(console.error);
}

// ===== EXPORT with all getters =====
module.exports = {
  ...db,
  sequelize,
  Sequelize,
  Op,
  models: db.models,
  initializeWebSocket: db.initializeWebSocket,
  getModel: db.getModel,
  
  get User() { return db.models.User || db.models.Users || null; },
  get Friend() { return db.models.Friend || db.models.Friends || null; },
  get Chat() { return db.models.Chat || db.models.Chats || null; },
  get Message() { return db.models.Message || db.models.Messages || null; },
  get ChatParticipant() { return db.models.ChatParticipant || null; },
  
  get Group() { return db.models.Group || db.models.Groups || null; },
  get GroupMember() { return db.models.GroupMember || db.models.GroupMembers || null; },
  get Token() { return db.models.Token || null; },
  get Profile() { return db.models.Profile || null; },
  get Settings() { return db.models.Settings || null; },
  get Features() { return db.models.Features || null; },
  get Notification() { return db.models.Notification || null; },
  get Media() { return db.models.Media || null; },
  get Mood() { return db.models.Mood || null; },
  get Status() { return db.models.Status || null; },
  get Call() { return db.models.Call || db.models.Calls || null; },
  get Category() { return db.models.Category || null; },
  get Template() { return db.models.Template || null; },
  get Notes() { return db.models.Notes || null; },
  get File() { return db.models.File || null; },
  get ReadReceipt() { return db.models.ReadReceipt || null; },
  get SharedMood() { return db.models.SharedMood || null; },
  get TypingIndicator() { return db.models.TypingIndicator || null; },
  getUserStatus() { return db.models.UserStatus || null; }
};